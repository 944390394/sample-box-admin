import { defaultLabels, LABEL_GROUPS, LABEL_MAX, normalizeLabels } from "../../shared/labels.js";
import SettingsAPI from "@/api/system/settings";

/**
 * 页面显示名称统一从这里读。键是存储值（生命周期、上报 kind 等），只换显示文字，
 * 比较、筛选、接口参数一律用原值。
 */

export type LabelGroup = "life" | "kind" | "lid" | "charge" | "online" | "led" | "tile";
export type Labels = Record<LabelGroup, Record<string, string>>;

export { LABEL_GROUPS, LABEL_MAX };

const serverMode = import.meta.env.VITE_MOCK_DEV_SERVER !== "true";

export const labels = reactive(defaultLabels() as Labels);

export function defaultLabelSet() {
  return defaultLabels() as Labels;
}

export function setLabels(next: unknown) {
  Object.assign(labels, normalizeLabels(next) as Labels);
}

let loading: Promise<void> | null = null;

/** 登录后读一次，失败时继续用默认名称。 */
export function loadLabels(force = false) {
  if (!serverMode) return Promise.resolve();
  if (loading && !force) return loading;
  loading = SettingsAPI.labels()
    .then(setLabels)
    .catch(() => {
      loading = null;
    });
  return loading;
}

function pick(group: LabelGroup, key: string | null | undefined, fallback = "—") {
  if (key == null || key === "") return fallback;
  return labels[group][key] || key;
}

/** 生命周期存储值 → 显示名称。 */
export function lifeLabel(life: string | null | undefined) {
  return pick("life", life);
}

/** 上报 kind（boot/timer/pad/shut/chg）→ 短名。不认识的 kind 返回 fallback。 */
export function kindLabel(kind: string | null | undefined, fallback = "上报") {
  if (!kind || !labels.kind[kind]) return fallback;
  return labels.kind[kind];
}

export function lidLabel(lid: number | null | undefined) {
  if (lid == null) return "—";
  return lid ? labels.lid.open : labels.lid.closed;
}

export function chargeLabel(charge: number | null | undefined) {
  if (charge == null) return "—";
  if (charge === 1) return labels.charge.charging;
  if (charge === 2) return labels.charge.full;
  return labels.charge.none;
}
