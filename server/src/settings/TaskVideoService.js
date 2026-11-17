import { randomUUID } from "node:crypto";
import { formatTimestamp } from "../domain/Clock.js";
import { boxPosition, distanceM, hasCoords } from "../geo/place.js";
import { radiusOf } from "./taskPlaces.js";

/** 采样任务在这几个状态下，箱子到了采样单位开箱就要录像。 */
const RECORDING = ["待采样", "采样中", "已封箱"];

/**
 * 开箱录像：采样任务勾了「需要录像」、采样单位是采样机构时，
 * 箱子在采样单位（计划地点到达半径内）每开一次箱，记一条录像请求，再异步请视频平台录像。
 * 计划地点没有坐标时，只在「采样中」算。
 */
export class TaskVideoService {
  constructor(db, platform, { now = () => new Date() } = {}) {
    this.db = db;
    this.platform = platform;
    this.now = now;
  }

  /** 收到开箱上报时调用。返回新记录的编号，不录像返回 null。不等平台回应。 */
  async onOpen(box, uplink) {
    if (uplink?.why !== "pad" || !box) return null;
    const task = await this.db.get(
      `SELECT t.id, t.status, t.body FROM sample_task t JOIN sample_task_box m ON m.task_id = t.id
       WHERE m.box_id = ? AND t.kind = '采样' AND t.status IN (${RECORDING.map(() => "?").join(",")})
       ORDER BY t.created_at DESC LIMIT 1`,
      [box.id, ...RECORDING]
    );
    if (!task) return null;
    let body;
    try {
      body = JSON.parse(task.body);
    } catch {
      return null;
    }
    if (!body.recordVideo) return null;
    const place = body.placeAt;
    const position = boxPosition(box);
    const distance = hasCoords(place) && position ? distanceM(position, place) : null;
    const atPlace = hasCoords(place)
      ? distance != null && distance <= radiusOf(place)
      : task.status === "采样中";
    if (!atPlace) return null;
    const id = randomUUID();
    const now = formatTimestamp(this.now());
    const openedAt = uplink.deviceTime || now;
    await this.db.run(
      `INSERT INTO sample_task_video (id, task_id, box_id, opened_at, distance_m, status, detail, url, attempts, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, '待请求', '', '', 0, ?, ?)`,
      [id, task.id, box.id, openedAt, distance, now, now]
    );
    // 平台慢或不通都不能拖住上报处理
    setImmediate(() =>
      this.request(id).catch((error) => console.error("录像请求失败", error?.message || error))
    );
    return id;
  }

  /** 向平台发请求并记下结果。重试也走这里。 */
  async request(id) {
    const row = await this.db.get("SELECT * FROM sample_task_video WHERE id = ?", [id]);
    if (!row) return null;
    const task = await this.db.get("SELECT id, name, body FROM sample_task WHERE id = ?", [
      row.task_id,
    ]);
    const box = await this.db.get("SELECT id, name, imei FROM sample_box WHERE id = ?", [
      row.box_id,
    ]);
    let body = {};
    try {
      body = JSON.parse(task?.body || "{}");
    } catch {
      /* 正文坏了也照样请求 */
    }
    const result = await this.platform.requestRecording({
      requestId: row.id,
      taskId: row.task_id,
      taskName: task?.name || "",
      boxId: row.box_id,
      boxName: box?.name || "",
      imei: box?.imei || row.box_id,
      orgId: body.orgId || "",
      org: body.org || "",
      openedAt: row.opened_at,
      place: body.placeAt
        ? { address: body.placeAt.address, lng: body.placeAt.lng, lat: body.placeAt.lat }
        : null,
      distanceM: row.distance_m,
    });
    await this.db.run(
      "UPDATE sample_task_video SET status = ?, detail = ?, url = ?, attempts = attempts + 1, updated_at = ? WHERE id = ?",
      [
        result.status,
        String(result.detail || "").slice(0, 500),
        String(result.url || ""),
        formatTimestamp(this.now()),
        id,
      ]
    );
    return result;
  }

  async list(taskId) {
    const rows = await this.db.all(
      "SELECT * FROM sample_task_video WHERE task_id = ? ORDER BY opened_at, created_at",
      [taskId]
    );
    return rows.map((row) => ({
      id: row.id,
      boxId: row.box_id,
      openedAt: row.opened_at,
      recordedAt: row.opened_at,
      distanceM: row.distance_m == null ? null : Number(row.distance_m),
      status: row.status,
      detail: row.detail || "",
      url: row.url || "",
      poster: row.poster || "",
      durationSec: row.duration_sec == null ? undefined : Number(row.duration_sec),
      attempts: Number(row.attempts) || 0,
      title: "",
    }));
  }

  async retry(taskId, id) {
    const row = await this.db.get("SELECT id FROM sample_task_video WHERE id = ? AND task_id = ?", [
      id,
      taskId,
    ]);
    if (!row) return null;
    return this.request(id);
  }
}
