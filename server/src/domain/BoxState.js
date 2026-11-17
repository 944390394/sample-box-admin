import { formatTimestamp, shiftDeviceTime } from "./Clock.js";
import { estimateBattery, observeBattery, parseBatteryModel } from "./BatteryEstimate.js";
import { currentBoxSettings } from "../settings/boxConfig.js";

/**
 * 一台采样箱的最新状态。
 * 基站和 GPS 分开保存。某一侧这次没定位时，不覆盖上一次已经拿到的坐标。
 */
export class BoxState {
  constructor(fields) {
    this.id = fields.id;
    this.imei = fields.imei;
    /** 显示名称。编号就是 IMEI，名称给人看，可以改。 */
    this.name = fields.name || "";
    this.policyPeriodSec = fields.policyPeriodSec ?? null;
    this.policyChargeOnly = fields.policyChargeOnly ?? null;
    this.iccid = fields.iccid;
    this.imsi = fields.imsi;
    this.firmware = fields.firmware;
    this.org = fields.org;
    this.orgId = fields.orgId ?? "";
    this.owner = fields.owner;
    this.ownerId = fields.ownerId ?? "";
    this.life = fields.life;
    this.alert = fields.alert;
    this.battery = fields.battery;
    this.csq = fields.csq;
    this.last = fields.last;
    this.lbs = fields.lbs;
    this.lbsLng = fields.lbsLng;
    this.lbsLat = fields.lbsLat;
    /** 基站位置最近一次更新的时间。GPS 的定位时间在 gpsInfo.at。 */
    this.lbsAt = fields.lbsAt || "";
    this.gps = fields.gps;
    this.gpsLng = fields.gpsLng;
    this.gpsLat = fields.gpsLat;
    this.opens = fields.opens;
    this.deviceOpens = fields.deviceOpens ?? null;
    this.lid = fields.lid ?? null;
    this.charge = fields.charge ?? null;
    this.unchargedAt = fields.unchargedAt || "";
    this.lastOpen = fields.lastOpen ?? "";
    this.lastPowerOff = fields.lastPowerOff ?? "";
    this.bootedAt = fields.bootedAt ?? "";
    this.lastSeq = fields.lastSeq ?? null;
    this.lbsAddress = fields.lbsAddress ?? "";
    this.gpsAddress = fields.gpsAddress ?? "";
    this.storageFree = fields.storageFree ?? null;
    this.gpsInfo = fields.gpsInfo ?? null;
    this.batteryMv = fields.batteryMv ?? null;
    this.batteryModel = fields.batteryModel ?? parseBatteryModel("");
    this.activateStep = fields.activateStep;
    this.poweredAt = fields.poweredAt;
  }

  /** 未知 IMEI 的第一包：待激活，所属总公司。密钥还没下发。编号就是 IMEI，name 是默认名称。 */
  static createPending(id, uplink, receivedAt, name = "") {
    return new BoxState({
      id,
      name,
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
      lid: null,
      charge: null,
      lastOpen: "",
      lastPowerOff: "",
      bootedAt: "",
      unchargedAt: "",
      lbsAddress: "",
      gpsAddress: "",
      storageFree: null,
      batteryMv: null,
      batteryModel: parseBatteryModel(""),
      activateStep: "等待激活",
      poweredAt: formatTimestamp(receivedAt),
    });
  }

  static fromRow(row) {
    return new BoxState({
      id: row.id,
      name: row.name || "",
      imei: row.imei,
      iccid: row.iccid || "",
      imsi: row.imsi || "",
      policyPeriodSec: row.policy_period_sec,
      policyChargeOnly: row.policy_charge_only,
      firmware: row.firmware || "",
      org: row.org,
      orgId: row.org_id == null ? "" : String(row.org_id),
      owner: row.owner || "—",
      ownerId: row.owner_id == null ? "" : String(row.owner_id),
      life: row.life,
      alert: row.alert || "",
      battery: row.battery || "",
      csq: Number(row.csq) || 0,
      last: row.last_report_at || "",
      lbs: row.lbs || "",
      lbsLng: BoxState.#nullable(row.lbs_lng),
      lbsLat: BoxState.#nullable(row.lbs_lat),
      lbsAt: row.lbs_at || "",
      gps: row.gps || "",
      gpsLng: BoxState.#nullable(row.gps_lng),
      gpsLat: BoxState.#nullable(row.gps_lat),
      opens: Number(row.opens) || 0,
      deviceOpens:
        row.device_opens == null || row.device_opens === "" ? null : Number(row.device_opens),
      lid: BoxState.#count(row.lid),
      charge: BoxState.#count(row.charge),
      lastOpen: row.last_open || "",
      lastPowerOff: row.last_power_off || "",
      bootedAt: row.booted_at || "",
      unchargedAt: row.uncharged_at || "",
      lastSeq: Number(row.report_seq) > 0 ? Number(row.report_seq) : null,
      lbsAddress: row.lbs_address || "",
      gpsAddress: row.gps_address || "",
      storageFree:
        row.storage_free == null || row.storage_free === "" ? null : Number(row.storage_free),
      gpsInfo: BoxState.#json(row.gps_info),
      batteryMv: row.battery_mv == null || row.battery_mv === "" ? null : Number(row.battery_mv),
      batteryModel: parseBatteryModel(row.battery_model),
      activateStep: row.activate_step,
      poweredAt: row.powered_at || "",
    });
  }

