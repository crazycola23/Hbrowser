import crypto from 'node:crypto';
import path from 'node:path';

import { accountView, markLoginObserved } from './accounts.js';
import { resolveAdapter } from './adapters/index.js';
import { config, paths } from './config.js';

/**
 * 账号会话：每个账号一个常驻持久 Chromium profile。
 *
 * 三条硬约束（T-OPEN-33 §3）：
 * 1. **账号内串行**：同一账号同时只能有一个浏览器在用，两个任务共用一个 profile
 *    会表现为随机性的登录态损坏，比失败更难查。
 * 2. **单实例持有**：profile 目录在本机磁盘上，多副本部署时同一个账号必须固定到同一个实例
 *    （前置 P-4 未解决前本服务只能单实例跑）。
 * 3. **CDP 端点不外露**：画面与输入只经本模块的中继走，调用方永远拿不到远端调试地址。
 */
const sessions = new Map();
const contexts = new Map();
const chains = new Map();

/** 登录态轮询间隔。太短会在平台页面上制造额外请求，太长则用户扫完码要干等。 */
const LOGIN_POLL_MS = 2_500;

function randomId(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
}

/** 账号内串行：把任务挂在同一账号的 promise 链上。 */
export function serialize(accountId, task) {
  const previous = chains.get(accountId) ?? Promise.resolve();
  const next = previous.then(task, task);
  chains.set(
    accountId,
    next.catch(() => {}),
  );
  return next;
}

async function launchContext(accountId) {
  const existing = contexts.get(accountId);
  if (existing) return existing;
  // 动态导入：没装 playwright 依赖时本模块仍可加载与测试（能力探测、合同、限速都不依赖它）。
  const { chromium } = await import('playwright-core');
  const userDataDir = paths.accountProfileDir(accountId);
  const context = await chromium.launchPersistentContext(userDataDir, {
    args: [
      '--disable-blink-features=AutomationControlled',
      // 首启横幅会盖住编辑器，且不同平台文案不同，逐个处理不现实。
      '--disable-infobars',
      '--no-first-run',
      '--no-default-browser-check',
    ],
    headless: false,
    // 容器内以 root 跑时只能关沙箱，见 config.chromiumSandbox。
    chromiumSandbox: config.chromiumSandbox,
    // 中文 IME 与平台编辑器的排版都依赖标准字体环境；容器里缺字体会让画面出现豆腐块。
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    viewport: {
      height: config.screencast.height,
      width: config.screencast.width,
    },
  });
  contexts.set(accountId, context);
  context.on('close', () => {
    contexts.delete(accountId);
    for (const [id, session] of [...sessions.entries()]) {
      if (session.accountId === accountId) sessions.delete(id);
    }
  });
  return context;
}

/**
 * 打开一次会话：拿到 persistent context 里的一个页面 + 一条 CDP 通道。
 *
 * `headless: false` 是刻意的：内容平台对无头浏览器的风控明显更严，
 * 而本服务的设计前提是"部署在有显示环境的服务器/容器里"（Xvfb 即可）。
 */
export async function openSession(accountId, purpose = 'login', ttlMinutes) {
  const context = await launchContext(accountId);
  const page = context.pages()[0] ?? (await context.newPage());
  const cdp = await context.newCDPSession(page);
  // 请求方给了 ttl 就用它（GEO 的会话行按同一时长算过期），没给才用服务默认值。
  const minutes = Number.isInteger(ttlMinutes) && ttlMinutes > 0 ? ttlMinutes : config.sessionTtlMinutes;
  const session = {
    accountId,
    cdp,
    createdAt: Date.now(),
    expiresAt: Date.now() + minutes * 60_000,
    frame: null,
    id: randomId('sess'),
    loginWatcher: null,
    page,
    purpose,
    status: 'starting',
    subscribers: new Set(),
    ttlMinutes: minutes,
  };
  sessions.set(session.id, session);

  await cdp.send('Page.enable');
  await cdp.send('DOM.enable');
  await cdp.send('Network.enable').catch(() => {});
  cdp.on('Page.screencastFrame', async (event) => {
    session.frame = event.metadata;
    for (const listener of session.subscribers) {
      listener(event);
    }
    // 必须逐帧 ACK，否则 CDP 会在攒满缓冲后停止推送画面。
    await cdp
      .send('Page.screencastFrameAck', { sessionId: event.sessionId })
      .catch(() => {});
  });
  await cdp
    .send('Page.startScreencast', {
      everyNthFrame: config.screencast.everyNthFrame,
      format: config.screencast.format,
      maxWidth: config.screencast.width,
      maxHeight: config.screencast.height,
      quality: config.screencast.quality,
    })
    .catch(() => {
      // 起不了画面中继不算会话失败：调用方仍可退回单帧截图。
    });

  // 人工操作会话不是"等人扫码"，别报成 waiting_for_login：GEO 的终态表里
  // waiting_for_login 不是终态，报错了会让前端一直转。
  session.status = purpose === 'login' ? 'waiting_for_login' : 'open';
  if (purpose === 'login') startLoginWatcher(session);
  return session;
}

/**
 * 登录态轮询：只看 cookie，不导航。
 *
 * 绝不在这里调 adapter.isLoggedIn() —— 那个方法会 goto 作者后台，
 * 用户正在扫码时把页面跳走等于把二维码从他眼前撤掉。
 * cookie 名未实测（前置 P-2），判不出来的兜底是人工确认入口 confirmLogin()。
 */
