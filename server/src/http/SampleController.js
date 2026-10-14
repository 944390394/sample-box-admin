import { resolveTimeRange } from "../log/timeRange.js";

/**
 * 采样箱查询。箱子列表只读当前状态表。
 * 上报列表不取原文，点开一条再按主键解压。
 */
export class SampleController {
  constructor(boxes) {
    this.boxes = boxes;
  }

  async list(ctx) {
    const rows = await this.boxes.list();
    ctx.ok(rows.map((box) => box.toJSON()));
  }

  async detail(ctx) {
    const box = await this.boxes.findById(ctx.params.id);
    if (!box) return ctx.fail("采样箱不存在", "A0404", 404);
    ctx.ok(box.toJSON());
  }

  /** 首页最近动态来自箱子当前状态，不扫上报流水。 */
  async recent(ctx) {
    const limit = Math.min(100, Math.max(1, Number(ctx.query.limit) || 50));
    const rows = await this.boxes.list();
    const feed = rows
      .filter((box) => box.last)
      .slice(0, limit)
      .map((box) => ({
        box: box.id,
        time: box.last,
        text: "最近上报",
        by: "设备",
        kind: "",
        lbsLng: box.lbsLng,
        lbsLat: box.lbsLat,
        gpsLng: box.gpsLng,
        gpsLat: box.gpsLat,
      }));
    ctx.ok(feed);
  }

  async logs(ctx) {
    const box = await this.boxes.findById(ctx.params.id);
    if (!box) return ctx.fail("采样箱不存在", "A0404", 404);
    const range = resolveTimeRange(ctx.query || {});
    if (range.error) return ctx.fail(range.error);
    const page = await this.boxes.listLogs(box.id, {
      from: range.from,
      to: range.to,
      limit: ctx.query?.limit,
      cursorTime: ctx.query?.cursorTime,
      cursorId: ctx.query?.cursorId,
    });
    const rows = Array.isArray(page) ? page : page.list;
    ctx.ok({
      list: rows.map(withoutRaw),
      nextCursor: Array.isArray(page) ? null : page.nextCursor || null,
    });
  }

  async raw(ctx) {
    if (typeof this.boxes.readRaw !== "function") return ctx.fail("上报不存在", "A0404", 404);
    const text = await this.boxes.readRaw(ctx.params.id, ctx.params.logId, ctx.query?.receivedAt);
    if (text == null) return ctx.fail("上报不存在", "A0404", 404);
    ctx.ok({ raw: text });
  }
}

function withoutRaw(row) {
  const json = typeof row.toListJSON === "function" ? row.toListJSON() : row.toJSON();
  if (!json || typeof json !== "object") return json;
  const copy = { ...json };
  delete copy.raw;
  return copy;
}
