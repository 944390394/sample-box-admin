/**
 * 一包已经拆开的设备上报。
 * raw 保留设备发来的原始 JSON，后续日志直接存这串文本。
 */
export class Uplink {
  constructor(fields) {
    this.imei = fields.imei;
    this.iccid = fields.iccid;
    this.imsi = fields.imsi;
    this.csq = fields.csq;
    this.vbat = fields.vbat;
    this.deviceTime = fields.deviceTime;
    this.why = fields.why;
    this.opens = fields.opens;
    this.gpsfix = fields.gpsfix;
    this.lbsLng = fields.lbsLng;
    this.lbsLat = fields.lbsLat;
    this.gpsLng = fields.gpsLng;
    this.gpsLat = fields.gpsLat;
    this.raw = fields.raw;
  }

  /** 给人看的日志摘要，和详情页里的上报类型一致。 */
  get label() {
    if (this.why === "boot") return "上电上报";
    if (this.why === "timer") return "定时上报";
    if (this.why === "pad") return "开箱上报";
    return "设备上报";
  }

  hasLbs() {
    return this.lbsLng != null && this.lbsLat != null;
  }

  hasGps() {
    return this.gpsfix === 1 && this.gpsLng != null && this.gpsLat != null;
  }
}
