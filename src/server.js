import http from 'node:http';

import { WebSocketServer } from 'ws';

import {
  accountView,
  deleteAccount,
  ensureAccount,
  hasProfile,
  listAccounts,
  loadLedger,
} from './accounts.js';
import { capabilities } from './adapters/index.js';
import { assertUsableConfig, config } from './config.js';
import { inspectJob, jobView, startJob } from './jobs.js';
import {
  bridgeFor,
  captureFrame,
  closeSession,
  dispatchInput,
  getSession,
  openSession,
  sessionByToken,
  shutdown,
  subscribe,
} from './sessions.js';

/**
 * 自媒体发布执行面的 HTTP + WebSocket 入口。
 *
 * 本服务的边界：它只接受 GEO 后端的调用，且凭据不出本机 —— 任何响应都不含 cookies、
 * storageState 或 CDP 地址。子窗口的画面与输入经 `/sessions/{id}/bridge` 中继，
 * 那条 WebSocket 才是前端能看到的唯一"浏览器"。
 */
const PROVIDER = 'geo-media-browser';
const CONTRACT_VERSION = config.contractVersion;

function unauthorized() {
  const error = new Error('unauthorized');
  error.status = 401;
  return error;
}

function notFound(message) {
  const error = new Error(message);
  error.status = 404;
  return error;
}

function badRequest(message) {
  const error = new Error(message);
  error.status = 422;
  return error;
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    // 载荷里带 base64 图片，必须有上限：否则一个请求就能把服务内存打穿。
    if (size > config.imageMaxBytes * 12 + 1_048_576) {
      throw badRequest('请求体超过上限');
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw badRequest('请求体不是合法 JSON');
  }
}

function send(response, status, body, type = 'application/json; charset=utf-8') {
  if (body === undefined || body === null) {
    response.writeHead(status).end();
    return;
  }
  const payload = type.startsWith('image/') ? body : JSON.stringify(body);
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': type,
  }).end(payload);
}

function authorized(request) {
  const header = request.headers.authorization ?? '';
  return header === `Bearer ${config.apiKey}`;
}

function baseOf(request) {
  const proto = request.headers['x-forwarded-proto'] ?? 'http';
  const host = request.headers.host ?? `127.0.0.1:${config.port}`;
  return `${proto === 'https' ? 'wss' : 'ws'}://${host}/v1`;
}

const routes = [
  {
    method: 'GET',
    path: /^\/contract$/,
    handler: () => ({
      contractVersion: CONTRACT_VERSION,
      provider: PROVIDER,
      ...capabilities(),
    }),
  },
  { method: 'GET', path: /^\/accounts$/, handler: () => ({ accounts: listAccounts() }) },
  {
    method: 'POST',
    path: /^\/accounts$/,
    handler: async (request) => {
      const body = await readJson(request);
      if (!body.accountId || !body.platformCode) throw badRequest('accountId 与 platformCode 必填');
      return ensureAccount(body.accountId, body.platformCode, body.label);
    },
  },
  {
    method: 'GET',
    path: /^\/accounts\/(?<accountId>[^/]+)\/health$/,
    handler: async (_request, params) => ({
      ...(await hasProfile(params.accountId)
        ? accountView(params.accountId)
        : { ...accountView(params.accountId), profilePresent: false }),
    }),
  },
  {
    method: 'DELETE',
    path: /^\/accounts\/(?<accountId>[^/]+)$/,
    handler: async (_request, params) => deleteAccount(params.accountId),
  },
  {
    method: 'POST',
    path: /^\/accounts\/(?<accountId>[^/]+)\/sessions$/,
    handler: async (request, params) => {
      const body = await readJson(request);
      const purpose = body.purpose === 'operate' ? 'operate' : 'login';
      const session = await openSession(params.accountId, purpose);
      const view = {
        expiresAt: new Date(session.expiresAt).toISOString(),
        purpose: session.purpose,
        sessionId: session.id,
        status: session.status,
      };
      view.bridge = bridgeFor(session, baseOf(request));
      return view;
    },
  },
  {
    method: 'GET',
    path: /^\/sessions\/(?<sessionId>[^/]+)$/,
    handler: (request, params) => {
      const session = sessionById(params.sessionId);
      return {
        // 状态查询同时回 bridge：GEO 侧把它原样透传给前端，
        // 少了这一段前端永远只能走单帧降级通道，"可操作"的承诺就落不了地。
        bridge: bridgeFor(session, baseOf(request)),
        expiresAt: session.expiresAt ? new Date(session.expiresAt).toISOString() : null,
        purpose: session.purpose,
        sessionId: session.id,
        status: session.status,
      };
    },
  },
  {
    method: 'GET',
    path: /^\/sessions\/(?<sessionId>[^/]+)\/frame$/,
    handler: async (_request, params) => {
      const buffer = await captureFrame(params.sessionId);
      if (!buffer) throw notFound('frame_unavailable');
      return { binary: buffer };
    },
  },
  {
    method: 'POST',
    path: /^\/sessions\/(?<sessionId>[^/]+)\/cancel$/,
    handler: async (_request, params) => ({ cancelled: await closeSession(params.sessionId) }),
  },
  {
    method: 'POST',
    path: /^\/publish\/jobs$/,
    handler: async (request) => {
      const body = await readJson(request);
      if (!body.jobId || !body.accountId || !body.platformCode) {
        throw badRequest('jobId / accountId / platformCode 必填');
      }
      const job = await startJob(body);
      return { jobId: job.jobId, sessionId: job.sessionId, status: job.status };
    },
  },
  {
    method: 'GET',
    path: /^\/publish\/jobs\/(?<jobId>[^/]+)$/,
    handler: async (_request, params) => {
      // 查状态即复核：用户在子窗口里点下「发布」之后，是 GEO 的轮询打这一发来发现结果的。
      // 只回内存里的旧状态会让每一条成功发布都永远停在 awaiting_manual，最后被
      // GEO 的超时收敛判成"结果未知"，而实际稿子已经发出去了。
      const job = await inspectJob(params.jobId);
      if (!job) throw notFound('job_not_found');
      return jobView(job);
    },
  },
];

