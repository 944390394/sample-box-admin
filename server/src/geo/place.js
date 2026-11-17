/**
 * 单位地址、任务地址和箱子位置之间的换算。
 * 地址可以只有文字没有坐标（手填的收发室、楼层），这时无法计算距离。
 */

function coord(value, limit) {
  if (value == null || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number) || Math.abs(number) > limit) throw new Error("坐标格式不正确");
  return number;
}

function text(value, max, label) {
  if (value == null) return "";
  if (typeof value !== "string" || value.length > max) throw new Error(`${label}格式不正确`);
  return value.trim();
}

/** 经纬度要么都有要么都没有；0,0 当作没有。 */
export function readCoords(input) {
  const lng = coord(input?.lng, 180);
  const lat = coord(input?.lat, 90);
  if (lng == null || lat == null || (lng === 0 && lat === 0)) return { lng: null, lat: null };
  return { lng, lat };
}

/** 部门表单里的位置字段。 */
export function readDeptLocation(input) {
  return {
    address: text(input?.address, 255, "地址"),
    ...readCoords(input),
    contact: text(input?.contact, 64, "联系人"),
    phone: text(input?.phone, 32, "电话"),
  };
}

/**
 * 任务里的地址快照。orgId 记录它来自哪个单位；custom 为真表示用户改过，不是单位地址原样。
 * 没有地址文字也没有坐标时返回 null。
 */
export function readPlace(input) {
  if (input == null) return null;
  if (typeof input !== "object" || Array.isArray(input)) throw new Error("地址格式不正确");
  const place = {
    address: text(input.address, 255, "地址"),
    ...readCoords(input),
    orgId: input.orgId == null || input.orgId === "" ? "" : String(input.orgId).slice(0, 32),
    custom: Boolean(input.custom),
  };
  // 这个地址的到达判定范围（误差范围），米；不填用系统设置
  if (input.radiusM != null && input.radiusM !== "") {
    const radius = Number(input.radiusM);
    if (!Number.isInteger(radius) || radius < 50 || radius > 50000)
      throw new Error("误差范围要在 50 到 50000 米之间");
    place.radiusM = radius;
  }
  if (!place.address && place.lng == null) return null;
  return place;
}

export function hasCoords(place) {
  return place != null && Number.isFinite(place.lng) && Number.isFinite(place.lat);
}

/** 球面距离，米。 */
export function distanceM(a, b) {
  if (!hasCoords(a) || !hasCoords(b)) return null;
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(h))));
}

/** 基站位置比 GPS 新这么多以上时，认为 GPS 已经过时（箱子可能在室内收不到卫星，或者已经走了）。 */
export const GPS_STALE_MS = 10 * 60 * 1000;

/**
 * 箱子当前位置：有 GPS 用 GPS；但基站位置比最后一次 GPS 定位新 10 分钟以上时用基站，
 * 免得几天前的 GPS 被当成现在的位置拿去判断到达。都没有返回 null。
 * row 可以是数据库行（gps_info、lbs_at）也可以是 BoxState（gpsInfo、lbsAt）。
 * 返回的 at 是这个位置的时间，gpsAt 是最后一次 GPS 定位时间（用了基站时才有）。
 */
export function boxPosition(row) {
  const gps = safeCoords(row?.gps_lng ?? row?.gpsLng, row?.gps_lat ?? row?.gpsLat);
  const lbs = safeCoords(row?.lbs_lng ?? row?.lbsLng, row?.lbs_lat ?? row?.lbsLat);
  const gpsAt = gpsTimeOf(row);
  const lbsAt = String(row?.lbs_at ?? row?.lbsAt ?? "");
  if (gps && lbs && gpsAt && lbsAt && timeOf(lbsAt) - timeOf(gpsAt) > GPS_STALE_MS)
    return { ...lbs, source: "基站", at: lbsAt, gpsAt };
  if (gps) return { ...gps, source: "GPS", at: gpsAt };
  if (lbs) return { ...lbs, source: "基站", at: lbsAt };
  return null;
}

function gpsTimeOf(row) {
  let info = row?.gpsInfo ?? row?.gps_info ?? null;
  if (typeof info === "string") {
    try {
      info = JSON.parse(info);
    } catch {
      info = null;
    }
  }
  return String(info?.at || "");
}

/** 「2026-11-02 19:25:28」按本地时间算毫秒；认不出来给 NaN，比较时当作不知道。 */
function timeOf(text) {
  return Date.parse(String(text).replace(" ", "T"));
}

function safeCoords(lng, lat) {
  try {
    const value = readCoords({ lng, lat });
    return value.lng == null ? null : value;
  } catch {
    return null;
  }
}

/**
 * 单位的有效位置：自己没设就往上找最近设过的上级。
 * rows 是 sys_dept 的原始行，返回 { address, lng, lat, contact, phone, fromId, fromName, inherited } 或 null。
 */
export function effectiveDeptLocation(rows, id) {
  const byId = new Map(rows.map((row) => [String(row.id), row]));
  let cursor = byId.get(String(id));
  const seen = new Set();
  while (cursor && !seen.has(String(cursor.id))) {
    seen.add(String(cursor.id));
    const coords = safeCoords(cursor.lng, cursor.lat);
    if (cursor.address || coords) {
      return {
        address: cursor.address || "",
        lng: coords?.lng ?? null,
        lat: coords?.lat ?? null,
        contact: cursor.contact || "",
        phone: cursor.phone || "",
        fromId: String(cursor.id),
        fromName: cursor.name,
        inherited: String(cursor.id) !== String(id),
      };
    }
    cursor = byId.get(String(cursor.parent_id));
  }
  return null;
}
