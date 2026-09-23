import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import test from 'node:test';

// 必须在导入被测模块之前落定环境：config.js 在加载时就固化了这些值。
process.env.GEO_BROWSER_API_KEY = 'test-key-0123456789abcdef';
process.env.GEO_BROWSER_DATA_DIR = await fs.mkdtemp(
  `${os.tmpdir()}/geo-media-browser-test-`,
);
process.env.GEO_BROWSER_MIN_RUN_GAP_MS = '0';
process.env.GEO_BROWSER_DAILY_LIMIT = '2';

const { assertUsableConfig, config, paths } = await import('../src/config.js');
const { capabilities, PLATFORM_CODES, resolveAdapter } = await import('../src/adapters/index.js');
const { acquireSlot, ensureAccount, hasProfile, recordFailure } = await import(
  '../src/accounts.js'
);
const { serialize } = await import('../src/sessions.js');

test.after(async () => {
  await fs.rm(process.env.GEO_BROWSER_DATA_DIR, { force: true, recursive: true });
});

test('已接入三个平台，未接入的仍留在目录里并标未实现', () => {
  const value = capabilities();
  const byCode = Object.fromEntries(value.platforms.map((item) => [item.code, item]));
  for (const code of ['baijiahao', 'toutiao', 'douyin']) {
    assert.equal(byCode[code].implemented, true, `${code} 应已接入`);
  }
  // 未接入的平台不能从列表里消失：界面要能置灰说明"尚未接入"。
  assert.equal(byCode.netease.implemented, false);
  assert.deepEqual(value.engines, ['chromium'], '子窗口依赖 CDP，只能是 Chromium');
  // 抖音图文没有长正文容器；这个差异只能由能力声明表达，业务侧不许按平台码分支。
  assert.equal(byCode.douyin.supportsLongBody, false);
  assert.equal(byCode.baijiahao.supportsLongBody, true);
});

