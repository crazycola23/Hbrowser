import fs from 'node:fs/promises';
import path from 'node:path';

import { config, paths } from './config.js';

/**
 * 账号登记与账号级安全台账。
 *
 * 一个账号 = 一个持久 Chromium profile 目录。登录态就活在这个目录里，
 * 这是本服务与采集侧 OneGl 最大的形态差异（那边是一次性 profile + storageState 注入）：
 * 发布要的是"这个浏览器一直是以某人身份登录着的"，不是"每次注入凭证伪装一次会话"。
 *
 * 因此 profile 目录本身就是敏感数据。它不进 HTTP 响应、不进日志，
 * 运维口径（备份、加密、回收）见 README 的「凭据与磁盘」一节。
 */
const LEDGER_FILE = path.join(config.dataDir, 'ledger.json');

const ledger = {
  /** accountId -> { failures, lastRunAt, cooldownUntil, daily:{date:count}, hourly:{hour:count} } */
  accounts: new Map(),
  loaded: false,
};

function keyForDay(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function keyForHour(date = new Date()) {
  return date.toISOString().slice(0, 13);
}

function entry(accountId) {
  let value = ledger.accounts.get(accountId);
  if (!value) {
    value = { cooldownUntil: 0, daily: {}, failures: 0, hourly: {}, lastRunAt: 0 };
    ledger.accounts.set(accountId, value);
  }
  return value;
}

export async function loadLedger() {
  try {
    const raw = await fs.readFile(LEDGER_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    ledger.accounts = new Map(Object.entries(parsed.accounts ?? {}));
  } catch {
    ledger.accounts = new Map();
  }
  ledger.loaded = true;
}

async function persistLedger() {
  const payload = JSON.stringify(
    { accounts: Object.fromEntries(ledger.accounts) },
    null,
    2,
  );
  const temp = `${LEDGER_FILE}.tmp`;
  await fs.mkdir(config.dataDir, { mode: 0o700, recursive: true });
  await fs.writeFile(temp, payload, { mode: 0o600 });
  // 原子替换：进程在写台账时被杀掉不能留下半截 JSON，否则下次启动直接读不出来。
  await fs.rename(temp, LEDGER_FILE);
}

/** 登记账号（幂等）：只建 profile 目录与台账条目，不产生任何登录态。 */
export async function ensureAccount(accountId, platformCode, label) {
  const dir = paths.accountProfileDir(accountId);
  await fs.mkdir(dir, { mode: 0o700, recursive: true });
  const value = entry(accountId);
  value.label = label ?? value.label;
  value.platformCode = platformCode ?? value.platformCode;
  await persistLedger();
  return {
    accountId,
    created: true,
    platformCode: value.platformCode ?? null,
    profilePresent: await hasProfile(accountId),
    status: 'unknown',
  };
}

export async function hasProfile(accountId) {
  try {
    const dir = paths.accountProfileDir(accountId);
    const entries = await fs.readdir(dir);
    // Chromium 会写 Default/Cookies；有这个文件才谈得上"已登录"。
    return entries.some((name) => name === 'Default' || name === 'Local State');
  } catch {
    return false;
  }
}

/** 软删：停派发 + 删 profile（登录态），保留台账行以便对账。 */
export async function deleteAccount(accountId) {
  const value = entry(accountId);
  value.deletedAt = Date.now();
  value.reclaimSafe = true;
  try {
    await fs.rm(paths.accountProfileDir(accountId), { force: true, recursive: true });
  } catch (error) {
    value.reclaimSafe = false;
    value.reclaimError = error?.message ?? String(error);
  }
  await persistLedger();
  return { accountId, reclaimed: value.reclaimSafe };
}

/**
 * 台账视图。刻意**不返回 profilePresent**：那是磁盘事实，只能由 hasProfile() 探；
 * 从 lastKnownGood 派生等于把"上次作业跑成功过"说成"profile 在不在"，
 * 而 GEO 正是拿这个字段判"尚未登录"并把发布挡掉的。
 */
export function accountView(accountId) {
  const value = entry(accountId);
  const now = Date.now();
  const daily = value.daily?.[keyForDay()] ?? 0;
  const hourly = value.hourly?.[keyForHour()] ?? 0;
  let status = 'unknown';
  if ((value.cooldownUntil ?? 0) > now) status = 'cooldown';
  else if (value.verificationRequired) status = 'verification_required';
  else if (daily >= config.safety.dailyLimit || hourly >= config.safety.hourlyLimit) {
    status = 'throttled';
  } else if (value.loginRequired) {
    status = 'login_required';
  } else if (value.lastKnownGood) {
    status = 'healthy';
  }
  return {
    accountId,
    cooldownUntil: value.cooldownUntil ? new Date(value.cooldownUntil).toISOString() : null,
    dailyLimitUsed: daily,
    label: value.label ?? null,
    platformCode: value.platformCode ?? null,
    status,
  };
}

/**
 * 执行前闸门：限流 / 冷却 / 当日额度不满足时直接拒，不等页面报错。
 *
 * 宁可拒绝一次发布，也不要顶着风控连点 —— 账号被平台限制后损失的是用户自己的资产。
 */
export async function acquireSlot(accountId) {
  const value = entry(accountId);
  const now = Date.now();
  if ((value.cooldownUntil ?? 0) > now) {
    return { allowed: false, reason: 'cooldown', retryAt: new Date(value.cooldownUntil).toISOString() };
  }
  const gap = now - (value.lastRunAt ?? 0);
  if (gap < config.safety.minRunGapMs) {
    return { allowed: false, reason: 'run_gap', retryAt: new Date(value.lastRunAt + config.safety.minRunGapMs).toISOString() };
  }
  if ((value.daily?.[keyForDay()] ?? 0) >= config.safety.dailyLimit) {
    return { allowed: false, reason: 'daily_limit', retryAt: null };
  }
  if ((value.hourly?.[keyForHour()] ?? 0) >= config.safety.hourlyLimit) {
    return { allowed: false, reason: 'hourly_limit', retryAt: null };
  }
  value.lastRunAt = now;
  value.daily = { ...value.daily, [keyForDay()]: (value.daily?.[keyForDay()] ?? 0) + 1 };
  value.hourly = { ...value.hourly, [keyForHour()]: (value.hourly?.[keyForHour()] ?? 0) + 1 };
  await persistLedger();
  return { allowed: true };
}

export function releaseSlot(accountId) {
  // 本轮占用已在 acquire 时记账，这里只负责把"成功"信号落进台账。
  const value = entry(accountId);
  value.failures = 0;
  value.lastKnownGood = Date.now();
}

/** 失败分类进台账：需要人工的两态一律 fail-closed 到冷却，不做自动重试。 */
export async function recordFailure(accountId, failClass) {
  const value = entry(accountId);
  value.failures = (value.failures ?? 0) + 1;
  value.lastError = failClass ?? 'unknown';
  if (failClass === 'verification_required') {
    value.verificationRequired = true;
    value.cooldownUntil = Date.now() + config.safety.cooldownMinutesAfterFailures * 60_000;
  } else if (failClass === 'auth_expired') {
    value.loginRequired = true;
    value.lastKnownGood = 0;
  } else if (value.failures >= config.safety.failureThreshold) {
    value.cooldownUntil = Date.now() + config.safety.cooldownMinutesAfterFailures * 60_000;
    value.failures = 0;
  }
  await persistLedger();
}

export function markLoginObserved(accountId) {
  const value = entry(accountId);
  value.loginRequired = false;
  value.verificationRequired = false;
  value.lastKnownGood = Date.now();
}

export async function listAccounts() {
  return [...ledger.accounts.keys()].map((accountId) => accountView(accountId));
}

export { persistLedger };
