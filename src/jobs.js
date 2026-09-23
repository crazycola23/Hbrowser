import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { markLoginObserved, recordFailure } from './accounts.js';
import { resolveAdapter } from './adapters/index.js';
import { config } from './config.js';
import { closeSession, openSession, serialize, sessionView } from './sessions.js';

/**
 * 发布作业编排。
 *
 * 一期只做"填好后停在发布页"（mode = manual_confirm）：本模块**没有任何一条路径
 * 会代替用户点下平台上的「发布」**。需求 §六 与 N-10 都卡在这件事上。
 *
 * 状态词表（GEO 侧 GeoSelfMediaJobOutcome 逐字对应）：
 *   publishing | awaiting_manual | verification_required | succeeded | failed | unknown
 */
const jobs = new Map();

function newJob(request) {
  const job = {
    accountId: request.accountId,
    createdAt: Date.now(),
    filled: null,
    jobId: request.jobId,
    platformCode: request.platformCode,
    resultUrl: null,
    sessionId: null,
    status: 'publishing',
    updatedAt: Date.now(),
  };
  jobs.set(job.jobId, job);
  return job;
}

function touch(job, patch) {
  Object.assign(job, patch);
  job.updatedAt = Date.now();
  return job;
}

/**
 * 配图落成本地文件。setInputFiles 只吃本地路径，且平台编辑器不接受 data: URL。
 *
 * GEO 侧给的是 OSS 可访问地址（`url`），也允许直接给 `base64`。两种都要能落盘；
 * 而**声明了配图却一张都没拿到**必须显式失败 —— 静默跳过会发出"没有插图的稿子"，
 * 只有用户在平台上打开文章才会发现，那已经是发布之后了。
 */
async function stageImages(images) {
  const staged = [];
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'geo-media-img-'));
  for (const [index, image] of (images ?? []).entries()) {
    const name = (image?.name ?? `image_${index}`).replace(/[^\w.-]/g, '_');
    const file = path.join(dir, `${index}_${name}`);
    let bytes;
    if (image?.base64) {
      bytes = Buffer.from(image.base64, 'base64');
    } else if (image?.url) {
      bytes = await download(image.url);
    }
    if (!bytes || bytes.byteLength === 0) continue;
    if (bytes.byteLength > config.imageMaxBytes) {
      // 超限不截断：半张图会让文章看起来像坏了，而这只有用户能发现。
      const error = new Error(`配图超过上限: ${bytes.byteLength} > ${config.imageMaxBytes}`);
      error.failClass = 'upload_failed';
      throw error;
    }
    await fs.writeFile(file, bytes, { mode: 0o600 });
    staged.push({ ...image, tempPath: file });
  }
  if ((images ?? []).length > 0 && staged.length === 0) {
    const error = new Error(`声明了 ${images.length} 张配图，但一张都没取到`);
    error.failClass = 'upload_failed';
    throw error;
  }
  return { dir, staged };
}

/** 只接受 http(s)：这里是把外网响应写进服务器磁盘的唯一入口，必须先看声明长度再收全量。 */
async function download(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) return null;
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > config.imageMaxBytes) {
    const error = new Error(`配图声明长度超过上限: ${declared} > ${config.imageMaxBytes}`);
    error.failClass = 'upload_failed';
    throw error;
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > config.imageMaxBytes) {
    // 长度头可以造假，落盘前再按实际字节数判一次。
    const error = new Error(`配图实际长度超过上限: ${buffer.byteLength}`);
    error.failClass = 'upload_failed';
    throw error;
  }
  return buffer;
}

export async function startJob(request) {
  const adapter = resolveAdapter(request.platformCode);
  if (!adapter.modes.includes(request.mode ?? 'manual_confirm')) {
    const error = new Error(`该平台不支持 ${request.mode} 模式`);
    error.failClass = 'platform_rejected';
    throw error;
  }
  const job = newJob(request);
  // 账号内串行：同一 profile 同时只能被一个任务用。
  void serialize(job.accountId, () => runJob(job, request, adapter)).catch((error) => {
    touch(job, { failClass: error.failClass ?? 'page_changed', failReason: error.message, status: 'failed' });
  });
  return job;
}

async function runJob(job, request, adapter) {
  const session = await openSession(job.accountId, 'operate');
  touch(job, { sessionId: session.id });
  let staged = null;
  try {
    await adapter.openEditor(session.page);
    const url = session.page.url();
    if (/login|passport|sso/i.test(url)) {
      // 没登录就到此为止：把会话留给用户扫码，不判失败也不自动重试。
      touch(job, { status: 'verification_required' });
      markLoginObserved(job.accountId);
      return job;
    }
    if (!(await adapter.isLoggedIn(session.page))) {
      touch(job, { failClass: 'auth_expired', status: 'failed' });
      await recordFailure(job.accountId, 'auth_expired');
      return job;
    }
    staged = await stageImages(request.images);
    const filled = await adapter.fillArticle(session.page, {
      contentHtml: request.content,
      images: staged.staged,
      title: request.title,
    });
    touch(job, { filled, status: 'awaiting_manual' });
    markLoginObserved(job.accountId);
    return job;
  } catch (error) {
    const failClass = error.failClass ?? 'page_changed';
    touch(job, { failClass, failReason: error.message ?? String(error), status: 'failed' });
    await recordFailure(job.accountId, failClass);
    // 失败即释放页面：profile 与登录态留在原地，下次任务还能用。
    await closeSession(session.id).catch(() => {});
    return job;
  } finally {
    if (staged?.dir) await fs.rm(staged.dir, { force: true, recursive: true }).catch(() => {});
  }
}

export function getJob(jobId) {
  return jobs.get(jobId) ?? null;
}

export function jobView(job, base) {
  if (!job) return null;
  return {
    failClass: job.failClass ?? null,
    failReason: job.failReason ?? null,
    filled: job.filled,
    jobId: job.jobId,
    resultUrl: job.resultUrl,
    sessionId: job.sessionId,
    status: job.status,
    updatedAt: new Date(job.updatedAt).toISOString(),
  };
}

/**
 * 复核平台侧结果。
 *
 * 只认确定证据；拿不到就返回 unknown，由 GEO 侧按"结果未知"落库并且不给重试入口。
 * 本模块绝不"看着像成功就判成功"——重复发布出去的稿子收不回来。
 */
export async function inspectJob(jobId, adapterCode) {
  const job = jobs.get(jobId);
  if (!job) return null;
  if (job.status !== 'awaiting_manual' && job.status !== 'verification_required') return job;
  try {
    const { getSession } = await import('./sessions.js');
    const live = getSession(job.sessionId);
    if (!live) return touch(job, { failClass: 'timeout_unknown', status: 'unknown' });
    const adapter = resolveAdapter(adapterCode ?? job.platformCode);
    const result = await adapter.inspectResult(live.page);
    if (result.status === 'succeeded') {
      return touch(job, { resultUrl: result.resultUrl, status: 'succeeded' });
    }
    return touch(job, { status: 'unknown' });
  } catch (error) {
    return touch(job, { failClass: error.failClass ?? 'page_changed', status: 'unknown' });
  }
}

export function listJobIds() {
  return [...jobs.keys()];
}

export { sessionView };
