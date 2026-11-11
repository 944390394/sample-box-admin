import { formatUnixMs } from "./Clock.js";
import { Uplink } from "./Uplink.js";
import { UplinkError } from "./UplinkError.js";

/** 补传行用：去掉模块此刻的定位和信号相关字段。 */
function withoutPosition(body) {
  const next = { ...body, gpsfix: 0 };
  for (const key of [
    "lng",
    "lat",
    "lbslng",
    "lbslat",
    "glng",
    "glat",
    "gat",
    "speed",
    "course",
    "alt",
    "sats",
    "hdop",
    "gpstime",
  ])
    delete next[key];
  return next;
}

/**
 * 把银尔达 DTU 发来的一包 JSON 拆成领域对象。
 * 基站看 lbslng / lbslat，GPS 只在 gpsfix 为 1 时看 lng / lat。
 * 000.0000000 表示这一侧没有定位，不能当成真实坐标。
 */
export class UplinkParser {
  /**
   * 一包里可能有多行：设备离线时存下的补传加上当前这行。拆成多条，并且：
   * - 模块此刻的 GPS、基站位置只给「当前」那行（行里设备时间和模块时间相差 2 分钟内；没带时间时取最后一行），
   *   补传行不带位置，免得旧记录全落在现在的位置上；
   * - 某一行解析不了只丢这一行，其余照收；全都不行才报错。
   */
  parseMany(rawText) {
    const raw = String(rawText ?? "").trim();
    const body = this.#readObject(raw);
    const lines = this.#reportLines(body.uart);
    const moduleMs = Number(body.timem) || null;
    const isCurrent = (line, index) => {
      const t = this.#readMillis(line, "t");
      if (t != null && moduleMs) return Math.abs(moduleMs - t) <= 120000;
      return index === lines.length - 1;
    };
    if (lines.length <= 1) {
      if (isCurrent(lines[0] || "", 0)) return [this.parse(raw)];
      return [this.parse(JSON.stringify(withoutPosition(body)))];
    }
    const parsed = [];
    let firstError = null;
    lines.forEach((line, index) => {
      const next = isCurrent(line, index)
        ? { ...body, uart: line }
        : { ...withoutPosition(body), uart: line };
      // 十六进制副本带着整包所有行，拆成每行一条后每条都留一份，只会撑大库；服务器从不读它。
      delete next.uarthex;
      const bat = line.match(/(?:^|,)bat=(\d+)/);
      if (bat) next.vbat = Number(bat[1]);
      try {
        parsed.push(this.parse(JSON.stringify(next)));
      } catch (error) {
        firstError = firstError || error;
      }
    });
    if (!parsed.length) throw firstError || new UplinkError("上报为空");
    return parsed;
  }