function sessionById(sessionId) {
  const session = getSession(sessionId);
  if (!session) throw notFound('session_not_found');
  return session;
}

export function createServer() {
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
      if (!url.pathname.startsWith('/v1')) throw notFound('route_not_found');
      const path = url.pathname.slice(3) || '/';
      if (url.pathname !== '/v1/contract' && !authorized(request)) throw unauthorized();
      for (const route of routes) {
        if (route.method !== request.method) continue;
        const match = route.path.exec(path);
        if (!match) continue;
        const result = await route.handler(request, match.groups ?? {});
        if (result?.binary) return send(response, 200, result.binary, 'image/png');
        return send(response, 200, result ?? {});
      }
      throw notFound('route_not_found');
    } catch (error) {
      const status = error.status ?? 500;
      if (status >= 500) console.error('执行面请求失败', error);
      return send(response, status, { error: error.message ?? 'error', status });
    }
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    const match = /^\/v1\/sessions\/(?<sessionId>[^/]+)\/bridge$/.exec(url.pathname);
    if (!match) {
      socket.destroy();
      return;
    }
    // 令牌与会话一一对应：连接者只能看到并操作自己发起的那一个会话。
    const session = sessionByToken(url.searchParams.get('token'));
    if (!session || session.id !== match.groups.sessionId) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, async (client) => {
      wss.emit('connection', client, request, session);
    });
  });
  wss.on('connection', (client, _request, session) => {
    const unsubscribe = subscribe(session.id, (frame) => {
      if (client.readyState === client.OPEN) {
        client.send(
          JSON.stringify({
            data: frame?.data,
            height: frame?.deviceWidth,
            width: frame?.deviceHeight,
          }),
        );
      }
    });
    client.on('message', async (raw) => {
      try {
        const payload = JSON.parse(String(raw));
        if (payload.type === 'input') await dispatchInput(session.id, payload);
      } catch {
        // 输入帧解析失败只丢这一帧：为这个断开连接会让用户的画面突然黑掉。
      }
    });
    client.on('close', () => unsubscribe());
  });
  return server;
}

async function main() {
  assertUsableConfig();
  await loadLedger();
  const server = createServer();
  server.listen(config.port, config.host, () => {
    console.log(`geo-media-browser 已启动: http://${config.host}:${config.port}/v1`);
  });
  const stop = async () => {
    server.close();
    await shutdown();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (process.argv[1]?.endsWith('server.js')) {
  main().catch((error) => {
    console.error('geo-media-browser 启动失败', error);
    process.exit(1);
  });
}
