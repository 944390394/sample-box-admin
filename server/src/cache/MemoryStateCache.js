import { StateCache } from "./StateCache.js";

/** 没配置 REDIS_URL 时使用。进程退出后消失，数据库仍是准的。 */
export class MemoryStateCache extends StateCache {
  constructor() {
    super();
    this.rows = new Map();
  }

  async put(box) {
    this.rows.set(box.id, box.toJSON());
  }

  async get(id) {
    return this.rows.get(id) || null;
  }
}
