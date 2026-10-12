import { formatTimestamp } from "./Clock.js";

/**
 * 一台采样箱的最新状态。
 * 基站和 GPS 分开保存。某一侧这次没定位时，不覆盖上一次已经拿到的坐标。
 */
export class BoxState {
  constructor(fields) {
    this.id = fields.id;
    this.imei = fields.imei;
    this.iccid = fields.iccid;
    this.imsi = fields.imsi;
    this.firmware = fields.firmware;
    this.org = fields.org;
    this.owner = fields.owner;
    this.life = fields.life;
    this.alert = fields.alert;
    this.battery = fields.battery;
    this.csq = fields.csq;
    this.last = fields.last;
    this.lbs = fields.lbs;
    this.lbsLng = fields.lbsLng;
    this.lbsLat = fields.lbsLat;
    this.gps = fields.gps;
    this.gpsLng = fields.gpsLng;
    this.gpsLat = fields.gpsLat;
    this.opens = fields.opens;
    this.activateStep = fields.activateStep;
    this.poweredAt = fields.poweredAt;
  }

  /** 未知 IMEI 的第一包：待激活，所属总公司。密钥还没下发。 */
  static createPending(id, uplink, receivedAt) {
    return new BoxState({
      id,
      imei: uplink.imei,
      iccid: uplink.iccid,
      imsi: uplink.imsi,
      firmware: "",
      org: "总公司",
      owner: "—",
      life: "待激活",
      alert: "",
      battery: "",
      csq: 0,
      last: "",
      lbs: "",
      lbsLng: null,
      lbsLat: null,
      gps: "",
      gpsLng: null,
      gpsLat: null,
      opens: 0,
      activateStep: "等待激活",
      poweredAt: formatTimestamp(receivedAt),
    });
  }

  static fromRow(row) {
    return new BoxState({
      id: row.id,
      imei: row.imei,
      iccid: row.iccid || "",
      imsi: row.imsi || "",
      firmware: row.firmware || "",
      org: row.org,
      owner: row.owner || "—",
      life: row.life,
      alert: row.alert || "",
      battery: row.battery || "",
      csq: Number(row.csq) || 0,
      last: row.last_report_at || "",
      lbs: row.lbs || "",
      lbsLng: BoxState.#nullable(row.lbs_lng),
      lbsLat: BoxState.#nullable(row.lbs_lat),
      gps: row.gps || "",
      gpsLng: BoxState.#nullable(row.gps_lng),
      gpsLat: BoxState.#nullable(row.gps_lat),
      opens: Number(row.opens) || 0,
      activateStep: row.activate_step,
      poweredAt: row.powered_at || "",
    });
  }

  /**
   * 刷新电压、信号和位置。
   * 生命周期不在这里改，激活和停用走管理操作。
   */
  apply(uplink, receivedAt) {
    if (uplink.iccid) this.iccid = uplink.iccid;
    if (uplink.imsi) this.imsi = uplink.imsi;
    this.csq = uplink.csq;
    this.battery = `${(uplink.vbat / 1000).toFixed(2)} V`;
    this.last = formatTimestamp(receivedAt);
    if (uplink.opens != null) this.opens = uplink.opens;
    if (uplink.hasLbs()) {
      this.lbsLng = uplink.lbsLng;
      this.lbsLat = uplink.lbsLat;
    }
    if (uplink.hasGps()) {
      this.gpsLng = uplink.gpsLng;
      this.gpsLat = uplink.gpsLat;
      if (this.gps === "未定位") this.gps = "";
    } else if (this.gpsLng == null) {
      this.gps = "未定位";
    }
    return this;
  }

  toRow() {
    return {
      id: this.id,
      imei: this.imei,
      iccid: this.iccid,
      imsi: this.imsi,
      firmware: this.firmware,
      org: this.org,
      owner: this.owner,
      life: this.life,
      alert: this.alert,
      battery: this.battery,
      csq: this.csq,
      last_report_at: this.last,
      lbs: this.lbs,
      lbs_lng: this.lbsLng,
      lbs_lat: this.lbsLat,
      gps: this.gps,
      gps_lng: this.gpsLng,
      gps_lat: this.gpsLat,
      opens: this.opens,
      activate_step: this.activateStep,
      powered_at: this.poweredAt,
    };
  }

  toJSON() {
    return {
      id: this.id,
      imei: this.imei,
      iccid: this.iccid,
      imsi: this.imsi,
      firmware: this.firmware,
      org: this.org,
      owner: this.owner,
      life: this.life,
      alert: this.alert,
      battery: this.battery,
      csq: this.csq,
      last: this.last,
      lbs: this.lbs,
      lbsLng: this.lbsLng,
      lbsLat: this.lbsLat,
      gps: this.gps,
      gpsLng: this.gpsLng,
      gpsLat: this.gpsLat,
      opens: this.opens,
      activateStep: this.activateStep,
      poweredAt: this.poweredAt,
    };
  }

  static #nullable(value) {
    if (value == null || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }
}
