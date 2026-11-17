import { formatTimestamp } from "../domain/Clock.js";
import { distanceM } from "../geo/place.js";
import { currentBoxSettings } from "./boxConfig.js";
import { ENDED } from "./taskFlow.js";

/* 结束状态（taskFlow 的 ENDED）：任务窗口到这条流转记录为止。 */
/** 时间线里展示的设备事件。定时、充电上报太多，只进轨迹不进时间线。 */
const EVENT_KINDS = { pad: "开箱", shut: "关箱", boot: "上电" };
/** 每台箱子轨迹最多返回的点数，超出时均匀抽稀，首尾保留。 */
const MAX_POINTS = 400;
const MAX_ROWS = 20000;
const MAX_EVENTS = 300;
/** 失联判定至少 5 分钟，避免周期很短时一两次丢包就报。 */
const MIN_GAP_MS = 5 * 60000;

/**
 * 任务窗口：创建到结束（没结束到现在）。任务时间是 ISO，上报时间是服务器本地时间，统一成本地格式再查。
 */
export function taskWindow(createdAt, status, logs, now = new Date()) {
  const end = ENDED.includes(status)
    ? [...logs].reverse().find((log) => log.status === status)
    : null;
  return {
    from: formatTimestamp(new Date(createdAt)),
    to: formatTimestamp(end ? new Date(end.created_at) : now),
    live: !end,
  };
}

function thin(points) {
  if (points.length <= MAX_POINTS) return points;
  const step = (points.length - 1) / (MAX_POINTS - 1);
  return Array.from({ length: MAX_POINTS }, (_, i) => points[Math.round(i * step)]);
}

const ms = (text) => {
  const value = Date.parse(String(text || "").replace(" ", "T"));
  return Number.isFinite(value) ? value : null;
};

