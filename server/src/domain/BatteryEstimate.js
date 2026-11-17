/**
 * 单节锂电池只有电压和充电状态，没有电流。
 * 没在充电时，用静置电压曲线；充过电之后，用这几次高低电压把曲线两端对齐。
 * 充电时端电压会被内阻和极化抬高，同样的电压对应更低的电量，所以先减掉抬压再查静置曲线。
 * 电压顶到 4.2 V 时多半刚进恒压，电量还没满，充电中封顶；充电器报充满才记 100%。
 * 预留比例从总电量底部扣掉，剩余才是可用电量。
 */

/** 充电端电压比静置电压大约高这么多。没有电流，取固定补偿。 */
const CHARGE_LIFT_MV = 120;
/** 还在充电时不允许记满：恒流阶段最多 85%；电压到恒压段（4.18 V 以上）最多 92%，最后一段等充满指示。 */
const CHARGING_SOC_CAP = 85;
const CV_MV = 4180;
const CV_SOC_CAP = 92;
/**
 * 充满之后 TP4057 会反复补电：充满脚只亮一下，充电脚又拉低，电压仍在 4.1 V 以上。
 * 电压掉到这条线以下，才算离开充满。
 */
export const FULL_RELEASE_MV = 4100;
/** 这台充电器充满时电压停在 4.16 V 附近，到这里才记 100%。 */
const FULL_TOP_MV = 4160;
/** 电压掉到这里以下，才离开充满，改回充电曲线。 */
const FULL_CLEAR_MV = 4000;

const CURVE = [
  [4200, 100],
  [4100, 90],
  [4000, 76],
  [3900, 58],
  [3800, 40],
  [3700, 22],
  [3600, 12],
  [3500, 6],
  [3400, 1],
  [3300, 0],
];

export function createBatteryModel() {
  return { cycles: [], phase: "idle", fullMv: null, minMv: null };
}

export function voltagePercent(mv) {
  return lookup(CURVE, mv);
}

/** 充电中的电量。先去掉抬压，再封顶，避免 4.2 V 附近被当成已经充满。 */
export function chargingPercent(mv) {
  const voltage = Number(mv);
  return Math.min(
    voltagePercent(voltage - CHARGE_LIFT_MV),
    voltage >= CV_MV ? CV_SOC_CAP : CHARGING_SOC_CAP
  );
}

/**
 * 充满之后，4.16 V 记 100%，4.10 V 接上静置曲线的 90%，中间按电压走，不再整段拉平。
 */
export function fullBandPercent(mv) {
  const voltage = Number(mv);
  if (!Number.isFinite(voltage) || voltage <= FULL_RELEASE_MV) return voltagePercent(voltage);
  if (voltage >= FULL_TOP_MV) return 100;
  const floor = voltagePercent(FULL_RELEASE_MV);
  const ratio = (voltage - FULL_RELEASE_MV) / (FULL_TOP_MV - FULL_RELEASE_MV);
  return floor + ratio * (100 - floor);
}

/**
 * 曲线上的一个点。报过充满后沿电压下降，过了 4.10 V 仍用静置曲线，
 * 避免一离开门槛就改用充电曲线，从 100 掉到八十多。
 */
export function advanceSeries(state, mv, charge) {
  const voltage = Number(mv);
  if (charge === 2 || (state.full && voltage >= FULL_RELEASE_MV)) {
    state.full = true;
    state.eased = true;
    return fullBandPercent(voltage);
  }
  if (voltage <= FULL_CLEAR_MV) {
    state.full = false;
    state.eased = false;
  } else {
    state.full = false;
  }
  if (charge === 1 && !state.eased) return chargingPercent(voltage);
  return voltagePercent(voltage);
}

function lookup(curve, mv) {
  const voltage = Number(mv);
  if (!Number.isFinite(voltage)) return 0;
  if (voltage >= curve[0][0]) return curve[0][1];
  const last = curve[curve.length - 1];
  if (voltage <= last[0]) return last[1];
  for (let index = 0; index < curve.length - 1; index += 1) {
    const [highMv, highPercent] = curve[index];
    const [lowMv, lowPercent] = curve[index + 1];
    if (voltage <= highMv && voltage >= lowMv) {
      const span = highMv - lowMv;
      const ratio = span === 0 ? 0 : (voltage - lowMv) / span;
      return lowPercent + ratio * (highPercent - lowPercent);
    }
  }
  return 0;
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

function clamp(value) {
  return Math.min(100, Math.max(0, value));
}

export function parseBatteryModel(text) {
  if (!text) return createBatteryModel();
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return createBatteryModel();
    return {
      cycles: Array.isArray(parsed.cycles) ? parsed.cycles : [],
      phase: parsed.phase || "idle",
      fullMv: Number.isFinite(Number(parsed.fullMv)) ? Number(parsed.fullMv) : null,
      minMv: Number.isFinite(Number(parsed.minMv)) ? Number(parsed.minMv) : null,
      deviceCycles: Number.isInteger(parsed.deviceCycles) ? parsed.deviceCycles : 0,
    };
  } catch {
    return createBatteryModel();
  }
}

