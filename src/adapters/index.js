/**
 * 平台适配器注册表。
 *
 * 隔离要求（需求 §十）：一个平台出问题不能牵连其它平台，因此业务侧只经 capabilities
 * 问"这个平台能不能发、发到哪一步"，不允许按平台码硬分支。新增平台 = 新增一个适配器文件
 * + 在这里注册，不改状态机、不改表、不改页面。
 */
import { baijiahaoAdapter } from './baijiahao.js';

const adapters = new Map(
  [[baijiahaoAdapter.code, baijiahaoAdapter]].filter(([, adapter]) => adapter.implemented),
);

export const PLATFORM_CODES = ['baijiahao', 'toutiao', 'netease', 'douyin'];

export function capabilities() {
  return {
    engines: ['chromium'],
    // 未实现的平台仍然出现在列表里并标 implemented=false：
    // 界面要能置灰说明"尚未接入"，从目录里消失会让用户以为没有这个平台。
    platforms: PLATFORM_CODES.map((code) => {
      const adapter = adapters.get(code);
      return {
        code,
        implemented: Boolean(adapter),
        modes: adapter ? adapter.modes : [],
        supportsImageUpload: adapter ? adapter.supportsImageUpload : false,
      };
    }),
  };
}

export function resolveAdapter(code) {
  const adapter = adapters.get(code);
  if (!adapter) {
    const error = new Error(`该平台尚未接入自媒体发布: ${code}`);
    error.failClass = 'platform_rejected';
    error.code = 'unsupported_platform';
    throw error;
  }
  return adapter;
}
