import type { BoxLogItem } from "@/api/sample/box";
import {
  alerts,
  boxLogs,
  boxTaskHistory,
  compareBoxes,
  conditionText,
  hasFix,
  placeShort,
  placeTitle,
  shortStamp,
  staff,
  tasks,
  type BoxLife,
  type SampleBox,
} from "../data";

export type HomeRole = "asset" | "duty" | "dispatch" | "verify" | "leader" | "field";

export const HOME_VIEWS: { id: HomeRole; label: string }[] = [
  { id: "asset", label: "资产台" },
  { id: "duty", label: "值班台" },
  { id: "verify", label: "核验台" },
  { id: "dispatch", label: "调度台" },
  { id: "leader", label: "总览台" },
  { id: "field", label: "现场台" },
];

export const HOME_SWITCH_PERM = "monitor:home:switch";
export const HOME_SWITCH_ROLE = "HOME_SWITCH";

export function canSwitchHome(roles: string[] = [], perms: string[] = []) {
  return roles.includes(HOME_SWITCH_ROLE) || perms.includes(HOME_SWITCH_PERM);
}

const HOME_ORDER: { role: HomeRole; codes: string[] }[] = [
  { role: "asset", codes: ["ADMIN", "ASSET"] },
  { role: "duty", codes: ["DUTY"] },
  { role: "verify", codes: ["VERIFY"] },
  { role: "dispatch", codes: ["DISPATCH"] },
  { role: "leader", codes: ["LEADER"] },
  { role: "field", codes: ["BRANCH_ADMIN", "AGENCY_LEAD", "SAMPLER"] },
];

/** 多角色时按资产、值班、核验、调度、总览、现场取第一种。视角切换不改变默认首页。 */
export function pickHome(roles: string[] = [], perms: string[] = []): HomeRole {
  for (const item of HOME_ORDER) {
    if (item.codes.some((code) => roles.includes(code))) return item.role;
  }
  if (perms.some((perm) => perm.startsWith("device:box:"))) return "duty";
  return "field";
}

export function lifeCounts(boxList: SampleBox[]) {
  return {
    在途: boxList.filter((box) => box.life === "在途").length,
    未使用: boxList.filter((box) => box.life === "未使用").length,
    停用: boxList.filter((box) => box.life === "停用").length,
    待激活: boxList.filter((box) => box.life === "待激活").length,
  };
}

export const LIFE_ORDER: BoxLife[] = ["在途", "未使用", "停用", "待激活"];

export function lifeClass(life: BoxLife) {
  if (life === "在途") return "primary";
  if (life === "未使用") return "success";
  if (life === "待激活") return "warning";
  return "info";
}

export function rowAction(box: SampleBox, role: "asset" | "duty") {
  if (role === "duty") return box.life === "待激活" ? "去处理" : "查看";
  return box.life === "待激活" || box.life === "停用" ? "去处理" : "查看";
}

export function splitDuty(boxList: SampleBox[]) {
  const ordered = [...boxList].sort(compareBoxes);
  const pending = ordered.filter(
    (box) => box.life === "待激活" || Boolean(box.alert) || (box.life === "在途" && !hasFix(box))
  );
  const rest = ordered.filter((box) => !pending.includes(box));
  return { pending, rest };
}

export interface HomeFeed {
  key: string;
  date: string;
  time: string;
  full: string;
  box: string;
  kind: string;
  where: string;
  title: string;
}

export function reportKind(text: string, kind = "") {
  if (kind === "boot" || text.includes("上电")) return "上线";
  if (kind === "pad" || text.includes("开箱")) return "开箱";
  if (kind === "timer" || text.includes("定时") || text === "心跳") return "心跳";
  return text || "上报";
}

function stampParts(value: string) {
  const full = value.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (full) return { date: `${full[2]}-${full[3]}`, time: `${full[4]}:${full[5]}` };
  const md = value.match(/^(\d{2}-\d{2}) (\d{2}:\d{2})/);
  if (md) return { date: md[1], time: md[2] };
  const hm = value.match(/^(\d{2}:\d{2})/);
  if (hm) return { date: "", time: hm[1] };
  return { date: "", time: shortStamp(value) };
}

interface FeedSource {
  box: string;
  time: string;
  text: string;
  kind?: string;
  lbsLng?: number | null;
  lbsLat?: number | null;
  gpsLng?: number | null;
  gpsLat?: number | null;
}

