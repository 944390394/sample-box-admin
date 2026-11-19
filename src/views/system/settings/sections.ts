/**
 * 系统设置页分区状态的纯逻辑（#26 m-04 修复）。
 * 不依赖 Vue/DOM，可脱离浏览器单测（server/test/settings-sections.test.js）：
 * - 集成区（sec-integration）含 smtp/video/wechat 三个子表单，快照按子表单隔离，
 *   保存其中一个不再把整区快照刷新、吞掉其余子表单的未保存改动（静默丢改）；
 * - scrollspy 的分区在 settings 异步加载后才渲染，observe 需要按分区列表增量补挂。
 */

/** 集成区里的子表单。键名与 snapOf 的 case 一致。 */
export const INTEGRATION_PARTS = ["smtp", "video", "wechat"] as const;
export type IntegrationPart = (typeof INTEGRATION_PARTS)[number];
export const integrationKey = (part: IntegrationPart): string => `sec-integration:${part}`;

/** 全量快照要覆盖的键：集成区拆成子表单键，其余分区一个键。 */
export function snapshotKeys(sectionIds: string[]): string[] {
  return sectionIds.flatMap((id) =>
    id === "sec-integration" ? INTEGRATION_PARTS.map((part) => integrationKey(part)) : [id]
  );
}

/** 集成区里快照与已保存不一致的子表单（「保存全部」只保存这些）。 */
export function dirtyIntegrationParts(
  snapOf: (key: string) => string,
  saved: Record<string, string>
): IntegrationPart[] {
  return INTEGRATION_PARTS.filter((part) => {
    const key = integrationKey(part);
    return snapOf(key) !== saved[key];
  });
}

/** 分区脏判定：branding 由子组件 emit；集成区任一子表单脏即整区脏；其余整区快照比对。 */
export function sectionIsDirty(
  id: string,
  snapOf: (key: string) => string,
  saved: Record<string, string>,
  brandingDirty: boolean
): boolean {
  if (id === "sec-branding") return brandingDirty;
  if (id === "sec-integration") return dirtyIntegrationParts(snapOf, saved).length > 0;
  return snapOf(id) !== saved[id];
}

/**
 * scrollspy 增量补挂：分区列表变化后把新出现的分区 observe 上、消失的 unobserve 掉。
 * 元素被重建（v-if 重新挂载）时换绑新元素；已 observe 的同一元素不重复挂。
 * observed 由调用方持有（Map<分区id, 元素>），spy/elementOf 注入以便单测。
 */
export function syncSectionSpy<T>(
  spy: { observe: (el: T) => void; unobserve: (el: T) => void },
  observed: Map<string, T>,
  sectionIds: string[],
  elementOf: (id: string) => T | null
): void {
  const wanted = new Set(sectionIds);
  for (const [id, el] of [...observed]) {
    if (!wanted.has(id)) {
      spy.unobserve(el);
      observed.delete(id);
    }
  }
  for (const id of sectionIds) {
    const el = elementOf(id);
    const prev = observed.get(id);
    if (prev === el) continue;
    if (prev) spy.unobserve(prev);
    if (el) {
      spy.observe(el);
      observed.set(id, el);
    } else {
      observed.delete(id);
    }
  }
}
