/**
 * 箱子最新状态缓存。
 * 大屏和列表读这里，避免每次把上报流水扫一遍。
 */
export class StateCache {
  async put(box) {
    throw new Error(`${this.constructor.name} 未实现 put(${box?.id ?? ""})`);
  }

  async get(id) {
    throw new Error(`${this.constructor.name} 未实现 get(${id})`);
  }

  async close() {}
}