test('每个已接入适配器都要齐六个动作与一张入口表', async () => {
  const adapterModule = {
    baijiahao: await import('../src/adapters/baijiahao.js'),
    toutiao: await import('../src/adapters/toutiao.js'),
    douyin: await import('../src/adapters/douyin.js'),
  };
  for (const code of PLATFORM_CODES) {
    const adapter = adapterModule[code]?.[`${code}Adapter`];
    if (!adapter?.implemented) continue;
    for (const method of [
      'fillArticle',
      'inspectResult',
      'isLoggedIn',
      'openEditor',
      'openHome',
      'openLogin',
    ]) {
      assert.equal(typeof adapter[method], 'function', `${code} 缺 ${method}`);
    }
    // 登录/首页/发文三个入口缺一个都会表现成"子窗口打不开"，而画面上看不出原因；
    // 且必须是 https —— 平台登录页走 http 会被降级成明文口令提交。
    const entry = adapterModule[code].ENTRY;
    for (const key of ['home', 'login', 'publish']) {
      assert.match(String(entry?.[key] ?? ''), /^https:\/\//, `${code} 缺 ENTRY.${key} 或不是 https`);
    }
    assert.equal(adapter.modes.length > 0, true, `${code} 必须声明支持模式`);
  }
});

test('未接入的平台被请求时给出明确分类而不是崩在浏览器里', () => {
  assert.throws(() => resolveAdapter('netease'), { failClass: 'platform_rejected' });
  assert.throws(() => resolveAdapter('unknown_platform'), { failClass: 'platform_rejected' });
});

test('账号登记与 profile 探测', async () => {
  const created = await ensureAccount('geo_sm_baijiahao_1', 'baijiahao', '百家号 A');
  assert.equal(created.accountId, 'geo_sm_baijiahao_1');
  assert.equal(created.platformCode, 'baijiahao');
  // 刚登记的账号没有登录态：profilePresent 必须为 false，不能让 GEO 以为可以发了。
  assert.equal(created.profilePresent, false);
  assert.equal(await hasProfile('geo_sm_baijiahao_1'), false);
});

test('账号标识里的路径分隔符不会逃出 profile 根目录', async () => {
  const { default: path } = await import('node:path');
  const profilesRoot = path.join(config.dataDir, config.profileDirName);
  const escaped = paths.accountProfileDir('../../etc/passwd');
  // 真正的性质是"解析后仍在 profiles 根目录内"，而不是字符串里有没有 etc。
  assert.ok(
    path.resolve(escaped).startsWith(path.resolve(profilesRoot)),
    `profile 目录被路径穿越: ${escaped}`,
  );
  assert.notEqual(path.resolve(escaped), path.resolve(config.dataDir));
});

test('同一账号在额度内连续可用，超上限后必须被挡住', async () => {
  await ensureAccount('geo_sm_baijiahao_2', 'baijiahao', '百家号 B');
  assert.equal((await acquireSlot('geo_sm_baijiahao_2')).allowed, true);
  assert.equal((await acquireSlot('geo_sm_baijiahao_2')).allowed, true);
  const third = await acquireSlot('geo_sm_baijiahao_2');
  assert.equal(third.allowed, false);
  assert.equal(third.reason, 'daily_limit', `当日额度上限是 ${config.safety.dailyLimit}`);
});

test('未登记的账号也要能被限速判定（不抛错）', async () => {
  const gate = await acquireSlot('geo_sm_baijiahao_never_seen');
  assert.equal(gate.allowed, true);
});

test('需要人工验证的失败会 fail-closed 到冷却', async () => {
  await ensureAccount('geo_sm_baijiahao_4', 'baijiahao', '百家号 D');
  await recordFailure('geo_sm_baijiahao_4', 'verification_required');
  const gate = await acquireSlot('geo_sm_baijiahao_4');
  assert.equal(gate.allowed, false);
  assert.equal(gate.reason, 'cooldown', '遇到验证码/风控必须停下等人，不能自动再试');
});

test('没有凭据时服务拒绝启动', () => {
  const original = config.apiKey;
  config.apiKey = '';
  assert.throws(() => assertUsableConfig(), /GEO_BROWSER_API_KEY/);
  config.apiKey = original;
});

// ↓ 单账号隔离。这三条钉的是"一个号出事不能牵连别的号"（需求 §十），
//   全部按可观察行为判，不看实现里有没有写"隔离"两个字。
test('同平台两个账号各自一份 profile 目录', async () => {
  await ensureAccount('geo_sm_toutiao_11', 'toutiao', '头条 A');
  await ensureAccount('geo_sm_toutiao_12', 'toutiao', '头条 B');
  const dirA = paths.accountProfileDir('geo_sm_toutiao_11');
  const dirB = paths.accountProfileDir('geo_sm_toutiao_12');
  assert.notEqual(dirA, dirB, '同平台两个号必须落在不同 profile 目录，否则登录态互相覆盖');
  assert.ok(dirA.includes('toutiao'), '外部标识内嵌平台码与行 id');
});

test('冷却只封出事的那个号，不封同平台的兄弟号', async () => {
  await ensureAccount('geo_sm_douyin_21', 'douyin', '抖音 A');
  await ensureAccount('geo_sm_douyin_22', 'douyin', '抖音 B');
  await recordFailure('geo_sm_douyin_21', 'verification_required');
  assert.equal((await acquireSlot('geo_sm_douyin_21')).reason, 'cooldown');
  assert.equal((await acquireSlot('geo_sm_douyin_22')).allowed, true, '兄弟号不该被连带熔断');
});

test('同一账号串行排队，不同账号不互相等待', async () => {
  const order = [];
  const step = (name, ms) =>
    new Promise((resolve) => {
      setTimeout(() => {
        order.push(name);
        resolve();
      }, ms);
    });
  // a1 慢、a2 快但同账号必须等它；b1 是另一个账号，只等自己前面的 5ms。
  await Promise.all([
    serialize('acct-a', () => step('a1', 30)),
    serialize('acct-a', () => step('a2', 1)),
    serialize('acct-b', () => step('b1', 5)),
  ]);
  assert.deepEqual(order, ['b1', 'a1', 'a2'], '账号内串行、账号间并行的隔离被破坏');
});
