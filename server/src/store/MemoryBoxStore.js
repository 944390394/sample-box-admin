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

  async list() {
    return [...this.byId.values()].sort((a, b) => (a.last < b.last ? 1 : -1));
  }

  async save(box) {
    this.byImei.set(box.imei, box);
    this.byId.set(box.id, box);
  }

  async appendLog(record) {
    this.logs.push(record);
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

  async nextBoxId() {
    return this.#exclusive(() => this.#allocateId());
  }

  async commitUplink(uplink, receivedAt) {
    return this.#exclusive(() => {
      let box = this.byImei.get(uplink.imei) || null;
      if (!box) {
        box = BoxState.createPending(this.#allocateId(), uplink, receivedAt);
      }
      box.apply(uplink, receivedAt);
      this.byImei.set(box.imei, box);
      this.byId.set(box.id, box);
      const record = UplinkRecord.capture(box, uplink, receivedAt);
      this.logs.push(record);
      return new CommittedUplink(box, record);
    });
  }

  #allocateId() {
    const current = this.sequence;
    this.sequence += 1;
    return `BOX-${String(current).padStart(3, "0")}`;
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
