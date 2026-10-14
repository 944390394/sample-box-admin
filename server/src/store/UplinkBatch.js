import { compressRaw } from "./rawCodec.js";
import { rawStorage } from "./schema.js";

/**
 * 上报原文先攒在内存里，几十条或每隔几百毫秒合并成一次插入。
 * 箱子当前行仍然逐条更新，不和这批原文绑在同一个提交里。
 */
export class UplinkBatch {
  constructor(executor, options = {}) {
    this.executor = executor;
    this.size = options.size ?? 80;
    this.waitMs = options.waitMs ?? 200;
    this.fixedMode = options.mode || "";
    this.queue = [];
    this.timer = null;
    this.chain = Promise.resolve();
    this.mode = "";
  }

  add(record) {
    this.queue.push(record);
    if (this.queue.length >= this.size) return this.flush();
    this.#arm();
    return Promise.resolve();
  }

  flush() {
    this.#clearTimer();
    const rows = this.queue.splice(0, this.queue.length);
    if (!rows.length) return this.chain;
    const run = this.chain.then(() => this.#insert(rows));
    this.chain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  async #insert(rows) {
    const mode = await this.#mode();
    const columns = [
      "box_id",
      "imei",
      "received_at",
      "device_time",
      "kind",
      "summary",
      ...(mode === "raw_gz" ? ["raw", "raw_gz"] : ["raw"]),
      "lbs_lng",
      "lbs_lat",
      "gps_lng",
      "gps_lat",
    ];
    const marks = `(${columns.map(() => "?").join(", ")})`;
    const params = [];
    for (const record of rows) {
      const compressed = compressRaw(record.raw);
      params.push(
        record.boxId,
        record.imei,
        record.receivedAt,
        record.deviceTime,
        record.kind,
        record.summary
      );
      if (mode === "raw_gz") params.push("", compressed);
      else params.push(compressed);
      params.push(record.lbsLng, record.lbsLat, record.gpsLng, record.gpsLat);
    }
    try {
      await this.executor.run(
        `INSERT INTO sample_uplink (${columns.join(", ")}) VALUES ${rows.map(() => marks).join(", ")}`,
        params
      );
    } catch (error) {
      console.error(
        `上报批量写入失败 ${rows.length} 条`,
        error instanceof Error ? error.message : "未知错误"
      );
      throw error;
    }
  }

  async #mode() {
    if (this.fixedMode) return this.fixedMode;
    if (!this.mode) this.mode = await rawStorage(this.executor);
    return this.mode;
  }

  #arm() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush().catch(() => undefined);
    }, this.waitMs);
    this.timer.unref?.();
  }

  #clearTimer() {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
  }
}
