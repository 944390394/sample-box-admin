/**
 * 一包已经拆开的设备上报。
 * raw 保留设备发来的原始 JSON，后续日志直接存这串文本。
 */
export class Uplink {
  constructor(fields) {
    this.imei = fields.imei;
    this.scheduled = fields.scheduled === true;
    this.policyVersion = fields.policyVersion;
    this.reportPeriodSec = fields.reportPeriodSec;
    this.reportCharging = fields.reportCharging;
    this.iccid = fields.iccid;
    this.imsi = fields.imsi;
    this.csq = fields.csq;
    this.vbat = fields.vbat;
    this.deviceTime = fields.deviceTime;
    this.why = fields.why;
    this.opens = fields.opens;
    this.lid = fields.lid;
    this.openAge = fields.openAge;
    this.charge = fields.charge;
    this.powerOff = fields.powerOff || "";
    this.storageFree = fields.storageFree ?? null;
    this.firmware = fields.firmware || "";
    this.seq = fields.seq ?? null;
    this.dump = fields.dump ?? null;
    /** 离线队列的存储序号和队列代号，1.0.9 起每条上报都带，用于累计确认和去重。 */
    this.q = fields.q ?? null;
    this.qe = fields.qe ?? null;
    /** 开机后第一行带：q 在 (qz, 本行 q) 之间的编号是固件故意跳过的，根本不存在。 */
    this.qz = fields.qz ?? null;
    /** 联网判断来源：1 来自模块发来的 net= 行，0 来自 RDY 引脚，旧固件没有。 */
    this.netLink = fields.netLink ?? null;
    this.learnFull = fields.learnFull ?? null;
    this.learnEmpty = fields.learnEmpty ?? null;
    this.learnCount = fields.learnCount ?? null;
    this.gpsfix = fields.gpsfix;
    this.lbsLng = fields.lbsLng;
    this.lbsLat = fields.lbsLat;
    this.gpsLng = fields.gpsLng;
    this.gpsLat = fields.gpsLat;
    /** 定位时模块额外给的：speed、course、alt、sats、hdop、time。没定位或旧模板时为 null。 */
    this.gpsInfo = fields.gpsInfo ?? null;
    /** GPS 坐标是模块缓存的上次定位时，这是那次定位的时间；此刻定位的为空串。 */
    this.gpsAt = fields.gpsAt || "";
    /** 固件 1.0.15 起，从闪存队列补发的行带 bf=1：这条当时没能实时送到（离线或没等到确认）。 */
    this.backfill = Boolean(fields.backfill);
    this.raw = fields.raw;
  }

  /** 给人看的日志摘要，和详情页里的上报类型一致。 */
  get label() {
    if (this.why === "boot") return "上电上报";
    if (this.why === "timer") return "定时上报";
    if (this.why === "pad") return "开箱上报";
    if (this.why === "shut") return "关箱上报";
    if (this.why === "chg") return "充电上报";
    return "设备上报";
  }

  /** 列表上能直接看的内容。类型名仍用 label。 */
  get digest() {
    return this.digestAs(this.label);
  }

  /** 换一个类型名的摘要：充电中、已充满来回跳的那种充电上报记成「充电状态」。 */
  digestAs(label) {
    const parts = [label];
    if (this.seq != null) parts.push(`seq ${this.seq}`);
    if (this.vbat > 0) parts.push(`${(this.vbat / 1000).toFixed(2)} V`);
    if (this.lid === 1) parts.push("开着");
    else if (this.lid === 0) parts.push("关着");
    if (this.backfill) parts.push("补传");
    return parts.join(" · ");
  }

  hasLbs() {
    return this.lbsLng != null && this.lbsLat != null;
  }

  hasGps() {
    return this.gpsfix === 1 && this.gpsLng != null && this.gpsLat != null;
  }
}
