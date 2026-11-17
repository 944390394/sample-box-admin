/**
 * 工作台「最近动态」里的箱子事件：同一台箱子连续的同类事件合成一条，避免一台箱子反复重启（插拔 USB、烧录、
 * 模块复位）时刷满整列。上电归一类，开箱、关箱归一类（开关箱）；中间夹着这台箱子别类事件的就分开。
 *
 * rows 按时间倒序（最新在前），每行 { box_id, name, kind, received_at }。
 * 返回 { type: "box", boxId, boxName, kind, action, time（最近一次）, since（最早一次）, count, counts }。
 */
const FAMILY = { boot: "boot", pad: "lid", shut: "lid" };
const LABEL = { pad: "开箱", shut: "关箱", boot: "上电" };

function actionOf(counts) {
  const parts = Object.entries(counts).filter(([, n]) => n > 0);
  if (parts.length === 1 && parts[0][1] === 1) return LABEL[parts[0][0]];
  // 开箱 3 次、关箱 3 次 / 上电 18 次
  return ["pad", "shut", "boot"]
    .filter((kind) => counts[kind])
    .map((kind) => `${LABEL[kind]} ${counts[kind]} 次`)
    .join("、");
}

export function foldBoxEvents(rows) {
  const items = [];
  // 每台箱子当前还能往里合的那一条
  const open = new Map();
  for (const row of rows) {
    const family = FAMILY[row.kind];
    if (!family) continue;
    const last = open.get(row.box_id);
    if (last && last.family === family) {
      last.counts[row.kind] = (last.counts[row.kind] || 0) + 1;
      last.count += 1;
      last.since = row.received_at;
      continue;
    }
    const item = {
      type: "box",
      boxId: row.box_id,
      boxName: row.name || row.box_id,
      kind: row.kind,
      family,
      time: row.received_at,
      since: row.received_at,
      count: 1,
      counts: { [row.kind]: 1 },
    };
    items.push(item);
    open.set(row.box_id, item);
  }
  return items.map(({ family, ...item }) => ({
    ...item,
    kind: family === "lid" ? (item.counts.pad ? "pad" : "shut") : item.kind,
    action: actionOf(item.counts),
  }));
}