  parse(rawText) {
    const raw = String(rawText ?? "").trim();
    const body = this.#readObject(raw);
    const imei = String(body.imei ?? "").trim();
    if (!/^\d{14,17}$/.test(imei)) {
      throw new UplinkError("上报缺少有效 IMEI");
    }

    const line = this.#reportLines(body.uart)[0] || "";
    const why = this.#readWhy(line);
    const stamp = this.#readMillis(line, "t");
    const stamped = stamp == null ? "" : formatUnixMs(stamp);
    const poff = this.#readMillis(line, "poff");
    let gpsfix = Number(body.gpsfix) === 1 ? 1 : 0;
    const lbs = this.#readPair(body.lbslng, body.lbslat);
    let gps = gpsfix === 1 ? this.#readPair(body.lng, body.lat) : { lng: null, lat: null };
    // 新模板：此刻没定位但 10 分钟内定位过时带 glng/glat/gat（上次 GPS 的坐标和秒级时间）
    let gpsAt = "";
    if (gpsfix === 0 && body.glng != null && body.glat != null) {
      const last = this.#readPair(body.glng, body.glat);
      const at = Number(body.gat);
      if (last.lng != null && Number.isFinite(at) && at > 1600000000) {
        gps = last;
        gpsfix = 1;
        gpsAt = formatUnixMs(at * 1000);
      }
    }

    // Coordinates stored alongside this event survive retries, transport batching and reboot.
    const fix = /(?:^|,)xy=(-?\d{1,9})\/(-?\d{1,8})\/(\d{10})(?:,|$)/.exec(line.trim());
    if (
      fix &&
      why === "timer" &&
      Math.abs(Number(fix[1])) <= 180000000 &&
      Math.abs(Number(fix[2])) <= 90000000 &&
      Number(fix[3]) > 1600000000
    ) {
      const pair = this.#readPair(Number(fix[1]) / 1e6, Number(fix[2]) / 1e6);
      if (pair.lng != null) {
        gps = pair;
        gpsfix = 1;
        gpsAt = formatUnixMs(Number(fix[3]) * 1000);
      }
    }
    return new Uplink({
      imei,
      scheduled: body.lpp === 1,
      policyVersion: this.#readLearn(line, "pv"),
      reportPeriodSec: this.#readLearn(line, "rp"),
      reportCharging: this.#readLearn(line, "rc"),
      iccid: String(body.iccid ?? ""),
      imsi: String(body.imsi ?? ""),
      csq: Number.isFinite(Number(body.csq)) ? Number(body.csq) : 0,
      vbat:
        this.#readLearn(line, "bat") ??
        (Number.isFinite(Number(body.vbat)) ? Number(body.vbat) : 0),
      deviceTime: stamped || String(body.time ?? ""),
      why,
      opens: this.#readOpens(line) ?? this.#count(body.opens),
      lid: this.#readLid(line) ?? this.#count(body.lid),
      openAge: this.#readOpenAge(line),
      charge: this.#readCharge(line) ?? this.#count(body.chg),
      powerOff: poff == null ? "" : formatUnixMs(poff),
      storageFree: this.#readFree(line),
      firmware: this.#readFirmware(line),
      seq: this.#readSeq(line),
      dump: this.#readDump(line, why),
      q: this.#readQueue(line, "q"),
      qe: this.#readQueue(line, "qe"),
      qz: this.#readQueue(line, "qz"),
      backfill: this.#readQueue(line, "bf") === 1,
      netLink: this.#readQueue(line, "rn"),
      learnFull: this.#readLearn(line, "hi"),
      learnEmpty: this.#readLearn(line, "lo"),
      learnCount: this.#readLearn(line, "n"),
      gpsfix,
      lbsLng: lbs.lng,
      lbsLat: lbs.lat,
      gpsLng: gps.lng,
      gpsLat: gps.lat,
      gpsInfo: gpsfix === 1 && (!gpsAt || fix) ? this.#readGpsInfo(body) : null,
      gpsAt,
      raw,
    });
  }

