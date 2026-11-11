import type { BoxLogItem } from "@/api/sample/box";
import { toDate } from "@/utils/time";

/** 上报类型筛选。事件 = 开箱、关箱、上电、充电（插上、拔掉）；充电中和已充满来回跳的是「充电状态」，不算事件。 */
export const KIND_FILTERS = [
  { value: "", label: "全部类型" },
  { value: "boot,pad,shut,chg", label: "只看事件" },
  { value: "pad", label: "开箱" },
  { value: "shut", label: "关箱" },
  { value: "boot", label: "上电" },
  { value: "chg", label: "充电" },
  { value: "chgs", label: "充电状态" },
  { value: "timer", label: "定时上报" },
  { value: "unknown", label: "其他" },
];

export interface UplinkFacts {
  seq: number | null;
  volts: number | null;
  lid: string;
  /** 摘要里除 seq、电压、箱盖之外的部分。 */
  rest: string[];
  /** 设备时钟和服务器收到时间差几秒；差不到 60 秒不提。 */
  clockDriftSec: number | null;
  source: "GPS" | "基站" | "";
}

/** 摘要形如「定时上报 · seq 709 · 4.15 V · 开着」，拆成结构化字段。 */
export function uplinkFacts(item: BoxLogItem): UplinkFacts {
  const parts = String(item.text || "")
    .split(" · ")
    .slice(1);
  let seq: number | null = null;
  let volts: number | null = null;
  let lid = "";
  const rest: string[] = [];
  for (const part of parts) {
    const seqMatch = part.match(/^seq (\d+)$/);
    const voltMatch = part.match(/^([\d.]+) V$/);
    if (seqMatch) seq = Number(seqMatch[1]);
    else if (voltMatch) volts = Number(voltMatch[1]);
    else if (/^(开着|关着|开盖|关盖)$/.test(part)) lid = part;
    else rest.push(part);
  }
  const device = toDate(item.deviceTime);
  const received = toDate(item.time);
  const drift =
    device && received ? Math.round((device.getTime() - received.getTime()) / 1000) : null;
  const source = item.gpsLng != null ? "GPS" : item.lbsLng != null ? "基站" : "";
  return {
    seq,
    volts,
    lid,
    rest,
    clockDriftSec: drift != null && Math.abs(drift) >= 60 ? drift : null,
    source,
  };
}

export function formatRaw(raw: string) {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

/** 时间线里的一行：单条上报，或连续的一串定时上报。 */
export type UplinkRow =
  | { type: "one"; key: string; item: BoxLogItem; facts: UplinkFacts }
  | {
      type: "run";
      key: string;
      items: { item: BoxLogItem; facts: UplinkFacts }[];
      from: string;
      to: string;
      volts: [number, number] | null;
      lid: string;
      boxId: string;
      charges: number;
    };

/** 例行上报：定时上报，以及插着充电器时充电中、已充满来回跳的充电状态。 */
export function isRoutine(kind?: string | null) {
  return kind === "timer" || kind === "chgs";
}

/**
 * 连续 3 条以上的例行上报折成一行（同一台箱子、中间没有事件）。列表是按时间倒序的。
 */
export function groupRuns(list: BoxLogItem[]): UplinkRow[] {
  const rows: UplinkRow[] = [];
  let run: { item: BoxLogItem; facts: UplinkFacts }[] = [];
  const flush = () => {
    if (run.length >= 3) {
      const volts = run.map((r) => r.facts.volts).filter((v): v is number => v != null);
      const lids = new Set(run.map((r) => r.facts.lid).filter(Boolean));
      rows.push({
        type: "run",
        key: `run-${run[0].item.id || run[0].item.time}`,
        items: run,
        from: run[run.length - 1].item.time,
        to: run[0].item.time,
        volts: volts.length ? [Math.min(...volts), Math.max(...volts)] : null,
        lid: lids.size === 1 ? [...lids][0] : lids.size ? "开关变化" : "",
        boxId: run[0].item.box,
        charges: run.filter((r) => r.item.kind === "chgs").length,
      });
    } else {
      for (const entry of run)
        rows.push({ type: "one", key: `one-${entry.item.id || entry.item.time}`, ...entry });
    }
    run = [];
  };
  for (const item of list) {
    const facts = uplinkFacts(item);
    const routine = isRoutine(item.kind);
    if (routine && (!run.length || run[0].item.box === item.box)) {
      run.push({ item, facts });
      continue;
    }
    flush();
    if (routine) run.push({ item, facts });
    else rows.push({ type: "one", key: `one-${item.id || item.time}`, item, facts });
  }
  flush();
  return rows;
}
