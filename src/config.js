import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function integer(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : fallback;
}

/**
 * 运行配置。
 *
 * 契约版本必须与 GEO 侧 `geo.self-media.browser.contract-version` 逐字一致，
 * 否则 GEO 的适配器匹配不到本服务，任务会一直保持排队（照抄采集侧同一教训）。
 */
export const config = {
  accountParallelism: integer('GEO_BROWSER_ACCOUNT_PARALLELISM', 1),
  apiKey: process.env.GEO_BROWSER_API_KEY ?? '',
  contractVersion: 'geo-media-browser-v0.1',
  // 子窗口的实时画面依赖 CDP，只能是 Chromium。
  engine: 'chromium',
  // 两次动作之间的最小间隔。真实限速按账号计，见 safety 段。
  actionIntervalMs: integer('GEO_BROWSER_ACTION_INTERVAL_MS', 350),
  dataDir: process.env.GEO_BROWSER_DATA_DIR ?? path.join(ROOT, '.data'),
  host: process.env.GEO_BROWSER_HOST ?? '127.0.0.1',
  port: integer('GEO_BROWSER_PORT', 3310),
  profileDirName: 'profiles',
  sessionTtlMinutes: integer('GEO_BROWSER_SESSION_TTL_MINUTES', 15),
  // 中继帧参数：分辨率越低越省带宽，但平台编辑器的小按钮会点不准。
  screencast: {
    everyNthFrame: integer('GEO_BROWSER_SCREENCAST_EVERY_FRAME', 1),
    format: 'jpeg',
    quality: integer('GEO_BROWSER_SCREENCAST_QUALITY', 60),
    width: integer('GEO_BROWSER_VIEWPORT_WIDTH', 1440),
    height: integer('GEO_BROWSER_VIEWPORT_HEIGHT', 900),
  },
  safety: {
    // 默认值取自 OneGl 实测保守档（src/accounts/safety.js），不是这些平台公布的官方上限。
    // 多账号同 IP 集中发布是这些内容平台的主要风控触发因子，宁慢勿封。
    cooldownMinutesAfterFailures: integer('GEO_BROWSER_COOLDOWN_MINUTES', 60),
    dailyLimit: integer('GEO_BROWSER_DAILY_LIMIT', 20),
    failureThreshold: integer('GEO_BROWSER_FAILURE_THRESHOLD', 3),
    hourlyLimit: integer('GEO_BROWSER_HOURLY_LIMIT', 6),
    minRunGapMs: integer('GEO_BROWSER_MIN_RUN_GAP_MS', 45_000),
  },
  // 允许的图片字节上限：载荷以 base64 随作业传入，不设上限会让内存被单张原图打穿。
  imageMaxBytes: integer('GEO_BROWSER_IMAGE_MAX_BYTES', 6 * 1024 * 1024),
};

export const paths = {
  accountProfileDir(accountId) {
    // accountId 只允许 [A-Za-z0-9._-]，防止 ../ 之类的路径逃逸出 profile 根目录。
    const safe = String(accountId).replace(/[^A-Za-z0-9._-]/g, '_');
    return path.join(config.dataDir, config.profileDirName, safe);
  },
  root: ROOT,
};

export function assertUsableConfig() {
  if (!config.apiKey || config.apiKey.length < 16) {
    throw new Error(
      'GEO_BROWSER_API_KEY 未配置或过短：本服务能以任意账号身份操作真实平台页面，必须有凭据',
    );
  }
  if (config.host !== '127.0.0.1' && config.host !== 'localhost' && !config.host.startsWith('10.')) {
    // 中继端口一旦暴露到公网，等于把"以别人账号身份点击"的能力交给网络。
    console.warn(
      `[warn] 执行面监听在 ${config.host}：该端口可操作已登录的平台账号，不得暴露公网`,
    );
  }
}
