export type BoxLife = "待激活" | "未使用" | "在途" | "停用";
export type ActivateStep = "等待激活" | "待设备确认" | "已确认";

export interface SampleBox {
  id: string;
  imei: string;
  iccid: string;
  imsi: string;
  firmware: string;
  org: string;
  owner: string;
  life: BoxLife;
  /** 与 life 同步，供仍读取 status 的页面使用 */
  status: BoxLife;
  /** 空字符串表示没有异常。异常不是库存状态。 */
  alert: string;
  battery: string;
  csq: number;
  last: string;
  /** 基站地名。没有基站坐标时为空。 */
  lbs: string;
  lbsLng: number | null;
  lbsLat: number | null;
  /** 有坐标时是地名；上报过但未定位时为「未定位」；没有上报时为空。 */
  gps: string;
  gpsLng: number | null;
  gpsLat: number | null;
  opens: number;
  activateStep: ActivateStep;
  poweredAt: string;
}

export const boxes: SampleBox[] = [
  {
    id: "BOX-001",
    imei: "864317080992517",
    iccid: "898608911026D0279998",
    imsi: "460130610629998",
    firmware: "V1.1.13",
    org: "总公司",
    owner: "林夏",
    life: "在途",
    status: "在途",
    alert: "",
    battery: "3.76 V",
    csq: 19,
    last: "17:11:27",
    lbs: "深圳",
    lbsLng: 114.117201,
    lbsLat: 22.679073,
    gps: "未定位",
    gpsLng: null,
    gpsLat: null,
    opens: 1,
    activateStep: "已确认",
    poweredAt: "09-26 09:10",
  },
  {
    id: "BOX-002",
    imei: "864317080992208",
    iccid: "898608911026D0279208",
    imsi: "460130610629208",
    firmware: "V1.1.13",
    org: "总公司",
    owner: "未授权人员",
    life: "在途",
    status: "在途",
    alert: "开箱过多、非授权",
    battery: "3.71 V",
    csq: 16,
    last: "16:40:02",
    lbs: "广州",
    lbsLng: 113.2644,
    lbsLat: 23.1291,
    gps: "未定位",
    gpsLng: null,
    gpsLat: null,
    opens: 3,
    activateStep: "已确认",
    poweredAt: "09-20 08:12",
  },
  {
    id: "BOX-003",
    imei: "864317080991774",
    iccid: "898608911026D0271774",
    imsi: "460130610621774",
    firmware: "V1.1.13",
    org: "总公司",
    owner: "赵衡",
    life: "在途",
    status: "在途",
    alert: "封箱后再开、地点偏离",
    battery: "3.68 V",
    csq: 21,
    last: "15:02:18",
    lbs: "杭州",
    lbsLng: 120.15,
    lbsLat: 30.28,
    gps: "杭州",
    gpsLng: 120.1551,
    gpsLat: 30.2741,
    opens: 2,
    activateStep: "已确认",
    poweredAt: "09-18 10:04",
  },
  {
    id: "BOX-004",
    imei: "864317080990331",
    iccid: "898608911026D0270331",
    imsi: "460130610620331",
    firmware: "V1.1.13",
    org: "总公司",
    owner: "—",
    life: "未使用",
    status: "未使用",
    alert: "",
    battery: "3.81 V",
    csq: 0,
    last: "09-25 18:00",
    lbs: "",
    lbsLng: null,
    lbsLat: null,
    gps: "",
    gpsLng: null,
    gpsLat: null,
    opens: 0,
    activateStep: "已确认",
    poweredAt: "09-12 11:20",
  },
  {
    id: "BOX-005",
    imei: "864317081000105",
    iccid: "898608911026D0280105",
    imsi: "460130610630105",
    firmware: "V1.1.14",
    org: "总公司",
    owner: "—",
    life: "待激活",
    status: "待激活",
    alert: "",
    battery: "3.82 V",
    csq: 18,
    last: "14:22:06",
    lbs: "",
    lbsLng: null,
    lbsLat: null,
    gps: "",
    gpsLng: null,
    gpsLat: null,
    opens: 0,
    activateStep: "等待激活",
    poweredAt: "09-28 14:22:06",
  },
  {
    id: "BOX-006",
    imei: "864317081000206",
    iccid: "898608911026D0280206",
    imsi: "460130610630206",
    firmware: "V1.1.13",
    org: "总公司",
    owner: "—",
    life: "停用",
    status: "停用",
    alert: "",
    battery: "3.79 V",
    csq: 0,
    last: "09-22 16:40",
    lbs: "",
    lbsLng: null,
    lbsLat: null,
    gps: "",
    gpsLng: null,
    gpsLat: null,
    opens: 0,
    activateStep: "已确认",
    poweredAt: "09-08 09:30",
  },
];

