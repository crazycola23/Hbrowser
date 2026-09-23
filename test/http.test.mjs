import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

/**
 * HTTP/WS 入口层的行为测试。
 *
 * 这一层的缺陷有个共同特征：契约写了、两端没接上，单测和类型检查都发现不了
 * （T-OPEN-33 复查 A/B/D/F 四条全在这里）。所以这里不打桩，直接起真服务、
 * 用真 HTTP 打 GEO 客户端实际会打的那些路径。
 */
process.env.GEO_BROWSER_API_KEY = 'http-test-key-0123456789abcdef';
process.env.GEO_BROWSER_DATA_DIR = await fs.mkdtemp(`${os.tmpdir()}/geo-media-http-`);
process.env.GEO_BROWSER_HOST = '127.0.0.1';
process.env.GEO_BROWSER_PORT = '0';

const { config, paths } = await import('../src/config.js');
const { loadLedger } = await import('../src/accounts.js');
const { createServer } = await import('../src/server.js');

await loadLedger();
const server = createServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/v1`;
const authed = { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' };

async function call(method, url, { body, headers = authed } = {}) {
  const response = await fetch(url, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers,
    method,
  });
  const type = response.headers.get('content-type') ?? '';
  const payload = type.includes('json') ? await response.json() : await response.arrayBuffer();
  return { payload, status: response.status };
}

test.after(async () => {
  // fetch 的 keep-alive 连接不关的话，测试进程会挂着不退。
  server.closeAllConnections?.();
  server.close();
  await fs.rm(process.env.GEO_BROWSER_DATA_DIR, { force: true, recursive: true });
});

test('/v1/contract 免鉴权可达，且平台目录与能力声明齐全', async () => {
  const { payload, status } = await call('GET', `${base}/contract`, { headers: {} });
  assert.equal(status, 200);
  // GEO 侧 geo.self-media.browser.contract-version 与此逐字比对，改这一个值要两侧同步。
  assert.equal(payload.contractVersion, 'geo-media-browser-v0.1');
  const byCode = Object.fromEntries(payload.platforms.map((item) => [item.code, item]));
  assert.deepEqual(
    Object.keys(byCode).sort(),
    ['baijiahao', 'douyin', 'netease', 'toutiao'],
    '平台目录必须四值全在，未接入的也要出现并标 false',
  );
  assert.equal(byCode.netease.implemented, false);
  for (const code of ['baijiahao', 'toutiao', 'douyin']) {
    assert.deepEqual(byCode[code].modes, ['manual_confirm'], `${code} 一期只允许人工确认`);
  }
});

test('除 contract 外一律要 Bearer，未带凭据不能读到任何账号台账', async () => {
  assert.equal((await call('GET', `${base}/accounts`, { headers: {} })).status, 401);
  assert.equal(
    (await call('GET', `${base}/accounts`, { headers: { Authorization: 'Bearer wrong' } })).status,
    401,
  );
});

test('health 的 profilePresent 报磁盘事实，不是台账里的"上次跑成功过"', async () => {
  const accountId = 'geo_sm_baijiahao_7001';
  assert.equal((await call('POST', `${base}/accounts`, { body: { accountId, platformCode: 'baijiahao' } })).status, 200);
  const cold = await call('GET', `${base}/accounts/${accountId}/health`);
  assert.equal(cold.payload.profilePresent, false, '刚登记的号没有登录态');

  // 模拟"操作员扫码成功"：profile 目录里出现了 Chromium 写的 Default。
  await fs.mkdir(path.join(paths.accountProfileDir(accountId), 'Default'), { recursive: true });
  const warm = await call('GET', `${base}/accounts/${accountId}/health`);
  assert.equal(
    warm.payload.profilePresent,
    true,
    'profile 已在磁盘上却报 false，GEO 会判"尚未登录"并挡住发布，而解锁它的作业又被挡 —— 死锁',
  );
});

test('会话控制路由都已接线（报错必须是"会话不存在"，不是"路由不存在"）', async () => {
  // 刻意不探 POST /accounts/{id}/sessions：那条会真去启动 Chromium，
  // 测试机上没装浏览器，会把整个测试进程挂在那儿（跑一次就明白了）。
  for (const [method, url, expect] of [
    ['GET', `${base}/sessions/sess_missing`, 404],
    ['GET', `${base}/sessions/sess_missing/frame`, 404],
    // 关一个不存在的会话是幂等操作，回 200 {cancelled:false}；判 404 反而会让前端重试。
    ['POST', `${base}/sessions/sess_missing/cancel`, 200],
    ['POST', `${base}/sessions/sess_missing/login-check`, 404],
  ]) {
    const { payload, status } = await call(
      method,
      url,
      method === 'GET' ? {} : { body: {} },
    );
    assert.notEqual(payload.error, 'route_not_found', `${method} ${url} 没接线`);
    assert.equal(status, expect, `${method} ${url}`);
  }
});

test('作业查询未知 id 回 404，不静默造一个"成功"', async () => {
  const { payload, status } = await call('GET', `${base}/publish/jobs/job_missing`);
  assert.equal(status, 404);
  assert.equal(payload.error, 'job_not_found');
});

test('账号注册平台与作业平台不一致时受理前就拒，且回 422 不是 500', async () => {
  // 不拦住的话会拿百家号的 profile 去头条页面里操作 —— 那是"以某人身份在另一个平台点一下"。
  // 这条断言同时保证拒绝发生在启动浏览器**之前**（否则本文件会挂住）。
  const { payload, status } = await call('POST', `${base}/publish/jobs`, {
    body: {
      accountId: 'geo_sm_baijiahao_7001',
      content: '<p>x</p>',
      jobId: 'job_mismatch_probe',
      platformCode: 'toutiao',
      title: '错配探针',
    },
  });
  assert.equal(status, 422, `实际 ${status}: ${JSON.stringify(payload)}`);
  assert.match(payload.error, /平台不一致/);
});