  /**
   * 这一包记成哪种上报，要在 apply 之前调用（拿的是这包之前的状态）。
   * 插着充电器时「充电中」和「已充满」会来回跳：模块发数据时电池电压被拉低，充电芯片又开始充，
   * 充一下又满了。这种跳动记成 chgs（充电状态），不算事件；只有插上、拔掉充电器才是 chg 事件。
   * 补传的旧记录或中间漏了序号时，不知道前一个状态，照常算事件。
   */
  kindOf(uplink) {
    if (uplink.why !== "chg") return uplink.why;
    if (this.charge == null || uplink.charge == null) return "chg";
    if (uplink.seq != null && this.lastSeq != null && uplink.seq !== this.lastSeq + 1) return "chg";
    return isPlugged(this.charge) === isPlugged(uplink.charge) ? "chgs" : "chg";
  }

  /**
   * 刷新电压、信号和位置。
   * 生命周期不在这里改，激活和停用走管理操作。
   */
  apply(uplink, receivedAt) {
    const previousLast = this.last;
    const seqRestarted = uplink.seq != null && this.lastSeq != null && uplink.seq < this.lastSeq;
    if (uplink.firmware) this.firmware = uplink.firmware;
    if (uplink.imsi) this.imsi = uplink.imsi;
    this.csq = uplink.csq;
    const validVoltage = Number.isFinite(uplink.vbat) && uplink.vbat >= 2500 && uplink.vbat <= 4500;
    if (validVoltage && (uplink.charge != null || this.batteryMv == null)) {
      this.battery = `${(uplink.vbat / 1000).toFixed(2)} V`;
    }
    this.last = formatTimestamp(receivedAt);
    if (uplink.opens != null) this.#applyOpens(uplink.opens);
    if (uplink.lid != null) this.lid = uplink.lid;
    if (uplink.charge != null) {
      const wasCharging = this.charge === 1 || this.charge === 2;
      if (wasCharging && uplink.charge === 0) this.unchargedAt = formatTimestamp(receivedAt);
      if (uplink.charge === 1 || uplink.charge === 2) this.unchargedAt = "";
      this.charge = uplink.charge;
    }
    if (validVoltage && uplink.charge != null) {
      this.batteryMv = uplink.vbat;
      this.batteryModel = observeBattery(this.batteryModel, uplink.vbat, uplink.charge);
    }
    if (
      uplink.learnFull &&
      uplink.learnEmpty &&
      uplink.learnFull - uplink.learnEmpty >= 300 &&
      uplink.learnCount
    ) {
      this.batteryModel = {
        ...this.batteryModel,
        cycles: [{ full: uplink.learnFull, empty: uplink.learnEmpty }],
        deviceCycles: uplink.learnCount,
      };
    }
    if (uplink.storageFree != null) this.storageFree = uplink.storageFree;
    if (uplink.why === "boot" || seqRestarted) {
      this.bootedAt = uplink.deviceTime || formatTimestamp(receivedAt);
    }
    if (seqRestarted && !uplink.powerOff && previousLast) this.lastPowerOff = previousLast;
    if (uplink.why === "pad" && uplink.deviceTime) this.lastOpen = uplink.deviceTime;
    if (uplink.powerOff) this.lastPowerOff = uplink.powerOff;
    if (uplink.seq != null) this.lastSeq = uplink.seq;
    if (uplink.why !== "shut" && uplink.openAge != null) {
      const lastOpen = shiftDeviceTime(uplink.deviceTime, uplink.openAge);
      if (lastOpen) this.lastOpen = lastOpen;
    }
    if (uplink.hasLbs()) {
      this.lbsLng = uplink.lbsLng;
      this.lbsLat = uplink.lbsLat;
      this.lbsAt = formatTimestamp(receivedAt);
    }
    const positionAt = uplink.gpsAt || uplink.deviceTime || formatTimestamp(receivedAt);
    if (
      uplink.hasGps() &&
      (!uplink.backfill || !this.gpsInfo?.at || positionAt >= this.gpsInfo.at)
    ) {
      this.gpsLng = uplink.gpsLng;
      this.gpsLat = uplink.gpsLat;
      // at 是这个 GPS 点的定位时间，页面据此显示「几分钟前定位」
      this.gpsInfo = { ...(uplink.gpsInfo || {}), at: positionAt };
      if (this.gps === "未定位") this.gps = "";
    } else if (this.gpsLng == null) {
      this.gps = "未定位";
    }
    return this;
  }