export function coordText(lng: number | null, lat: number | null) {
  if (lng == null || lat == null) return "";
  return `${lng.toFixed(7)}, ${lat.toFixed(7)}`;
}

export function lbsText(box: Pick<SampleBox, "lbs" | "lbsLng" | "lbsLat">) {
  const coord = coordText(box.lbsLng, box.lbsLat);
  if (!coord) return "—";
  return box.lbs ? `${box.lbs} · ${coord}` : coord;
}

export function gpsText(box: Pick<SampleBox, "gps" | "gpsLng" | "gpsLat">) {
  const coord = coordText(box.gpsLng, box.gpsLat);
  if (!coord) return box.gps || "—";
  return box.gps ? `${box.gps} · ${coord}` : coord;
}

/** 地图落点优先用 GPS，没有 GPS 时用基站。 */
export function mapCoord(box: Pick<SampleBox, "gpsLng" | "gpsLat" | "lbsLng" | "lbsLat">) {
  if (box.gpsLng != null && box.gpsLat != null) return { lng: box.gpsLng, lat: box.gpsLat };
  if (box.lbsLng != null && box.lbsLat != null) return { lng: box.lbsLng, lat: box.lbsLat };
  return null;
}

function shortCoord(kind: string, lng: number | null, lat: number | null) {
  if (lng == null || lat == null) return "";
  return `${kind} ${lng.toFixed(4)}, ${lat.toFixed(4)}`;
}

/** 首页短地点。同名只写地名；只有基站地名写「地名 · GPS 未定位」；有坐标没地名写「基站/GPS + 短坐标」；两边都没有坐标才写「未定位」。 */
export function placeShort(
  box: Pick<SampleBox, "lbs" | "lbsLng" | "lbsLat" | "gps" | "gpsLng" | "gpsLat">
) {
  const lbsCoord = coordText(box.lbsLng, box.lbsLat);
  const gpsCoord = coordText(box.gpsLng, box.gpsLat);
  const lbsName = box.lbs && lbsCoord ? box.lbs : "";
  const gpsName = box.gps && box.gps !== "未定位" && gpsCoord ? box.gps : "";
  if (lbsName && gpsName) return lbsName === gpsName ? lbsName : `${lbsName} · ${gpsName}`;
  if (lbsName && !gpsCoord) return `${lbsName} · GPS 未定位`;
  if (gpsName) return gpsName;
  if (lbsName) return lbsName;
  return (
    shortCoord("基站", box.lbsLng, box.lbsLat) ||
    shortCoord("GPS", box.gpsLng, box.gpsLat) ||
    "未定位"
  );
}

export function placeTitle(
  box: Pick<SampleBox, "lbs" | "lbsLng" | "lbsLat" | "gps" | "gpsLng" | "gpsLat">
) {
  return `基站 ${lbsText(box)}；GPS ${gpsText(box)}`;
}

export function hasFix(box: Pick<SampleBox, "lbsLng" | "lbsLat" | "gpsLng" | "gpsLat">) {
  return (box.lbsLng != null && box.lbsLat != null) || (box.gpsLng != null && box.gpsLat != null);
}

export function conditionText(box: Pick<SampleBox, "csq" | "battery">) {
  return `${box.csq} · ${box.battery}`;
}

/** 与采样箱清单相同：待激活在前，有异常其次，其余按最后上报从新到旧。 */
export function compareBoxes(
  a: Pick<SampleBox, "life" | "alert" | "last">,
  b: Pick<SampleBox, "life" | "alert" | "last">
) {
  const pending = Number(b.life === "待激活") - Number(a.life === "待激活");
  if (pending) return pending;
  const alerted = Number(Boolean(b.alert)) - Number(Boolean(a.alert));
  if (alerted) return alerted;
  if (a.last === b.last) return 0;
  return a.last < b.last ? 1 : -1;
}

export function shortStamp(value: string) {
  const full = value.match(/^(\d{4})-(\d{2}-\d{2})[ T](\d{2}:\d{2})/);
  if (full) return `${full[2]} ${full[3]}`;
  const md = value.match(/^(\d{2}-\d{2} \d{2}:\d{2})/);
  if (md) return md[1];
  const hm = value.match(/^(\d{2}:\d{2})/);
  if (hm) return hm[1];
  return value || "—";
}

