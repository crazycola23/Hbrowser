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
const { capabilities, resolveAdapter } = await import('../src/adapters/index.js');
const { acquireSlot, ensureAccount, hasProfile, recordFailure } = await import(
  '../src/accounts.js'
);

test.after(async () => {
  await fs.rm(process.env.GEO_BROWSER_DATA_DIR, { force: true, recursive: true });
});

test('只有百家号声明为已实现，其余平台必须留在目录里并标未实现', () => {
  const value = capabilities();
  const byCode = Object.fromEntries(value.platforms.map((item) => [item.code, item]));
  assert.equal(byCode.baijiahao.implemented, true);
  // 未接入的平台不能从列表里消失：界面要能置灰说明"尚未接入"。
  assert.equal(byCode.toutiao.implemented, false);
  assert.equal(byCode.douyin.implemented, false);
  assert.deepEqual(value.engines, ['chromium'], '子窗口依赖 CDP，只能是 Chromium');
});

test('未接入的平台被请求时给出明确分类而不是崩在浏览器里', () => {
  assert.throws(() => resolveAdapter('toutiao'), { failClass: 'platform_rejected' });
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