function startLoginWatcher(session) {
  let adapter;
  try {
    adapter = resolveAdapter(accountView(session.accountId).platformCode);
  } catch {
    return;
  }
  if (!adapter?.loginCookies?.length) return;

  const timer = setInterval(() => {
    void probe();
  }, LOGIN_POLL_MS);
  timer.unref?.();
  session.loginWatcher = timer;

  async function probe() {
    if (!sessions.has(session.id)) {
      clearInterval(timer);
      session.loginWatcher = null;
      return;
    }
    try {
      const { cookies = [] } = await session.cdp.send('Network.getCookies', {
        urls: [adapter.homeUrl],
      });
      const present = new Set(cookies.map((cookie) => cookie.name));
      if (!adapter.loginCookies.some((name) => present.has(name))) return;
      markLoginObserved(session.accountId);
      settleConnected(session);
    } catch {
      // 探测失败保持原状态：宁可让操作员多按一次"我已完成登录"，也不要误判已登录。
    }
  }
}

function settleConnected(session) {
  session.status = 'connected';
  if (session.loginWatcher) {
    clearInterval(session.loginWatcher);
    session.loginWatcher = null;
  }
}

/**
 * 人工确认登录已完成：这是自动判定的兜底，也是唯一会导航的登录判定。
 *
 * 判"已登录"的代价是下一次作业白跑一趟（那时会按 auth_expired 回写并挡住派发），
 * 判"未登录"的代价只是用户再扫一次码 —— 两边都不至于发错东西出去。
 */
export async function confirmLogin(sessionId) {
  const session = getSession(sessionId);
  if (!session) {
    const error = new Error('session_not_found');
    error.status = 404;
    throw error;
  }
  const adapter = resolveAdapter(accountView(session.accountId).platformCode);
  const loggedIn = await adapter.isLoggedIn(session.page);
  if (loggedIn) {
    markLoginObserved(session.accountId);
    settleConnected(session);
  }
  // 判"还没登录"时**不停轮询**：操作员往往就在下一步才扫完，撤掉监视等于让他再点一次。
  return sessionView(session);
}

export function getSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return null;
  if (session.expiresAt && session.expiresAt < Date.now()) {
    void closeSession(sessionId);
    return null;
  }
  return session;
}

export function subscribe(sessionId, listener) {
  const session = getSession(sessionId);
  if (!session) return () => {};
  session.subscribers.add(listener);
  return () => session.subscribers.delete(listener);
}

/** 单帧截图：降级通道与首帧来源。 */
export async function captureFrame(sessionId) {
  const session = getSession(sessionId);
  if (!session) return null;
  const buffer = await session.page.screenshot({ type: 'png' });
  return buffer;
}

/**
 * 输入回注。
 *
 * 中文必须走 `Input.insertText`：合成 keydown 只会打出一串拼音字母，
 * 这是远程输入最容易踩空的一处。
 */
export async function dispatchInput(sessionId, payload) {
  const session = getSession(sessionId);
  if (!session) return false;
  if (payload.kind === 'insertText') {
    await session.cdp.send('Input.insertText', { text: String(payload.text ?? '') });
    return true;
  }
  if (payload.kind === 'mouse') {
    await session.cdp.send('Input.dispatchMouseEvent', {
      button: payload.button ?? 'left',
      clickCount: payload.clickCount ?? 1,
      type: payload.action,
      x: Number(payload.x) || 0,
      y: Number(payload.y) || 0,
      deltaX: Number(payload.deltaX) || 0,
      deltaY: Number(payload.deltaY) || 0,
      modifiers: Number(payload.modifiers) || 0,
    });
    return true;
  }
  if (payload.kind === 'key') {
    await session.cdp.send('Input.dispatchKeyEvent', {
      code: payload.code ?? '',
      key: payload.key ?? '',
      type: payload.action,
      text: payload.action === 'keyDown' ? (payload.text ?? payload.key ?? '') : undefined,
    });
    return true;
  }
  return false;
}

export async function closeSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return false;
  sessions.delete(sessionId);
  // 轮询必须跟着会话走：留着它会对一个已关的 CDP 通道不断发请求。
  if (session.loginWatcher) clearInterval(session.loginWatcher);
  await session.cdp
    .send('Page.stopScreencast')
    .catch(() => {});
  // 只关会话，不关 context：profile 与登录态要长期留着，这正是本服务存在的理由。
  await session.page.close().catch(() => {});
  return true;
}

export async function shutdown() {
  for (const sessionId of [...sessions.keys()]) {
    await closeSession(sessionId);
  }
  for (const context of contexts.values()) {
    await context.close().catch(() => {});
  }
  contexts.clear();
}

export function sessionView(session) {
  return {
    expiresAt: session.expiresAt ? new Date(session.expiresAt).toISOString() : null,
    purpose: session.purpose,
    sessionId: session.id,
    status: session.status,
  };
}

export function bridgeFor(session, base) {
  // 中继令牌与会话一一对应、短时效：拿到它不等于能连任意会话。
  return {
    engine: config.engine,
    expiresIn: config.sessionTtlMinutes * 60,
    token: session.token,
    viewport: `${config.screencast.width}x${config.screencast.height}`,
    wsUrl: `${base}/sessions/${session.id}/bridge`,
  };
}

/** 按中继令牌反查会话；令牌不匹配一律视为无会话，不区分"不存在"与"没权限"。 */
export function sessionByToken(token) {
  if (!token) return null;
  for (const session of sessions.values()) {
    if (session.token === token) return getSession(session.id);
  }
  return null;
}