function feedPlace(row: FeedSource, box?: SampleBox) {
  const explicit = "lbsLng" in row;
  if (!explicit) {
    if (!box || !hasFix(box)) return { where: "未定位", title: "未定位" };
    return { where: placeShort(box), title: placeTitle(box) };
  }
  const own = {
    lbs: "",
    lbsLng: row.lbsLng ?? null,
    lbsLat: row.lbsLat ?? null,
    gps: row.gpsLng != null && row.gpsLat != null ? "" : "未定位",
    gpsLng: row.gpsLng ?? null,
    gpsLat: row.gpsLat ?? null,
  };
  const ownText = placeShort(own);
  if (ownText === "未定位") return { where: "未定位", title: "未定位" };
  if (box) {
    const short = placeShort(box);
    if (short !== "未定位") return { where: short, title: placeTitle(box) };
  }
  return { where: ownText, title: placeTitle(own) };
}

export function buildFeed(rows: FeedSource[], boxList: SampleBox[]) {
  return [...rows]
    .sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0))
    .slice(0, 30)
    .map((row, index) => {
      const box = boxList.find((item) => item.id === row.box);
      const when = stampParts(row.time);
      const place = feedPlace(row, box);
      return {
        key: `${row.time}-${row.box}-${index}`,
        date: when.date,
        time: when.time,
        full: row.time,
        box: row.box,
        kind: reportKind(row.text, row.kind),
        where: place.where,
        title: place.title,
      } satisfies HomeFeed;
    });
}

export function demoReportRows(
  logs: { box: string; time: string; text: string; by: string }[] = boxLogs
): FeedSource[] {
  return logs
    .filter((item) => item.by === "设备" && /上电|定时上报|开箱上报/.test(item.text))
    .map((item) => ({ box: item.box, time: item.time, text: item.text }));
}

export function serverReportRows(rows: BoxLogItem[]): FeedSource[] {
  return rows.map((item) => ({
    box: item.box,
    time: item.time,
    text: item.text,
    kind: item.kind,
    lbsLng: item.lbsLng,
    lbsLat: item.lbsLat,
    gpsLng: item.gpsLng,
    gpsLat: item.gpsLat,
  }));
}

export function freshOf(feed: HomeFeed[]) {
  const row = feed[0];
  if (!row) return { short: "", full: "" };
  return { short: [row.date, row.time].filter(Boolean).join(" "), full: row.full };
}

export function dispatchBranch(username: string) {
  const person = staff.find((item) => item.account === username);
  return person?.org.match(/^.+分公司/)?.[0] || "";
}

export interface HomeTrip {
  box: string;
  task: string;
  person: string;
  plan: string;
  cond: string;
  where: string;
  whereTitle: string;
  alert: string;
}

export interface HomeAlert {
  level: string;
  rule: string;
  box: string;
  detail: string;
}

export function buildDispatch(boxList: SampleBox[], serverMode: boolean, branch: string) {
  let scope: SampleBox[];
  const taskOf = new Map<string, { name: string; people: string; place: string }>();
  if (serverMode) {
    scope = boxList.filter((box) => box.life === "在途" || box.life === "未使用");
  } else {
    const linked = tasks.filter(
      (task) => task.org === branch && boxList.some((box) => box.id === task.box)
    );
    const ids = new Set(linked.map((task) => task.box));
    scope = boxList.filter((box) => ids.has(box.id));
    for (const task of linked) {
      if (task.status === "已签收" || taskOf.has(task.box)) continue;
      taskOf.set(task.box, { name: task.name, people: task.people, place: task.place });
    }
  }
  const trips: HomeTrip[] = scope
    .filter((box) => box.life === "在途")
    .sort(compareBoxes)
    .map((box) => {
      const task = taskOf.get(box.id);
      return {
        box: box.id,
        task: task?.name || "",
        person: task?.people || (box.owner && box.owner !== "—" ? box.owner : ""),
        plan: task?.place || "",
        cond: conditionText(box),
        where: placeShort(box),
        whereTitle: placeTitle(box),
        alert: box.alert,
      };
    });
  const unused = scope.filter((box) => box.life === "未使用").sort(compareBoxes);
  const tripIds = new Set(trips.map((trip) => trip.box));
  const alertRows: HomeAlert[] = serverMode
    ? trips
        .filter((trip) => trip.alert)
        .map((trip) => ({ level: "", rule: trip.alert, box: trip.box, detail: "" }))
    : alerts
        .filter((item) => tripIds.has(item.box))
        .map((item) => ({
          level: item.level,
          rule: item.rule,
          box: item.box,
          detail: item.detail,
        }));
  return { scope, trips, unused, alerts: alertRows };
}

