import type { PermGroup, PermItem } from "@/api/system/role";

/**
 * 权限前置关系（目录里的 needs：列出的任意一项有了，这一项才用得上）。
 * 授权界面上：勾一项时自动补上前置；取消一项时，依赖它、又没有别的前置可用的项一起取消。
 * 只动「能改」的项，不能改的保持原样。
 */
export interface PermIndex {
  byCode: Map<string, PermItem>;
  /** 每个码：哪些项把它列为前置 */
  dependents: Map<string, PermItem[]>;
  /** 目录里的全部项，按显示顺序 */
  items: PermItem[];
}

export function buildIndex(groups: PermGroup[]): PermIndex {
  const items = groups.flatMap((group) => group.items);
  const byCode = new Map(items.map((item) => [item.code, item]));
  const dependents = new Map<string, PermItem[]>();
  for (const item of items) {
    for (const need of item.needs || []) {
      if (!dependents.has(need)) dependents.set(need, []);
      dependents.get(need)!.push(item);
    }
  }
  return { byCode, dependents, items };
}

export type CanChange = (code: string) => boolean;

/** 这一项的前置是否已满足（没有前置也算满足）。 */
export function needsMet(item: PermItem | undefined, set: Set<string>) {
  return !item?.needs?.length || item.needs.some((code) => set.has(code));
}

/**
 * 勾上 code，前置不满足时补上第一项能改的前置（递归）。返回自动补上的码。
 * 前置一项都不能改时照样勾上，调用方提示「还要有 X 才用得上」。
 */
export function addWithNeeds(
  set: Set<string>,
  code: string,
  index: PermIndex,
  canChange: CanChange
): string[] {
  const added: string[] = [];
  const visit = (current: string, auto: boolean) => {
    if (set.has(current)) return;
    set.add(current);
    if (auto) added.push(current);
    const item = index.byCode.get(current);
    if (needsMet(item, set)) return;
    const pick = item!.needs!.find((need) => canChange(need));
    if (pick) visit(pick, true);
  };
  visit(code, false);
  return added;
}

/**
 * 取消 code 之后，哪些已勾的项会失去全部前置（递归）。不改 set。
 * locked 是其中不能改的（这时不应该取消 code）。
 */
export function brokenBy(set: Set<string>, code: string, index: PermIndex, canChange: CanChange) {
  const trial = new Set(set);
  trial.delete(code);
  const broken: string[] = [];
  const queue = [code];
  while (queue.length) {
    const current = queue.shift()!;
    for (const item of index.dependents.get(current) || []) {
      if (!trial.has(item.code) || needsMet(item, trial)) continue;
      trial.delete(item.code);
      broken.push(item.code);
      queue.push(item.code);
    }
  }
  return { broken: broken.filter(canChange), locked: broken.filter((item) => !canChange(item)) };
}

/** 取消 code 和依赖它的项。返回连带取消的码。 */
export function removeWithDependents(
  set: Set<string>,
  code: string,
  index: PermIndex,
  canChange: CanChange
): string[] {
  const { broken } = brokenBy(set, code, index, canChange);
  set.delete(code);
  for (const item of broken) set.delete(item);
  return broken;
}

/** 把已勾各项缺的前置补上（各补第一项能改的）。返回补上的码。复制角色、套模板后用。 */
export function fillNeeds(set: Set<string>, index: PermIndex, canChange: CanChange): string[] {
  const added: string[] = [];
  for (const item of index.items) {
    if (!set.has(item.code) || needsMet(item, set)) continue;
    const pick = item.needs!.find((need) => canChange(need));
    if (pick) added.push(pick, ...addWithNeeds(set, pick, index, canChange));
  }
  return added;
}

/** 已勾、但前置一项都没有的项（只用来提示）。 */
export function unmet(set: Set<string>, index: PermIndex) {
  return index.items.filter((item) => set.has(item.code) && !needsMet(item, set));
}

/** 「查看人员」「进任务单」这样的名字列表，最多列 n 个。 */
export function namesOf(codes: string[], index: PermIndex, n = 4) {
  const names = codes.map((code) => `「${index.byCode.get(code)?.label || code}」`);
  return names.length > n ? `${names.slice(0, n).join("")}，共 ${names.length} 项` : names.join("");
}
