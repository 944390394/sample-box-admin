/**
 * 采样箱查询。只读仓储，不在这里解析设备报文。
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

  async recent(ctx) {
    const limit = Math.min(100, Math.max(1, Number(ctx.query.limit) || 50));
    const rows = await this.boxes.listRecent(limit);
    ctx.ok(rows.map((row) => row.toJSON()));
  }

  async logs(ctx) {
    const box = await this.boxes.findById(ctx.params.id);
    if (!box) return ctx.fail("采样箱不存在", "A0404", 404);
    const rows = await this.boxes.listLogs(box.id);
    ctx.ok(rows.map((row) => row.toJSON()));
  }
}