  #readObject(raw) {
    if (!raw) throw new UplinkError("上报为空");
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      throw new UplinkError("上报不是 JSON");
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new UplinkError("上报不是 JSON 对象");
    }
    return body;
  }

  /**
   * 任务先把 STM 那一行打成 JSON，发送模板还会再包一层。
   * 最里面的 uart 才是 why=chg,opens=0,... 这一行。
   */
  #stmLine(uart) {
    let text = typeof uart === "string" ? uart.trim() : "";
    for (let depth = 0; depth < 4 && text.startsWith("{"); depth += 1) {
      let inner;
      try {
        inner = JSON.parse(text);
      } catch {
        break;
      }
      if (!inner || typeof inner !== "object" || Array.isArray(inner)) break;
      if (typeof inner.uart !== "string") break;
      const next = inner.uart.trim();
      if (!next || next === text) break;
      text = next;
    }
    return text;
  }

  #reportLines(uart) {
    const text = this.#stmLine(uart);
    const rows = text
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean);
    if (rows.length > 1) return rows;
    const glued = text
      .split(/(?=why=)/)
      .map((item) => item.trim())
      .filter((item) => item.startsWith("why="));
    return glued.length > 1 ? glued : [text];
  }

  #readWhy(line) {
    const found = line.match(/(?:^|,)why=([A-Za-z0-9_-]+)/);
    return found ? found[1] : "unknown";
  }

  #readOpens(line) {
    const found = line.match(/(?:^|,)opens=(\d+)/);
    return found ? Number(found[1]) : null;
  }

  /** 1 箱盖开着，0 关着。这行没带 lid 时不猜测。 */
  #readLid(line) {
    const found = line.match(/(?:^|,)lid=(\d+)/);
    return found ? Number(found[1]) : null;
  }

  /** 距离上一次开箱的秒数。模块的 time 减去它就是上次开箱时间。 */
  #readOpenAge(line) {
    const found = line.match(/(?:^|,)openage=(\d+)/);
    return found ? Number(found[1]) : null;
  }

  /**
   * 13 位是毫秒，10 位是秒。t 是这一包的时间，poff 是掉电前最后一次还在走的时间。
   */
  #readMillis(line, name) {
    const found = line.match(new RegExp(`(?:^|,)${name}=(\\d+)`));
    if (!found) return null;
    if (found[1].length === 13) return Number(found[1]);
    if (found[1].length === 10) return Number(found[1]) * 1000;
    return null;
  }

  #readQueue(line, name) {
    const found = String(line || "").match(new RegExp(`(?:^|,)${name}=(\\d{1,10})(?=,|\\r|\\n|$)`));
    return found ? Number(found[1]) : null;
  }

  #readFree(line) {
    const found = line.match(/(?:^|,)free=(\d+)/);
    return found ? Number(found[1]) : null;
  }

  #readFirmware(line) {
    const found = line.match(/(?:^|,)fw=([^,\r\n]+)/);
    return found ? found[1] : "";
  }

  /** 单片机复位后从 1 重新数。变小说明中间有一次上电，why=boot 可能没送到。 */
  #readSeq(line) {
    const found = line.match(/(?:^|,)seq=(\d+)/);
    return found ? Number(found[1]) : null;
  }

  /**
   * 板子回传本机日志：why=dumpinfo,total=N 是条数估算；
   * why=dump,r=请求号,part=i/N,d=类型:秒:开箱次数;… 是一段记录。
   */
  #readDump(line, why) {
    if (why !== "dump" && why !== "dumpinfo") return null;
    const num = (pattern) => {
      const found = line.match(pattern);
      return found ? Number(found[1]) : null;
    };
    const part = line.match(/(?:^|,)part=(\d+)\/(\d+)/);
    const body = line.match(/(?:^|,)d=([^,\r\n]*)/);
    return {
      req: num(/(?:^|,)r=(\d+)/),
      total: num(/(?:^|,)total=(\d+)/),
      part: part ? Number(part[1]) : null,
      parts: part ? Number(part[2]) : null,
      body: body ? body[1] : "",
    };
  }

  /** TP4057：1 正在充电，2 充满，0 未插充电器。 */
  /** 设备离线存储里的学习结果。hi、lo 是毫伏，n 是已经记下来的充放电次数。 */
  #readLearn(line, name) {
    const found = String(line || "").match(new RegExp(`(?:^|,)${name}=(\\d+)`));
    if (!found) return null;
    const value = Number(found[1]);
    if (!Number.isInteger(value)) return null;
    if (name === "pv") return value >= 0 && value <= 4294967295 ? value : null;
    if (name === "rp") return value >= 5 && value <= 3600 ? value : null;
    if (name === "rc") return value === 0 || value === 1 ? value : null;
    if (name === "n") return value >= 1 && value <= 8 ? value : null;
    return value >= 2500 && value <= 4500 ? value : null;
  }

  #readCharge(line) {
    const found = line.match(/(?:^|,)chg=(\d+)/);
    return found ? Number(found[1]) : null;
  }

  /** 模板拆出来的数字字段。行里已经有同名字段时不用它。 */
  #count(value) {
    if (value == null || value === "") return null;
    const number = Number(value);
    if (!Number.isInteger(number) || number < 0) return null;
    return number;
  }

  /** 数据模板在定位成功时多带的字段；一项都没有就当旧模板。 */
  #readGpsInfo(body) {
    const num = (value, min, max) => {
      if (value == null || value === "") return null;
      const n = Number(value);
      return Number.isFinite(n) && n >= min && n <= max ? n : null;
    };
    const info = {
      speed: num(body.speed, 0, 2000),
      course: num(body.course, 0, 360),
      alt: num(body.alt, -1000, 20000),
      sats: num(body.sats, 0, 100),
      hdop: num(body.hdop, 0, 100),
      time: typeof body.gpstime === "string" && body.gpstime.length <= 32 ? body.gpstime : "",
    };
    return Object.values(info).some((v) => v != null && v !== "") ? info : null;
  }

  #readPair(lngText, latText) {
    const lng = this.#readDegree(lngText);
    const lat = this.#readDegree(latText);
    if (lng == null || lat == null) return { lng: null, lat: null };
    if (lng === 0 && lat === 0) return { lng: null, lat: null };
    return { lng, lat };
  }

  #readDegree(value) {
    if (value == null || value === "") return null;
    const degree = Number(value);
    if (!Number.isFinite(degree)) return null;
    return degree;
  }
}
