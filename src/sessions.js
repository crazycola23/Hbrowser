import crypto from 'node:crypto';
import path from 'node:path';

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
export async function openSession(accountId, purpose = 'login') {
  const context = await launchContext(accountId);
  const page = context.pages()[0] ?? (await context.newPage());
  const cdp = await context.newCDPSession(page);
  const session = {
    accountId,
    cdp,
    createdAt: Date.now(),
    expiresAt: Date.now() + config.sessionTtlMinutes * 60_000,
    frame: null,
    id: randomId('sess'),
    page,
    purpose,
    status: 'starting',
    subscribers: new Set(),
  };
  sessions.set(session.id, session);

  await cdp.send('Page.enable');
  await cdp.send('DOM.enable');
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

  session.status = 'waiting_for_login';
  return session;
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