/** 充满后再放电，直到再次插上充电器，记成一次完整循环。压差不到 0.3 V 的不算。 */
export function observeBattery(model, mv, charge) {
  const next = {
    cycles: Array.isArray(model?.cycles) ? model.cycles.slice(-7) : [],
    phase: model?.phase || "idle",
    fullMv: model?.fullMv ?? null,
    minMv: model?.minMv ?? null,
  };
  const voltage = Number(mv);
  if (!Number.isFinite(voltage) || voltage <= 0 || charge == null) return next;
  if (charge === 2) {
    next.phase = "full";
    next.fullMv = voltage;
    next.minMv = voltage;
    return next;
  }
  if (next.phase === "full" && voltage > FULL_CLEAR_MV) {
    return next;
  }
  if (next.phase === "full" && charge === 0) {
    next.phase = "down";
    next.minMv = voltage;
    return next;
  }
  if (next.phase === "full") {
    next.phase = "idle";
    next.fullMv = null;
    next.minMv = null;
    return next;
  }
  if (next.phase === "down" && charge === 0) {
    next.minMv = Math.min(next.minMv ?? voltage, voltage);
    return next;
  }
  if (next.phase === "down" && charge === 1) {
    if (next.fullMv != null && next.minMv != null && next.fullMv - next.minMv >= 300) {
      next.cycles = [...next.cycles, { full: next.fullMv, empty: next.minMv }].slice(-8);
    }
    next.phase = "idle";
    next.fullMv = null;
    next.minMv = null;
  }
  return next;
}

/**
 * 学过充放电循环后，把按电压算出的电量按这几次的满电、放空电压重新拉伸。
 * 页头、曲线、列表都走这里，三处数字一致。
 */
export function learnedScale(model, percent) {
  // Plugging back in midway through discharge does not establish an empty
  // endpoint. Only calibrate with observations in the top and bottom bands.
  const cycles = calibrationCycles(model);
  if (!cycles.length) return percent;
  const high = voltagePercent(median(cycles.map((item) => item.full)));
  const low = voltagePercent(median(cycles.map((item) => item.empty)));
  if (high <= low) return percent;
  return clamp(((percent - low) / (high - low)) * 100);
}

function calibrationCycles(model) {
  return (Array.isArray(model?.cycles) ? model.cycles : []).filter(
    (c) => c && c.full >= FULL_RELEASE_MV && c.full <= 4250 && c.empty >= 2500 && c.empty <= 3500
  );
}

/** 曲线上一个点的电量：先按充电状态（充满、充电中、静置）算，再按学到的循环拉伸。 */
export function samplePercent(model, state, mv, charge) {
  return learnedScale(model, advanceSeries(state, mv, charge));
}

export function estimateBattery(model, mv, reserve = 20, charge = null) {
  const voltage = Number(mv);
  if (!Number.isFinite(voltage) || voltage <= 0) return null;
  const cycles = Array.isArray(model?.cycles) ? model.cycles : [];
  // 和曲线同一套：充电状态决定按哪条线算，学过循环再拉伸
  const state = { full: model?.phase === "full", eased: model?.phase === "full" };
  const base = advanceSeries(state, voltage, charge);
  let basis = "rest";
  if (state.full) basis = "full";
  else if (charge === 1 && !state.eased) basis = "charge";
  const learned = calibrationCycles(model).length > 0;
  if (learned) basis = "learned";
  const soc = clamp(learnedScale(model, base));
  const floor = clamp(Number.isFinite(Number(reserve)) ? Number(reserve) : 20);
  const usable = soc <= floor ? 0 : ((soc - floor) / (100 - floor)) * 100;
  return {
    soc: Math.round(soc),
    usable: Math.round(usable),
    reserve: Math.round(floor),
    cycles: model?.deviceCycles || cycles.length,
    learned,
    basis,
  };
}
