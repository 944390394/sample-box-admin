import { Uplink } from "./Uplink.js";
import { UplinkError } from "./UplinkError.js";

/**
 * 把银尔达 DTU 发来的一包 JSON 拆成领域对象。
 * 基站看 lbslng / lbslat，GPS 只在 gpsfix 为 1 时看 lng / lat。
 * 000.0000000 表示这一侧没有定位，不能当成真实坐标。
 */
export class UplinkParser {
  parse(rawText) {
    const raw = String(rawText ?? "").trim();
    const body = this.#readObject(raw);
    const imei = String(body.imei ?? "").trim();
    if (!/^\d{14,17}$/.test(imei)) {
      throw new UplinkError("上报缺少有效 IMEI");
    }

    const uart = typeof body.uart === "string" ? body.uart : "";
    const why = this.#readWhy(uart);
    const gpsfix = Number(body.gpsfix) === 1 ? 1 : 0;
    const lbs = this.#readPair(body.lbslng, body.lbslat);
    const gps = gpsfix === 1 ? this.#readPair(body.lng, body.lat) : { lng: null, lat: null };

    return new Uplink({
      imei,
      iccid: String(body.iccid ?? ""),
      imsi: String(body.imsi ?? ""),
      csq: Number.isFinite(Number(body.csq)) ? Number(body.csq) : 0,
      vbat: Number.isFinite(Number(body.vbat)) ? Number(body.vbat) : 0,
      deviceTime: String(body.time ?? ""),
      why,
      opens: this.#readOpens(uart),
      gpsfix,
      lbsLng: lbs.lng,
      lbsLat: lbs.lat,
      gpsLng: gps.lng,
      gpsLat: gps.lat,
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

  /** uart 既可能是 why=boot,... 也可能是一串内嵌 JSON。 */
  #readWhy(uart) {
    const trimmed = uart.trim();
    if (trimmed.startsWith("{")) {
      try {
        const inner = JSON.parse(trimmed);
        if (typeof inner.why === "string" && inner.why) return inner.why;
      } catch {
        return "unknown";
      }
    }
    const found = trimmed.match(/(?:^|,)why=([A-Za-z0-9_-]+)/);
    return found ? found[1] : "unknown";
  }

  #readOpens(uart) {
    const found = uart.match(/(?:^|,)opens=(\d+)/);
    return found ? Number(found[1]) : null;
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