export const tasks = [
  {
    no: "RW-202609-014",
    name: "华南水质复测",
    org: "华南分公司",
    box: "BOX-001",
    place: "深圳南山水厂",
    people: "林夏",
    interval: "5 分钟",
    status: "采样中",
  },
  {
    no: "RW-202609-012",
    name: "广州管网抽检",
    org: "华南分公司",
    box: "BOX-002",
    place: "广州天河",
    people: "未授权人员",
    interval: "5 分钟",
    status: "采样中",
  },
  {
    no: "RW-202609-011",
    name: "城东管网抽检",
    org: "华东分公司",
    box: "BOX-003",
    place: "杭州余杭",
    people: "赵衡",
    interval: "10 分钟",
    status: "待核验",
  },
  {
    no: "RW-202609-008",
    name: "备用箱巡检",
    org: "西南分公司",
    box: "未绑定",
    place: "成都高新",
    people: "待分配",
    interval: "5 分钟",
    status: "待采样",
  },
];

/** 已经结束、不再出现在任务单列表里的历史绑定。 */
export const boxTaskHistory = [
  {
    no: "RW-202608-006",
    name: "南山管网抽检",
    org: "华南分公司",
    box: "BOX-001",
    place: "深圳南山",
    people: "林夏",
    interval: "5 分钟",
    status: "已签收",
  },
];

export interface BoxLog {
  box: string;
  /** 服务器收到或写入这条日志的时间 */
  time: string;
  text: string;
  by: string;
  /** 设备上报的原始 JSON。管理操作没有这一项。 */
  raw?: string;
}

function padDeg(value: number) {
  const negative = value < 0;
  const [whole, frac] = Math.abs(value).toFixed(7).split(".");
  return `${negative ? "-" : ""}${whole.padStart(3, "0")}.${frac}`;
}

