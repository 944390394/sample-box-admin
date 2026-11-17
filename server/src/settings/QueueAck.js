/** 空洞表最多留这么多条；超过说明设备长期乱序，直接按新队列重新计。 */
const GAP_MAX = 2000;
/** 开机跳号的最大长度，固件目前是 128。 */
const SKIP_MAX = 1024;
/**
 * 空洞超过这么久还没补齐就先放弃，确认号越过去，免得设备队列一直清不掉。
 * 设备 120 秒才重传一次，信号差时一条记录要重试好几轮才上来，所以给 30 分钟。
 * 放弃的序号记进 box_ack_lost：之后真的补上来照样入库（只收一次），不当成重复丢掉。
 */
export const GAP_GIVEUP_MS = 30 * 60 * 1000;
/** 每台设备最多记这么多个放弃的序号，再多就是长期丢失，不再等。 */
const LOST_MAX = 5000;

/**
 * 离线队列的累计确认和去重，按 IMEI 和队列代号（qe）记账。
 * 调用方保证同一台设备串行；先 seen 判重，入库成功后再 record，入库失败不会误确认。
 */
export class QueueAck {
  constructor(db, options = {}) {
    this.db = db;
    this.giveUpMs = options.giveUpMs ?? GAP_GIVEUP_MS;
    this.now = options.now ?? (() => Date.now());
  }

  /** 这一条是否已经收到过。重复的不入库、不改箱子状态，只回当前确认号。 */
  async seen(uplink, db = this.db) {
    if (uplink.q == null) return null;
    const qe = uplink.qe ?? 0;
    const row = await db.get("SELECT qe, ack_q FROM box_ack WHERE imei=?", [uplink.imei]);
    if (!row || Number(row.qe) !== qe) return { dup: false, ack: null };
    const ack = Number(row.ack_q);
    if (uplink.q <= ack) {
      // 放弃过的序号迟到了：第一次照常入库
      const lost = await db.get("SELECT q FROM box_ack_lost WHERE imei=? AND qe=? AND q=?", [
        uplink.imei,
        qe,
        uplink.q,
      ]);
      return { dup: !lost, ack, late: Boolean(lost) };
    }
    const gap = await db.get("SELECT q FROM box_ack_gap WHERE imei=? AND qe=? AND q=?", [
      uplink.imei,
      qe,
      uplink.q,
    ]);
    return gap ? { dup: true, ack } : { dup: false, ack };
  }

