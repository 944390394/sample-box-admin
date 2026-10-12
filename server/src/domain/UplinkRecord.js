import { formatTimestamp } from "./Clock.js";

/**
 * 一条原始上报日志。
 * receivedAt 是服务器时间戳；deviceTime 只是报文里的设备时钟，两者都留下。
 */
export class UplinkRecord {
  constructor(fields) {
    this.boxId = fields.boxId;
    this.imei = fields.imei;
    this.receivedAt = fields.receivedAt;
    this.deviceTime = fields.deviceTime;
    this.kind = fields.kind;
    this.summary = fields.summary;
    this.raw = fields.raw;
    this.lbsLng = fields.lbsLng;
    this.lbsLat = fields.lbsLat;
    this.gpsLng = fields.gpsLng;
    this.gpsLat = fields.gpsLat;
  }

  static capture(box, uplink, receivedAt) {
    return new UplinkRecord({
      boxId: box.id,
      imei: uplink.imei,
      receivedAt: formatTimestamp(receivedAt),
      deviceTime: uplink.deviceTime,
      kind: uplink.why,
      summary: uplink.label,
      raw: uplink.raw,
      lbsLng: uplink.hasLbs() ? uplink.lbsLng : null,
      lbsLat: uplink.hasLbs() ? uplink.lbsLat : null,
      gpsLng: uplink.hasGps() ? uplink.gpsLng : null,
      gpsLat: uplink.hasGps() ? uplink.gpsLat : null,
    });
  }

  static fromRow(row) {
    return new UplinkRecord({
      boxId: row.box_id,
      imei: row.imei,
      receivedAt: UplinkRecord.#asText(row.received_at),
      deviceTime: row.device_time || "",
      kind: row.kind,
      summary: row.summary,
      raw: row.raw,
      lbsLng: row.lbs_lng == null ? null : Number(row.lbs_lng),
      lbsLat: row.lbs_lat == null ? null : Number(row.lbs_lat),
      gpsLng: row.gps_lng == null ? null : Number(row.gps_lng),
      gpsLat: row.gps_lat == null ? null : Number(row.gps_lat),
    });
  }

  toJSON() {
    return {
      box: this.boxId,
      time: this.receivedAt,
      text: this.summary,
      by: "设备",
      raw: this.raw,
      deviceTime: this.deviceTime,
      kind: this.kind,
      lbsLng: this.lbsLng,
      lbsLat: this.lbsLat,
      gpsLng: this.gpsLng,
      gpsLat: this.gpsLat,
    };
  }

  /** MySQL DATETIME 读出来可能是 Date，统一成日志上的时间字符串。 */
  static #asText(value) {
    if (value instanceof Date) return formatTimestamp(value);
    return String(value);
  }
}