function uplinkRaw(box: SampleBox, when: string, uart: string, gps?: { lng: number; lat: number }) {
  const ms = Date.parse(`${when.replace(" ", "T")}+08:00`);
  const body: Record<string, string | number> = {
    uarthex: [...uart]
      .map((ch) => ch.charCodeAt(0).toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase(),
    uart,
    lbslat: box.lbsLat == null ? "000.0000000" : padDeg(box.lbsLat),
    gpsfix: gps ? 1 : 0,
    lbslng: box.lbsLng == null ? "000.0000000" : padDeg(box.lbsLng),
    imsi: box.imsi,
    timem: `${Math.floor(ms / 1000)}000`,
    iccid: box.iccid,
    time: when,
    csq: box.csq,
    vbat: Math.round(Number.parseFloat(box.battery) * 1000),
    imei: box.imei,
  };
  if (gps) {
    body.lng = padDeg(gps.lng);
    body.lat = padDeg(gps.lat);
    body.speed = 0;
  }
  return JSON.stringify(body);
}

function bootUart(box: SampleBox) {
  if (box.lbsLng == null || box.lbsLat == null) return "why=boot,aa55=0";
  return `why=boot,aa55=0,lbs=now,lng=${padDeg(box.lbsLng)},lat=${padDeg(box.lbsLat)}`;
}

const boxLogSeed: BoxLog[] = [
  { box: "BOX-001", time: "2026-09-28 17:11:27", text: "定时上报", by: "设备" },
  { box: "BOX-002", time: "2026-09-28 16:40:02", text: "开箱上报", by: "设备" },
  { box: "BOX-003", time: "2026-09-28 15:02:18", text: "开箱上报", by: "设备" },
  { box: "BOX-005", time: "2026-09-28 14:22:06", text: "上电上报身份，请求设备密钥", by: "设备" },
  {
    box: "BOX-001",
    time: "2026-09-26 09:21:00",
    text: "箱子确认已保存密钥，状态改为未使用",
    by: "设备",
  },
  {
    box: "BOX-001",
    time: "2026-09-26 09:18:00",
    text: "管理员确认激活，设备密钥已下发",
    by: "周宁",
  },
  { box: "BOX-001", time: "2026-09-26 09:10:00", text: "上电上报身份，请求设备密钥", by: "设备" },
  {
    box: "BOX-002",
    time: "2026-09-20 08:40:00",
    text: "箱子确认已保存密钥，状态改为未使用",
    by: "设备",
  },
  {
    box: "BOX-002",
    time: "2026-09-20 08:16:00",
    text: "管理员确认激活，设备密钥已下发",
    by: "周宁",
  },
  { box: "BOX-002", time: "2026-09-20 08:12:00", text: "上电上报身份，请求设备密钥", by: "设备" },
  {
    box: "BOX-003",
    time: "2026-09-18 10:30:00",
    text: "箱子确认已保存密钥，状态改为未使用",
    by: "设备",
  },
  {
    box: "BOX-003",
    time: "2026-09-18 10:08:00",
    text: "管理员确认激活，设备密钥已下发",
    by: "周宁",
  },
  { box: "BOX-003", time: "2026-09-18 10:04:00", text: "上电上报身份，请求设备密钥", by: "设备" },
  { box: "BOX-006", time: "2026-09-22 16:40:00", text: "管理员停用，不能再绑定新任务", by: "周宁" },
  {
    box: "BOX-004",
    time: "2026-09-12 11:36:00",
    text: "箱子确认已保存密钥，状态改为未使用",
    by: "设备",
  },
  {
    box: "BOX-004",
    time: "2026-09-12 11:24:00",
    text: "管理员确认激活，设备密钥已下发",
    by: "周宁",
  },
  { box: "BOX-004", time: "2026-09-12 11:20:00", text: "上电上报身份，请求设备密钥", by: "设备" },
  {
    box: "BOX-006",
    time: "2026-09-08 09:48:00",
    text: "箱子确认已保存密钥，状态改为未使用",
    by: "设备",
  },
  {
    box: "BOX-006",
    time: "2026-09-08 09:34:00",
    text: "管理员确认激活，设备密钥已下发",
    by: "周宁",
  },
  { box: "BOX-006", time: "2026-09-08 09:30:00", text: "上电上报身份，请求设备密钥", by: "设备" },
];

function reportUart(box: SampleBox, kind: "timer" | "pad", opens: number) {
  const where =
    box.lbsLng == null || box.lbsLat == null
      ? ""
      : `,lbs=now,lng=${padDeg(box.lbsLng)},lat=${padDeg(box.lbsLat)}`;
  if (kind === "timer") return `why=timer,aa55=0${where}`;
  return `why=pad,aa55=1,opens=${opens}${where}`;
}

export const boxLogs: BoxLog[] = boxLogSeed.map((item) => {
  const box = boxes.find((row) => row.id === item.box);
  if (!box || item.by !== "设备") return item;
  if (item.text.startsWith("上电"))
    return { ...item, raw: uplinkRaw(box, item.time, bootUart(box)) };
  if (item.text === "定时上报")
    return { ...item, raw: uplinkRaw(box, item.time, reportUart(box, "timer", box.opens)) };
  if (item.text === "开箱上报") {
    const gps =
      box.gpsLng != null && box.gpsLat != null ? { lng: box.gpsLng, lat: box.gpsLat } : undefined;
    return { ...item, raw: uplinkRaw(box, item.time, reportUart(box, "pad", box.opens), gps) };
  }
  return item;
});

export const BOX_PERM = {
  detail: "device:box:detail",
  event: "device:box:event",
  log: "device:box:log",
  task: "device:box:task",
  activate: "device:box:activate",
  disable: "device:box:disable",
} as const;

export const reports = [
  {
    time: "17:11:27",
    box: "BOX-001",
    event: "心跳",
    person: "—",
    gps: "未定位",
    lbs: "114.1172010, 22.6790730",
    opens: 1,
  },
  {
    time: "16:40:02",
    box: "BOX-002",
    event: "开箱",
    person: "未授权人员",
    gps: "未定位",
    lbs: "113.2644000, 23.1291000",
    opens: 3,
  },
  {
    time: "15:02:18",
    box: "BOX-003",
    event: "开箱",
    person: "赵衡",
    gps: "120.1551000, 30.2741000",
    lbs: "120.1500000, 30.2800000",
    opens: 2,
  },
];

export const alerts = [
  {
    level: "高",
    rule: "开箱超过 2 次",
    box: "BOX-002",
    detail: "本任务已开箱 3 次",
    time: "16:40:02",
  },
  {
    level: "高",
    rule: "非授权人员",
    box: "BOX-002",
    detail: "开箱人不在任务授权名单",
    time: "16:40:02",
  },
  {
    level: "高",
    rule: "封箱后再开",
    box: "BOX-003",
    detail: "封箱后再次检测到开箱",
    time: "15:02:18",
  },
  {
    level: "中",
    rule: "非计划地点",
    box: "BOX-003",
    detail: "基站位置偏离计划采样点",
    time: "15:02:18",
  },
];

export const commands = [
  { time: "16:50:00", box: "BOX-002", cmd: "结束采样", by: "陈可", status: "待设备上线" },
  { time: "16:12:00", box: "BOX-001", cmd: "上报间隔改为 5 分钟", by: "周宁", status: "已下发" },
  { time: "09:00:00", box: "BOX-004", cmd: "复位", by: "吴迪", status: "设备已确认" },
];

export const staff = [
  { name: "系统管理员", account: "admin", role: "系统管理员", org: "系统管理", status: "启用" },
  { name: "周宁", account: "zhou.ning", role: "资产管理员", org: "资产管理", status: "启用" },
  { name: "吴迪", account: "wu.di", role: "核验员", org: "核验中心", status: "启用" },
  { name: "陈可", account: "chen.ke", role: "调度员", org: "华南分公司调度室", status: "启用" },
  { name: "林夏", account: "lin.xia", role: "现场采样员", org: "采样机构甲", status: "启用" },
  { name: "赵衡", account: "zhao.heng", role: "现场采样员", org: "采样机构乙", status: "停用" },
];