function duration(msValue) {
  const minutes = Math.round(msValue / 60000);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} 小时${minutes % 60 ? ` ${minutes % 60} 分` : ""}`;
  return `${Math.floor(hours / 24)} 天${hours % 24 ? ` ${hours % 24} 小时` : ""}`;
}

/**
 * 失联和补传：两次收到上报之间超过 3 个上报周期（至少 5 分钟）算失联一次。
 * 之后任何时候收到的、设备时间落在这段空档里的记录，都是设备离线时存下、恢复后补传的。
 * 按上报周期估一下这段时间应有多少条：补回八成以上算「信号不好，数据已补全」，补了一部分是「数据不全」，
 * 一条没有是「连接中断」（没电、关机或在屏蔽区）。
 * 一段接一段的短失联（中间只隔很短的时间）合成一条「连接不稳定」，不逐条刷屏。
 * 只在充电时才定时上报的箱子，不充电时本来就不报，不判失联。
 */
export const MERGE_GAP_MS = 30 * 60000;
export const COMPLETE_RATIO = 0.8;

/** 已排好序的数组里落在 (lo, hi) 开区间的个数。 */
function countBetween(sorted, lo, hi) {
  const first = (x) => {
    let l = 0,
      r = sorted.length;
    while (l < r) {
      const m = (l + r) >> 1;
      if (sorted[m] <= x) l = m + 1;
      else r = m;
    }
    return l;
  };
  let l = 0,
    r = sorted.length;
  while (l < r) {
    const m = (l + r) >> 1;
    if (sorted[m] < hi) l = m + 1;
    else r = m;
  }
  return Math.max(0, l - first(lo));
}

export function gapEvents(boxId, rows, policy, window, now) {
  if (policy.chargeOnly) return [];
  const periodMs = policy.periodSec * 1000;
  const limit = Math.max(periodMs * 3, MIN_GAP_MS);
  // 所有记录的设备时间，补传数在这里面按空档区间数
  const deviceTimes = rows
    .map((row) => ms(row.device_time))
    .filter((v) => v != null)
    .sort((x, y) => x - y);
  const gaps = [];
  for (let i = 1; i < rows.length; i += 1) {
    const before = ms(rows[i - 1].received_at),
      after = ms(rows[i].received_at);
    if (before == null || after == null || after - before <= limit) continue;
    const backfilled = countBetween(deviceTimes, before, after - periodMs);
    // 空档里按周期应有的条数（两头各扣一个周期）
    const expected = Math.max(0, Math.floor((after - before) / periodMs) - 1);
    const last = gaps.at(-1);
    if (last && before - last.after <= Math.max(limit, MERGE_GAP_MS)) {
      last.after = after;
      last.count += 1;
      last.longest = Math.max(last.longest, after - before);
      last.lostMs += after - before;
      last.backfilled += backfilled;
      last.expected += expected;
    } else {
      gaps.push({
        start: String(rows[i - 1].received_at),
        before,
        after,
        count: 1,
        longest: after - before,
        lostMs: after - before,
        backfilled,
        expected,
      });
    }
  }
  const events = gaps.map((g) => {
    const complete = g.backfilled > 0 && g.backfilled >= g.expected * COMPLETE_RATIO;
    const missing = Math.max(0, g.expected - g.backfilled);
    const kind = complete ? "weak" : g.backfilled ? "partial" : "gap";
    const span =
      g.count > 1
        ? `${duration(g.after - g.before)}里断了 ${g.count} 次，最长 ${duration(g.longest)}`
        : `失联 ${duration(g.lostMs)}`;
    const data = complete
      ? `恢复后补传了 ${g.backfilled} 条离线记录，数据已补全`
      : g.backfilled
        ? `恢复后只补传了 ${g.backfilled} 条，按上报周期应有约 ${g.expected} 条，缺约 ${missing} 条`
        : "这段时间没有数据（可能没电、关机或在没有信号的地方）";
    return {
      boxId,
      time: g.start,
      kind,
      label:
        g.count > 1 ? "连接不稳定" : complete ? "信号不好" : g.backfilled ? "数据不全" : "连接中断",
      text: `${span}，${data}`,
      minutes: Math.round(g.lostMs / 60000),
      backfilled: g.backfilled,
      expected: g.expected,
      count: g.count,
    };
  });
  // 任务还在进行、最后一次上报到现在也超过了，标「失联中」
  const last = rows.at(-1);
  const lastMs = last ? ms(last.received_at) : null;
  if (window.live && lastMs != null && now - lastMs > limit) {
    events.push({
      boxId,
      time: String(last.received_at),
      kind: "lost",
      label: "失联中",
      text: `已经 ${duration(now - lastMs)} 没有上报`,
      minutes: Math.round((now - lastMs) / 60000),
      backfilled: 0,
    });
  }
  return events;
}

/**
 * 进出任务地点：位置从范围外进入范围内记「到达…附近」，从范围内到范围外记「离开…」。
 * 基站定位会来回跳，连续两次落在同一侧才算换了一侧；第一次定位只定初始状态，不记事件。
 */
function placeEvents(boxId, rows, places) {
  const events = [];
  for (const place of places) {
    let inside = null;
    let pending = null;
    for (const row of rows) {
      const gps = row.gps_lng != null && row.gps_lat != null;
      const point = gps
        ? { lng: Number(row.gps_lng), lat: Number(row.gps_lat) }
        : row.lbs_lng != null && row.lbs_lat != null
          ? { lng: Number(row.lbs_lng), lat: Number(row.lbs_lat) }
          : null;
      if (!point) continue;
      const distance = distanceM(point, place);
      if (distance == null) continue;
      const now = distance <= place.radiusM;
      if (inside === null) {
        inside = now;
        continue;
      }
      if (now === inside) {
        pending = null;
        continue;
      }
      if (!pending || pending.inside !== now) {
        pending = { inside: now, row, distance, gps };
        continue;
      }
      inside = now;
      events.push({
        boxId,
        time: String(pending.row.received_at),
        kind: now ? "arrive" : "leave",
        label: now ? `到达${place.role}附近` : `离开${place.role}`,
        text: `距${place.role} ${distance < 1000 ? `${distance} 米` : `${(distance / 1000).toFixed(1)} 公里`}（${pending.gps ? "GPS" : "基站定位，误差较大"}）`,
        role: place.role,
      });
      pending = null;
    }
  }
  return events;
}

/**
 * 任务期间各箱的位置点、开关箱事件，以及推出来的事件（失联、信号不好、进出任务地点）。
 * 轨迹：GPS 点连线用，基站点误差大，单独标出；每台箱子给出 GPS 行程。
 * places：要判断进出的地点 [{ role, lng, lat, radiusM }]。
 */
export async function taskTrack(db, boxIds, window, { places = [], now = Date.now() } = {}) {
  if (!boxIds.length) return { tracks: [], events: [] };
  const rows = await db.all(
    `SELECT box_id, received_at, device_time, kind, summary, gps_lng, gps_lat, lbs_lng, lbs_lat FROM sample_uplink
     WHERE box_id IN (${boxIds.map(() => "?").join(",")}) AND received_at >= ? AND received_at <= ?
     ORDER BY received_at LIMIT ${MAX_ROWS}`,
    [...boxIds, window.from, window.to]
  );
  const policies = new Map();
  const settings = currentBoxSettings();
  try {
    const boxes = await db.all(
      `SELECT id, policy_period_sec, policy_charge_only FROM sample_box WHERE id IN (${boxIds.map(() => "?").join(",")})`,
      boxIds
    );
    for (const box of boxes) {
      policies.set(box.id, {
        periodSec: Number(box.policy_period_sec) || Number(settings.reportPeriodSec) || 60,
        chargeOnly:
          box.policy_charge_only == null
            ? Boolean(settings.reportOnlyWhenCharging)
            : Number(box.policy_charge_only) === 1,
      });
    }
  } catch {
    /* 老库没有策略列时按系统默认 */
  }
  const byBox = new Map(boxIds.map((id) => [id, { gps: [], lbs: [], rows: [] }]));
  const events = [];
  for (const row of rows) {
    const time = String(row.received_at);
    const item = byBox.get(row.box_id);
    if (!item) continue;
    item.rows.push(row);
    if (row.gps_lng != null && row.gps_lat != null)
      item.gps.push({ t: time, lng: Number(row.gps_lng), lat: Number(row.gps_lat) });
    else if (row.lbs_lng != null && row.lbs_lat != null)
      item.lbs.push({ t: time, lng: Number(row.lbs_lng), lat: Number(row.lbs_lat) });
    if (EVENT_KINDS[row.kind] && events.length < MAX_EVENTS)
      events.push({
        boxId: row.box_id,
        time,
        kind: row.kind,
        label: EVENT_KINDS[row.kind],
        text: row.summary || "",
      });
  }
  const usablePlaces = places.filter(
    (p) => p && Number.isFinite(p.lng) && Number.isFinite(p.lat) && p.radiusM > 0
  );
  const tracks = boxIds.map((id) => {
    const { gps, lbs, rows: boxRows } = byBox.get(id);
    const policy = policies.get(id) || {
      periodSec: Number(settings.reportPeriodSec) || 60,
      chargeOnly: Boolean(settings.reportOnlyWhenCharging),
    };
    events.push(
      ...gapEvents(id, boxRows, policy, window, now),
      ...placeEvents(id, boxRows, usablePlaces)
    );
    let meters = 0;
    for (let i = 1; i < gps.length; i++) meters += distanceM(gps[i - 1], gps[i]) ?? 0;
    return {
      boxId: id,
      gps: thin(gps),
      lbs: thin(lbs),
      gpsCount: gps.length,
      lbsCount: lbs.length,
      distanceM: Math.round(meters),
    };
  });
  return { tracks, events, window, truncated: rows.length >= MAX_ROWS };
}
