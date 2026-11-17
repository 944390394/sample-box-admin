import { defaultBoxName } from "../domain/boxName.js";
import { CommittedUplink } from "../domain/CommittedUplink.js";
import { BoxState } from "../domain/BoxState.js";
import { UplinkRecord } from "../domain/UplinkRecord.js";
import { BoxStore } from "./BoxStore.js";

/** 进程内仓储。单线程里用队列把编号分配串行化，避免并发上报拿到同一个箱号。 */
export class MemoryBoxStore extends BoxStore {
  constructor() {
    super();
    this.byImei = new Map();
    this.byId = new Map();
    this.logs = [];
    this.sequence = 1;
    this.tail = Promise.resolve();
  }

  async findByImei(imei) {
    return this.byImei.get(imei) || null;
  }

  async findById(id) {
    return this.byId.get(id) || null;
  }

  async findByName(name) {
    return [...this.byId.values()].find((box) => box.name === name) || null;
  }

  async list() {
    return [...this.byId.values()].sort((a, b) => (a.last < b.last ? 1 : -1));
  }

  async page({ life = "", q = "", page = 1, pageSize = 20 } = {}) {
    const text = String(q || "")
      .trim()
      .toLowerCase();
    const all = [...this.byId.values()];
    const counts = { 在途: 0, 未使用: 0, 停用: 0, 待激活: 0 };
    for (const box of all) {
      if (Object.prototype.hasOwnProperty.call(counts, box.life)) counts[box.life] += 1;
    }
    const rows = all
      .filter((box) => {
        if (!text) return true;
        return (
          box.id.toLowerCase().includes(text) ||
          String(box.name || "")
            .toLowerCase()
            .includes(text)
        );
      })
      .filter((box) => !life || box.life === life)
      .sort((a, b) => {
        const pending = Number(b.life === "待激活") - Number(a.life === "待激活");
        if (pending) return pending;
        const alerted = Number(Boolean(b.alert)) - Number(Boolean(a.alert));
        if (alerted) return alerted;
        if (a.last === b.last) return 0;
        return a.last < b.last ? 1 : -1;
      });
    const size = Math.min(100, Math.max(1, Number(pageSize) || 20));
    const offset = (Math.max(1, Number(page) || 1) - 1) * size;
    return { list: rows.slice(offset, offset + size), total: rows.length, counts };
  }

  async save(box) {
    this.byImei.set(box.imei, box);
    this.byId.set(box.id, box);
  }

  async appendLog(record) {
    this.logs.push(record);
  }

  async listPlaces(boxId) {
    const rows = this.logs.filter((item) => item.boxId === boxId);
    const cluster = (lngName, latName) => {
      const buckets = new Map();
      for (const row of rows) {
        const lng = row[lngName];
        const lat = row[latName];
        if (lng == null || lat == null) continue;
        const key = `${Number(lng).toFixed(5)},${Number(lat).toFixed(5)}`;
        const found = buckets.get(key) || {
          lng: Number(Number(lng).toFixed(5)),
          lat: Number(Number(lat).toFixed(5)),
          count: 0,
          latest: "",
        };
        found.count += 1;
        if ((row.receivedAt || "") > found.latest) found.latest = row.receivedAt || "";
        buckets.set(key, found);
      }
      return [...buckets.values()];
    };
    return { lbs: cluster("lbsLng", "lbsLat"), gps: cluster("gpsLng", "gpsLat") };
  }

  async listLogs(boxId, range) {
    return this.logs
      .filter((item) => item.boxId === boxId)
      .filter((item) => {
        if (!range?.from || !range?.to) return true;
        const time = item.receivedAt || item.toJSON?.().time || "";
        return time >= range.from && time <= range.to;
      })
      .sort((a, b) => {
        const left = a.receivedAt || a.toJSON?.().time || "";
        const right = b.receivedAt || b.toJSON?.().time || "";
        return left < right ? 1 : left > right ? -1 : 0;
      });
  }

  async readRaw(boxId, logId) {
    const found = this.logs.find(
      (item) => item.boxId === boxId && String(item.id) === String(logId)
    );
    return found ? found.raw : null;
  }

  async listRecent(limit = 50) {
    return [...this.logs].sort((a, b) => (a.receivedAt < b.receivedAt ? 1 : -1)).slice(0, limit);
  }

  async nextBoxName() {
    return this.#exclusive(() => this.#allocateName());
  }

  async updateBox(id, change) {
    return this.#exclusive(() => {
      const box = this.byId.get(id) || null;
      if (box) change(box);
      return box;
    });
  }

  /** 与 SqlBoxStore.deleteBox 同语义；内存模式没有任务表，只校验状态和范围。 */
  async deleteBox(id, authorize) {
    return this.#exclusive(() => {
      const box = this.byId.get(id) || null;
      if (!box || !authorize(box)) return { error: "采样箱不存在", status: 404 };
      if (!["未使用", "停用"].includes(box.life))
        return { error: "只能删除未使用或停用的采样箱", status: 409 };
      this.byId.delete(id);
      this.byImei.delete(box.imei);
      this.logs = this.logs.filter((item) => item.boxId !== id);
      return { deleted: true };
    });
  }

  async commitUplink(uplink, receivedAt) {
    return this.#exclusive(() => {
      let box = this.byImei.get(uplink.imei) || null;
      if (!box) {
        box = BoxState.createPending(uplink.imei, uplink, receivedAt, this.#allocateName());
      }
      const kind = box.kindOf(uplink);
      box.apply(uplink, receivedAt);
      this.byImei.set(box.imei, box);
      this.byId.set(box.id, box);
      const record = UplinkRecord.capture(box, uplink, receivedAt, kind);
      this.logs.push(record);
      return new CommittedUplink(box, record);
    });
  }

  #allocateName() {
    const current = this.sequence;
    this.sequence += 1;
    return defaultBoxName(current);
  }

  #exclusive(task) {
    const run = this.tail.then(task, task);
    this.tail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }
}