export interface VerifyItem {
  id: string;
  box: string;
  queue: "待核验" | "采样中" | "在途";
  task: string;
  alert: string;
  opens: string;
  plan: string;
  actual: string;
  actualTitle: string;
}

export function buildVerify(boxList: SampleBox[], serverMode: boolean) {
  const pending: VerifyItem[] = [];
  const watching: VerifyItem[] = [];
  const calm: VerifyItem[] = [];
  if (serverMode) return { pending, watching, calm };
  for (const task of tasks) {
    const box = boxList.find((item) => item.id === task.box);
    if (!box) continue;
    const offPlan = box.alert.includes("地点") || box.alert.includes("偏离");
    const item: VerifyItem = {
      id: box.id,
      box: box.id,
      queue: "在途",
      task: task.name,
      alert: box.alert,
      opens: box.alert.includes("封箱后再开")
        ? `${box.opens} 次，其中 1 次发生在封箱后`
        : `${box.opens} 次`,
      plan: task.place,
      actual: offPlan ? "偏离计划地点" : placeShort(box),
      actualTitle: offPlan ? "偏离计划地点" : placeTitle(box),
    };
    if (task.status === "待核验") {
      item.queue = "待核验";
      pending.push(item);
    } else if (task.status === "采样中" && box.alert) {
      item.queue = "采样中";
      watching.push(item);
    } else if (
      (task.status === "采样中" || task.status === "在途") &&
      !box.alert &&
      box.life === "在途"
    ) {
      calm.push(item);
    }
  }
  return { pending, watching, calm };
}

export const FIELD_STEPS = ["待采样", "采样中", "已封箱", "在途", "待核验", "已签收"] as const;

function pickFieldTask(roles: string[], nickname: string, deptName: string) {
  if (
    roles.includes("SAMPLER") ||
    (!roles.includes("BRANCH_ADMIN") && !roles.includes("AGENCY_LEAD"))
  ) {
    return tasks.find((task) => task.people === nickname && task.status !== "已签收") || null;
  }
  if (roles.includes("BRANCH_ADMIN")) {
    const branch = deptName.match(/^.+分公司/)?.[0];
    if (!branch) return null;
    return (
      tasks.find(
        (task) => task.org === branch && task.box !== "未绑定" && task.status !== "已签收"
      ) || null
    );
  }
  const names = new Set(
    staff.filter((item) => deptName && item.org.includes(deptName)).map((item) => item.name)
  );
  return tasks.find((task) => names.has(task.people) && task.status !== "已签收") || null;
}

function pickFieldHistory(roles: string[], nickname: string, deptName: string) {
  if (
    roles.includes("SAMPLER") ||
    (!roles.includes("BRANCH_ADMIN") && !roles.includes("AGENCY_LEAD"))
  ) {
    return boxTaskHistory.find((task) => task.people === nickname) || null;
  }
  if (roles.includes("BRANCH_ADMIN")) {
    const branch = deptName.match(/^.+分公司/)?.[0];
    if (!branch) return null;
    return boxTaskHistory.find((task) => task.org === branch) || null;
  }
  const names = new Set(
    staff.filter((item) => deptName && item.org.includes(deptName)).map((item) => item.name)
  );
  return boxTaskHistory.find((task) => names.has(task.people)) || null;
}

export function fieldModel(
  roles: string[],
  nickname: string,
  deptName: string,
  boxList: SampleBox[],
  serverMode: boolean
) {
  if (serverMode) return { task: null, history: null, index: -1 };
  const current = pickFieldTask(roles, nickname, deptName);
  if (!current) return { task: null, history: null, index: -1 };
  const box = boxList.find((item) => item.id === current.box);
  return {
    task: {
      ...current,
      cond: box ? conditionText(box) : "",
      reported: box ? shortStamp(box.last) : "",
      reportedFull: box?.last || "",
      where: box ? placeShort(box) : "未定位",
      whereTitle: box ? placeTitle(box) : "",
    },
    history: pickFieldHistory(roles, nickname, deptName),
    index: FIELD_STEPS.indexOf(current.status as (typeof FIELD_STEPS)[number]),
  };
}