  toRow() {
    return {
      id: this.id,
      name: this.name,
      imei: this.imei,
      iccid: this.iccid,
      imsi: this.imsi,
      firmware: this.firmware,
      org: this.org,
      org_id: this.orgId,
      owner: this.owner,
      owner_id: this.ownerId,
      life: this.life,
      alert: this.alert,
      battery: this.battery,
      csq: this.csq,
      last_report_at: this.last,
      lbs: this.lbs,
      lbs_lng: this.lbsLng,
      lbs_lat: this.lbsLat,
      lbs_at: this.lbsAt || null,
      gps: this.gps,
      gps_lng: this.gpsLng,
      gps_lat: this.gpsLat,
      opens: this.opens,
      device_opens: this.deviceOpens,
      lid: this.lid,
      charge: this.charge,
      last_open: this.lastOpen,
      last_power_off: this.lastPowerOff,
      booted_at: this.bootedAt,
      uncharged_at: this.unchargedAt,
      report_seq: this.lastSeq || 0,
      lbs_address: this.lbsAddress,
      gps_address: this.gpsAddress,
      storage_free: this.storageFree,
      gps_info: this.gpsInfo ? JSON.stringify(this.gpsInfo) : null,
      battery_mv: this.batteryMv,
      battery_model: JSON.stringify(this.batteryModel || parseBatteryModel("")),
      activate_step: this.activateStep,
      powered_at: this.poweredAt,
    };
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name || this.id,
      imei: this.imei,
      iccid: this.iccid,
      imsi: this.imsi,
      firmware: this.firmware,
      org: this.org,
      orgId: this.orgId,
      owner: this.owner,
      ownerId: this.ownerId,
      life: this.life,
      alert: this.alert,
      battery: this.batteryMv > 0 ? `${(this.batteryMv / 1000).toFixed(2)} V` : this.battery,
      csq: this.csq,
      last: this.last,
      lbs: this.lbs,
      lbsLng: this.lbsLng,
      lbsLat: this.lbsLat,
      lbsAt: this.lbsAt,
      gps: this.gps,
      gpsLng: this.gpsLng,
      gpsLat: this.gpsLat,
      opens: this.opens,
      lid: this.lid,
      charge: this.charge,
      lastOpen: this.lastOpen,
      lastPowerOff: this.lastPowerOff,
      bootedAt: this.bootedAt,
      unchargedAt: this.unchargedAt,
      lbsAddress: this.lbsAddress,
      gpsAddress: this.gpsAddress,
      storageFree: this.storageFree,
      gpsInfo: this.gpsInfo,
      ...this.#batteryView(),
      reportPeriodSec:
        this.reportPolicy?.effective.reportPeriodSec ??
        this.policyPeriodSec ??
        currentBoxSettings().reportPeriodSec,
      reportPolicyStatus: this.reportPolicy?.status,
      wipe: this.wipe ?? null,
      reportOnlyWhenCharging:
        this.reportPolicy?.effective.reportOnlyWhenCharging ??
        (this.policyChargeOnly == null
          ? currentBoxSettings().reportOnlyWhenCharging
          : Boolean(this.policyChargeOnly)),
      activateStep: this.activateStep,
      poweredAt: this.poweredAt,
    };
  }

  /**
   * 芯片上报的是自己闪存里的次数。复位后如果比上次小，说明中间有次数没存住，累计值只加不减。
   */
  #applyOpens(reported) {
    if (this.deviceOpens == null) {
      this.deviceOpens = reported;
      if (reported > this.opens) this.opens = reported;
      return;
    }
    if (reported >= this.deviceOpens) {
      this.opens += reported - this.deviceOpens;
    }
    this.deviceOpens = reported;
  }

  #batteryView() {
    const reserve = currentBoxSettings().batteryReserve;
    const estimate = estimateBattery(this.batteryModel, this.batteryMv, reserve, this.charge);
    if (!estimate) {
      return {
        batterySoc: null,
        batteryUsable: null,
        batteryReserve: reserve,
        batteryCycles: this.batteryModel?.deviceCycles || this.batteryModel?.cycles?.length || 0,
        batteryLearned: false,
        batteryDevice: Boolean(this.batteryModel?.deviceCycles),
        batteryBasis: "rest",
      };
    }
    return {
      batterySoc: estimate.soc,
      batteryUsable: estimate.usable,
      batteryReserve: estimate.reserve,
      batteryCycles: this.batteryModel?.deviceCycles || estimate.cycles,
      batteryLearned: estimate.learned,
      batteryDevice: Boolean(this.batteryModel?.deviceCycles),
      batteryBasis: estimate.basis,
    };
  }

  /** 库里的空值表示设备还没报过，0 是有效状态。 */
  static #count(value) {
    if (value == null || value === "") return null;
    const number = Number(value);
    return Number.isInteger(number) ? number : null;
  }

  static #json(text) {
    if (!text) return null;
    try {
      const value = JSON.parse(text);
      return value && typeof value === "object" ? value : null;
    } catch {
      return null;
    }
  }

  static #nullable(value) {
    if (value == null || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }
}

/** 1 充电中、2 已充满都算插着充电器，0 是没插。 */
function isPlugged(charge) {
  return charge === 1 || charge === 2;
}
