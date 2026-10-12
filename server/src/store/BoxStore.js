/**
 * 箱子与原始上报的仓储端口。
 * 内存实现给测试和未接数据库时用，SQL 实现给安装后的 SQLite / MySQL。
 * 业务服务只依赖这些方法，不写 SQL。
 */
export class BoxStore {
  async findByImei(imei) {
    throw new Error(`${this.constructor.name} 未实现 findByImei(${imei})`);
  }

  async findById(id) {
    throw new Error(`${this.constructor.name} 未实现 findById(${id})`);
  }

  async list() {
    throw new Error(`${this.constructor.name} 未实现 list`);
  }

  async save(box) {
    throw new Error(`${this.constructor.name} 未实现 save(${box?.id ?? ""})`);
  }

  async appendLog(record) {
    throw new Error(`${this.constructor.name} 未实现 appendLog(${record?.boxId ?? ""})`);
  }

  async listLogs(boxId) {
    throw new Error(`${this.constructor.name} 未实现 listLogs(${boxId})`);
  }

  async listRecent(limit) {
    throw new Error(`${this.constructor.name} 未实现 listRecent(${limit})`);
  }

  async nextBoxId() {
    throw new Error(`${this.constructor.name} 未实现 nextBoxId`);
  }

  /** 箱子最新状态和原始报文一次提交。失败时两边都不留下。 */
  async commitUplink(uplink, receivedAt) {
    throw new Error(
      `${this.constructor.name} 未实现 commitUplink(${uplink?.imei ?? ""}, ${receivedAt})`
    );
  }
}