  /** 把确认号推过已经先到的连续序号。 */
  async #merge(tx, imei, qe, ack) {
    for (;;) {
      const next = await tx.get("SELECT q FROM box_ack_gap WHERE imei=? AND qe=? AND q=?", [
        imei,
        qe,
        ack + 1,
      ]);
      if (!next) return ack;
      await tx.run("DELETE FROM box_ack_gap WHERE imei=? AND qe=? AND q=?", [imei, qe, ack + 1]);
      ack++;
    }
  }

  /** 入库成功之后记账，返回要回给设备的确认号。 */
  async record(uplink, tx) {
    if (uplink.q == null) return null;
    if (!tx) return this.db.transaction((db) => this.record(uplink, db));
    const qe = uplink.qe ?? 0;
    const nowMs = this.now();
    const now = new Date(nowMs).toISOString();
    const row = await tx.get("SELECT qe, ack_q, gap_since FROM box_ack WHERE imei=?", [
      uplink.imei,
    ]);
    // 第一次见到这个队列代号：以这条之前为已确认，不把更早的当成缺失。
    if (!row || Number(row.qe) !== qe) {
      await tx.run("DELETE FROM box_ack_gap WHERE imei=?", [uplink.imei]);
      if (row)
        await tx.run(
          "UPDATE box_ack SET qe=?, ack_q=?, gap_since=NULL, updated_at=? WHERE imei=?",
          [qe, uplink.q, now, uplink.imei]
        );
      else
        await tx.run("INSERT INTO box_ack (imei,qe,ack_q,updated_at) VALUES (?,?,?,?)", [
          uplink.imei,
          qe,
          uplink.q,
          now,
        ]);
      return uplink.q;
    }
    let ack = Number(row.ack_q);
    let since = row.gap_since || null;
    // 固件开机时故意跳过了一段编号：把它们当作已到，否则确认号会一直卡在空洞前面。
    if (uplink.qz != null && uplink.q > uplink.qz + 1 && uplink.q - uplink.qz - 1 <= SKIP_MAX) {
      for (let n = Math.max(uplink.qz, ack) + 1; n < uplink.q; n++) {
        await tx.run(
          "INSERT INTO box_ack_gap (imei,qe,q) SELECT ?,?,? WHERE NOT EXISTS (SELECT 1 FROM box_ack_gap WHERE imei=? AND qe=? AND q=?)",
          [uplink.imei, qe, n, uplink.imei, qe, n]
        );
      }
    }
    if (uplink.q === ack + 1) {
      ack = await this.#merge(tx, uplink.imei, qe, uplink.q);
    } else if (uplink.q > ack + 1) {
      const count = await tx.get("SELECT COUNT(*) AS n FROM box_ack_gap WHERE imei=?", [
        uplink.imei,
      ]);
      if (Number(count?.n) >= GAP_MAX) {
        await tx.run("DELETE FROM box_ack_gap WHERE imei=?", [uplink.imei]);
        await tx.run("UPDATE box_ack SET ack_q=?, gap_since=NULL, updated_at=? WHERE imei=?", [
          uplink.q,
          now,
          uplink.imei,
        ]);
        return uplink.q;
      }
      await tx.run("INSERT INTO box_ack_gap (imei,qe,q) VALUES (?,?,?)", [
        uplink.imei,
        qe,
        uplink.q,
      ]);
      since = since || now;
    } else {
      // 迟到的补传已经入库：从放弃表里划掉，再来一次就是重复
      await tx.run("DELETE FROM box_ack_lost WHERE imei=? AND qe=? AND q=?", [
        uplink.imei,
        qe,
        uplink.q,
      ]);
      return ack;
    }
    // 空洞拖了太久就放弃：把确认号推到最小的已到序号，再接着合并。
    if (since) {
      const first = await tx.get("SELECT MIN(q) AS q FROM box_ack_gap WHERE imei=? AND qe=?", [
        uplink.imei,
        qe,
      ]);
      if (first?.q == null) since = null;
      else if (nowMs - Date.parse(since) >= this.giveUpMs) {
        await this.#markLost(tx, uplink.imei, qe, ack + 1, Number(first.q) - 1, now);
        ack = await this.#merge(tx, uplink.imei, qe, Number(first.q) - 1);
        const left = await tx.get("SELECT COUNT(*) AS n FROM box_ack_gap WHERE imei=?", [
          uplink.imei,
        ]);
        since = Number(left?.n) > 0 ? now : null;
      }
    }
    await tx.run("UPDATE box_ack SET ack_q=?, gap_since=?, updated_at=? WHERE imei=?", [
      ack,
      since,
      now,
      uplink.imei,
    ]);
    return ack;
  }

  /** 记下放弃的序号 from..to；超过上限时去掉最早的。 */
  async #markLost(tx, imei, qe, from, to, now) {
    if (to < from) return;
    const start = Math.max(from, to - LOST_MAX + 1);
    for (let q = start; q <= to; q++) {
      await tx.run(
        "INSERT INTO box_ack_lost (imei,qe,q,lost_at) SELECT ?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM box_ack_lost WHERE imei=? AND qe=? AND q=?)",
        [imei, qe, q, now, imei, qe, q]
      );
    }
    const count = await tx.get("SELECT COUNT(*) AS n FROM box_ack_lost WHERE imei=?", [imei]);
    const extra = Number(count?.n) - LOST_MAX;
    if (extra > 0) {
      const edge = await tx.get(
        `SELECT q FROM box_ack_lost WHERE imei=? ORDER BY qe, q LIMIT 1 OFFSET ${extra - 1}`,
        [imei]
      );
      if (edge) await tx.run("DELETE FROM box_ack_lost WHERE imei=? AND q<=?", [imei, edge.q]);
    }
  }

  /** 删除档案时一并清掉，设备再次上报按新队列重新计。 */
  async clear(imei, db = this.db) {
    await db.run("DELETE FROM box_ack_lost WHERE imei=?", [imei]);
    await db.run("DELETE FROM box_ack_gap WHERE imei=?", [imei]);
    await db.run("DELETE FROM box_ack WHERE imei=?", [imei]);
  }
}
