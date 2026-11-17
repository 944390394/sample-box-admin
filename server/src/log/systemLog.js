import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

export const LOG_READ = "sys:runtime-log:read";
export const LOG_DETAIL = "sys:runtime-log:detail";
export const SLOW_MS = 2000;
const DAY = 86400000;
const FIELDS = [
  "id",
  "time",
  "level",
  "source",
  "kind",
  "message",
  "stack",
  "duration",
  "method",
  "path",
  "status",
  "code",
  "requestId",
  "actorId",
  "deviceId",
  "release",
  "fingerprint",
];

/** 不采集请求体、请求头和查询参数；错误文本再作保守脱敏。 */
export function redact(value, max = 2000) {
  return String(value ?? "")
    .replace(/Bearer\s+[^\s,;"']+/gi, "Bearer [已脱敏]")
    .replace(
      /(["']?(?:password|passwd|secret|token|authorization|cookie|api[_-]?key|tk|sk)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&}]+)/gi,
      "$1[已脱敏]"
    )
    .replace(/(\w+:\/\/)[^\s/@]+:[^\s/@]+@/g, "$1[已脱敏]@")
    .replace(/(https?:\/\/[^\s?#]+)\?[^\s)]+/g, "$1?[已隐藏参数]")
    .replace(/\b\d{15,22}\b/g, "[已隐藏设备标识]")
    .slice(0, max);
}
export function safePath(value) {
  return redact(String(value ?? "").split(/[?#]/)[0], 300);
}
function normalize(entry, release) {
  const error = entry.error,
    message = redact(entry.message || error?.message || "未知异常");
  const stack = redact(error?.stack || entry.stack || "", 8000);
  const source = ["http", "frontend", "tcp", "process", "database", "service"].includes(
    entry.source
  )
    ? entry.source
    : "service";
  const kind = redact(entry.kind || "exception", 40),
    path = safePath(entry.path);
  return {
    id: randomUUID(),
    time: Date.now(),
    level: ["error", "warn", "info"].includes(entry.level) ? entry.level : "error",
    source,
    kind,
    message,
    stack,
    duration: Number.isFinite(entry.duration) ? Math.max(0, Math.round(entry.duration)) : null,
    method: redact(entry.method, 10),
    path,
    status: Number.isInteger(entry.status) ? entry.status : null,
    code: redact(entry.code || error?.code, 60),
    requestId: /^[a-zA-Z0-9-]{1,64}$/.test(entry.requestId || "") ? entry.requestId : randomUUID(),
    actorId: redact(entry.actorId, 64),
    deviceId: redact(entry.deviceId, 64),
    release: redact(release, 80),
    fingerprint: createHash("sha256")
      .update(
        [
          source,
          kind,
          entry.method,
          path,
          message.replace(/\b\d+\b/g, "#"),
          stack.split("\n")[1] || "",
        ].join("|")
      )
      .digest("hex")
      .slice(0, 24),
  };
}
/** 独立诊断库：业务库不可用时仍能落盘。仅记录异常、慢请求和生命周期。 */
export class SystemLog {
  constructor(
    file,
    { release = "", retentionDays = 30, maxRows = 100000, stderr = console.error } = {}
  ) {
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.release = release;
    this.retentionDays = retentionDays;
    this.maxRows = maxRows;
    this.stderr = stderr;
    this.dropped = 0;
    this.lastFailure = "";
    this.minute = 0;
    this.count = 0;
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=100;
      CREATE TABLE IF NOT EXISTS runtime_log (
        id TEXT PRIMARY KEY, time INTEGER NOT NULL, level TEXT NOT NULL, source TEXT NOT NULL,
        kind TEXT NOT NULL, message TEXT NOT NULL, stack TEXT NOT NULL, duration INTEGER,
        method TEXT, path TEXT, status INTEGER, code TEXT, requestId TEXT, actorId TEXT,
        deviceId TEXT, release TEXT, fingerprint TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS runtime_log_time ON runtime_log(time DESC,id DESC);
      CREATE INDEX IF NOT EXISTS runtime_log_group ON runtime_log(fingerprint,time DESC);
      CREATE INDEX IF NOT EXISTS runtime_log_request ON runtime_log(requestId);
      CREATE INDEX IF NOT EXISTS runtime_log_source ON runtime_log(source,time DESC);`);
    this.insert = this.db.prepare(
      `INSERT INTO runtime_log (${FIELDS.join(",")}) VALUES (${FIELDS.map(() => "?").join(",")})`
    );
    this.prune();
    this.timer = setInterval(() => {
      try {
        this.prune();
      } catch (error) {
        this.failure(error);
      }
    }, 60000);
    this.timer.unref();
  }
  failure(error) {
    const now = Date.now();
    this.lastFailure = redact(error?.message || error);
    if (!this.lastStderr || now - this.lastStderr > 60000) {
      this.lastStderr = now;
      this.stderr("[system-log] 诊断写入失败", this.lastFailure);
    }
  }
  record(entry) {
    try {
      const minute = Math.floor(Date.now() / 60000);
      if (minute !== this.minute) {
        this.minute = minute;
        this.count = 0;
      }
      // 限流保护磁盘与事件循环；丢弃数量在界面明示。
      if (++this.count > 3000) {
        this.dropped++;
        return null;
      }
      const item = normalize(entry, this.release);
      this.insert.run(...FIELDS.map((key) => item[key]));
      return item;
    } catch (error) {
      this.dropped++;
      this.failure(error);
      return null;
    }
  }
  prune() {
    this.db
      .prepare("DELETE FROM runtime_log WHERE time < ?")
      .run(Date.now() - this.retentionDays * DAY);
    const row = this.db
      .prepare("SELECT time,id FROM runtime_log ORDER BY time DESC,id DESC LIMIT 1 OFFSET ?")
      .get(this.maxRows - 1);
    if (row)
      this.db
        .prepare("DELETE FROM runtime_log WHERE time < ? OR (time = ? AND id < ?)")
        .run(row.time, row.time, row.id);
  }
  health() {
    return {
      retentionDays: this.retentionDays,
      maxRows: this.maxRows,
      dropped: this.dropped,
      lastFailure: this.lastFailure,
      slowMs: SLOW_MS,
      release: this.release,
    };
  }
  query(query = {}) {
    const end = query.to === undefined ? Date.now() : Number(query.to),
      start = query.from === undefined ? end - DAY : Number(query.from);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || end - start > 31 * DAY)
      throw new Error("请选择不超过31天的有效时间范围");
    const where = ["time >= ?", "time <= ?"],
      values = [start, end];
    for (const field of ["level", "source", "kind", "requestId", "deviceId", "fingerprint"]) {
      if (query[field]) {
        where.push(`${field} = ?`);
        values.push(String(query[field]).slice(0, 100));
      }
    }
    if (query.excludeAuth === "true" && !query.kind && !query.requestId) {
      where.push("kind <> 'auth' AND COALESCE(code,'') NOT IN ('A0230','A0231')");
    }
    if (query.status !== undefined && query.status !== "") {
      const status = Number(query.status);
      if (!Number.isInteger(status) || status < 100 || status > 599)
        throw new Error("HTTP状态码须为100至599");
      where.push("status = ?");
      values.push(status);
    }
    if (query.minDuration !== undefined && query.minDuration !== "") {
      const n = Number(query.minDuration);
      if (!Number.isFinite(n) || n < 0) throw new Error("耗时必须是非负数字");
      where.push("duration >= ?");
      values.push(n);
    }
    if (query.q) {
      where.push("(message LIKE ? ESCAPE '\\' OR path LIKE ? ESCAPE '\\' OR code = ?)");
      const q = String(query.q).slice(0, 100),
        like = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
      values.push(like, like, q);
    }
    const filter = where.join(" AND ");
    const summary = this.db
      .prepare(
        `SELECT COUNT(*) total, SUM(level='error') errors, SUM(kind='slow') slow, COUNT(DISTINCT fingerprint) issues, MAX(duration) maxDuration FROM runtime_log WHERE ${filter}`
      )
      .get(...values);
    const limit = 50;
    if (query.group === "true") {
      const page = Math.max(1, Math.min(2000, Math.trunc(Number(query.page) || 1)));
      const sort =
        { recent: "lastTime", count: "occurrences", duration: "maxDuration" }[query.sort] ||
        "lastTime";
      const rows = this.db
        .prepare(
          `WITH matched AS (
            SELECT *, ROW_NUMBER() OVER (PARTITION BY fingerprint ORDER BY time DESC,id DESC) rn
            FROM runtime_log WHERE ${filter}
          ), grouped AS (
            SELECT fingerprint, MAX(time) lastTime, MIN(time) firstTime, COUNT(*) occurrences,
              MAX(duration) maxDuration, ROUND(AVG(duration)) avgDuration,
              CASE WHEN SUM(level='error')>0 THEN 'error' WHEN SUM(level='warn')>0 THEN 'warn' ELSE 'info' END level
            FROM matched GROUP BY fingerprint
          ) SELECT g.*, r.id latestId, r.message, r.source, r.kind, r.method, r.path, r.status, r.code
          FROM grouped g JOIN matched r ON r.fingerprint=g.fingerprint AND r.rn=1
          ORDER BY ${sort} DESC,g.fingerprint DESC LIMIT ? OFFSET ?`
        )
        .all(...values, limit + 1, (page - 1) * limit);
      return {
        list: rows.slice(0, limit),
        hasMore: rows.length > limit,
        summary,
        health: this.health(),
      };
    }
    if (query.cursorTime && query.cursorId) {
      where.push("(time < ? OR (time = ? AND id < ?))");
      values.push(Number(query.cursorTime), Number(query.cursorTime), String(query.cursorId));
    }
    const rows = this.db
      .prepare(
        `SELECT ${FIELDS.filter((x) => x !== "stack").join(",")} FROM runtime_log WHERE ${where.join(" AND ")} ORDER BY time DESC,id DESC LIMIT ?`
      )
      .all(...values, limit + 1);
    const list = rows.slice(0, limit),
      last = list.at(-1);
    return {
      list,
      summary,
      health: this.health(),
      nextCursor: rows.length > limit ? { time: last.time, id: last.id } : null,
    };
  }
  detail(id) {
    return this.db.prepare("SELECT * FROM runtime_log WHERE id = ?").get(String(id));
  }
  close() {
    clearInterval(this.timer);
    this.db.close();
  }
}
let active = null;
export function setSystemLog(logger) {
  active = logger;
}
export function logSystem(entry) {
  active?.record(entry);
}
/** 覆盖HTTP 200的业务失败及中断；SSE不按连接时长判慢。 */
export function observeRequest(req, res) {
  const begin = performance.now(),
    info = { requestId: randomUUID(), source: "http", method: req.method, path: safePath(req.url) };
  res.setHeader("X-Request-Id", info.requestId);
  res.setHeader("Access-Control-Expose-Headers", "X-Request-Id");
  let done = false;
  const finish = (aborted) => {
    if (done) return;
    done = true;
    const duration = performance.now() - begin;
    const failed =
      info.error || (info.code && info.code !== "00000") || res.statusCode >= 400 || aborted;
    const slow =
      duration >= SLOW_MS && !String(res.getHeader("Content-Type")).includes("text/event-stream");
    if (failed || (slow && !info.path.includes("/system/runtime-logs")))
      logSystem({
        ...info,
        duration,
        status: aborted ? 499 : res.statusCode,
        kind: info.error
          ? "exception"
          : ["A0230", "A0231"].includes(info.code)
            ? "auth"
            : aborted
              ? "aborted"
              : failed
                ? "request_failed"
                : "slow",
        level:
          info.error || res.statusCode >= 500
            ? "error"
            : ["A0230", "A0231"].includes(info.code)
              ? "info"
              : "warn",
        message:
          info.message ||
          (aborted ? "客户端中断请求" : failed ? "请求失败" : `接口耗时超过 ${SLOW_MS}ms`),
      });
  };
  res.once("finish", () => finish(false));
  res.once("close", () => finish(!res.writableFinished));
  res.diagnostic = info;
  return info;
}
