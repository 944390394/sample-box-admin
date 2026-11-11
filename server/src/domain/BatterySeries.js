import { gunzipSync } from "node:zlib";

import { samplePercent } from "./BatteryEstimate.js";

const VOLT = /(\d+(?:\.\d+)?)\s*V/;

export function readMillivolts(summary) {
  const match = String(summary || "").match(VOLT);
  if (!match) return null;
  const mv = Math.round(Number(match[1]) * 1000);
  if (!Number.isFinite(mv) || mv < 2500 || mv > 4500) return null;
  return mv;
}

function knownCharge(charge) {
  if (charge == null || charge === "") return null;
  const value = Number(charge);
  return value === 0 || value === 1 || value === 2 ? value : null;
}

function point(time, mv, percent, charge) {
  return { time, mv, percent: Math.round(percent), charge: knownCharge(charge) };
}

/** 一段原文：字符串直接用；字节（SQLite 的 raw 列、MySQL 的 raw_gz 列都是 gzip 字节）先解压。 */
function decodeRaw(value) {
  if (value == null || value === "") return "";
  if (typeof value === "string") return value;
  try {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
      return gunzipSync(bytes).toString("utf8");
    }
    return bytes.toString("utf8");
  } catch {
    return "";
  }
}

/**
 * 上报原文。以前 raw 列有值就直接 String()，可 SQLite 里 raw 存的是 gzip 字节，
 * 转出来是「31,139,8,…」一串数字，读不出 chg，电量曲线就一直没有充电状态。
 */
export function uplinkText(row) {
  const raw = row?.raw;
  const hasRaw = raw != null && raw !== "" && !(raw instanceof Uint8Array && raw.length === 0);
  if (hasRaw) return decodeRaw(raw);
  return decodeRaw(row?.raw_gz ?? row?.rawGz);
}

export function chargeFromRaw(raw) {
  const text = typeof raw === "string" ? raw : uplinkText({ raw_gz: raw });
  const match = text.match(/(?:^|,)chg=(\d+)/) || text.match(/"chg"\s*:\s*(\d+)/);
  if (!match) return null;
  const value = Number(match[1]);
  return value === 0 || value === 1 || value === 2 ? value : null;
}

const STAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/;
const toMs = (time) => Date.parse(String(time).slice(0, 19).replace(" ", "T"));

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * 电压上报收成曲线点：
 * - 时间用设备时间（补传的记录落在它真实发生的时间，不挤在上传那一刻），没有才用收到时间；
 * - 电量和页头同一套算法（充电状态 + 学到的循环拉伸）；
 * - 点太多时按等长时间段取中位数，避开发射瞬间被拉低的单点；
 * - 两点间隔超过 3 个上报周期（至少 10 分钟）时插一个空点，曲线在那里断开，不画没有数据的那段。
 *   断不断看原始数据，不看合并后的点（合并后相邻两点本来就隔一段长度）。
 */
export function bucketBattery(rows, maxPoints = 360, { model = null, periodSec = 60 } = {}) {
  const seeded = Boolean(rows?.startFull);
  const state = { full: seeded, eased: seeded };
  const samples = [];
  for (const row of rows) {
    const mv = row.stmMv == null ? readMillivolts(row.summary) : Number(row.stmMv);
    if (!Number.isFinite(mv) || mv < 2500 || mv > 4500) continue;
    const charge = knownCharge(row.charge == null ? chargeFromRaw(uplinkText(row)) : row.charge);
    const time = STAMP.test(String(row.device_time || ""))
      ? String(row.device_time).slice(0, 19)
      : String(row.received_at || row.time || "").slice(0, 19);
    if (!Number.isFinite(toMs(time))) continue;
    const period =
      row.periodSec >= 5 && row.periodSec <= 3600 ? row.periodSec : Number(periodSec) || 60;
    const interval = row.chargeOnly && charge === 0 ? Math.max(600, period) : period;
    samples.push({ time, ms: toMs(time), mv, charge, interval });
  }
  samples.sort((a, b) => a.ms - b.ms);
  for (const item of samples) item.percent = samplePercent(model, state, item.mv, item.charge);
  // 断开看原始数据：和前一条隔了 3 个上报周期（至少 10 分钟）以上，才是真没数据
  samples.forEach((item, index) => {
    const gapMs = Math.max(600, 3 * (samples[index - 1]?.interval ?? item.interval)) * 1000;
    item.gapBefore = index > 0 && item.ms - samples[index - 1].ms > gapMs;
  });

  let points = samples;
  if (samples.length > maxPoints) {
    const start = samples[0].ms;
    const span = Math.max(1, samples[samples.length - 1].ms - start);
    const width = span / maxPoints;
    const groups = new Map();
    for (const item of samples) {
      const key = Math.min(maxPoints - 1, Math.floor((item.ms - start) / width));
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }
    // 合并后相邻两点本来就隔一段长度（7 天切 360 段约 28 分钟），不能再按时间差断开，
    // 否则每两点之间都插空点，曲线全成了孤立的点；这一段里有过真断开才断开
    points = [...groups.values()].map((group) => {
      // Keep the timestamp, voltage, charge state and estimate from one real report.
      const state = group[group.length - 1].charge;
      const candidates = group.filter((g) => g.charge === state);
      const center = median(candidates.map((g) => g.mv));
      const middle = candidates.reduce(
        (best, g) => (Math.abs(g.mv - center) < Math.abs(best.mv - center) ? g : best),
        candidates[Math.floor(candidates.length / 2)]
      );
      return {
        time: middle.time,
        ms: middle.ms,
        mv: middle.mv,
        percent: middle.percent,
        charge: middle.charge,
        gapBefore: group.some((g) => g.gapBefore),
      };
    });
  }

  const out = [];
  points.forEach((item, index) => {
    if (index > 0 && item.gapBefore)
      out.push({ time: item.time, mv: null, percent: null, charge: null, gap: true });
    out.push(point(item.time, Math.round(item.mv), item.percent, item.charge));
  });
  return out;
}
