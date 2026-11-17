/**
 * 显示名称。只存和默认值不同的项，默认值改了以后没改过的名称跟着变。
 */

import { LABEL_GROUPS, LABEL_MAX, defaultLabels, normalizeLabels } from "../../../shared/labels.js";

export function publicLabels(config) {
  return normalizeLabels(config?.labels);
}

export function mergeLabels(current, input) {
  const base = current && typeof current === "object" ? current : {};
  const source = input && typeof input === "object" ? input : {};
  const defaults = defaultLabels();
  const stored = {};
  for (const group of LABEL_GROUPS) {
    const given =
      source[group.key] && typeof source[group.key] === "object" ? source[group.key] : {};
    for (const item of group.items) {
      const raw = given[item.key];
      if (raw != null && typeof raw !== "string")
        throw new Error(`${group.title}「${item.label}」要填文字`);
      const text = String(raw ?? "").trim();
      if (text.length > LABEL_MAX)
        throw new Error(`${group.title}「${item.label}」最多 ${LABEL_MAX} 个字`);
      if (!text || text === defaults[group.key][item.key]) continue;
      stored[group.key] = { ...stored[group.key], [item.key]: text };
    }
  }
  return { ...base, labels: stored };
}
