import { reactive } from "vue";
import { boxLogs, boxes, type BoxLog, type SampleBox } from "./data";

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** 当前打开的页面里改箱子。刷新后模块重新加载，回到 data.ts 的初始数据。 */
export const boxSession = reactive({
  boxes: clone(boxes),
  logs: clone(boxLogs) as BoxLog[],
});

function stamp() {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

export function findBox(id: string) {
  return boxSession.boxes.find((item) => item.id === id);
}

function pushLog(box: string, text: string, by: string) {
  boxSession.logs.unshift({ box, time: stamp(), text, by });
}

export function requestActivate(box: SampleBox) {
  if (box.life !== "待激活" || box.activateStep !== "等待激活") return false;
  box.activateStep = "待设备确认";
  box.org = "总公司";
  pushLog(box.id, "管理员确认激活，设备密钥进入指令队列，等待箱子下次上线", "系统管理员");
  return true;
}

export function confirmDevice(box: SampleBox) {
  if (box.life !== "待激活" || box.activateStep !== "待设备确认") return false;
  box.activateStep = "已确认";
  box.life = "未使用";
  box.status = "未使用";
  box.org = "总公司";
  pushLog(box.id, "箱子确认已保存密钥，状态改为未使用", "设备");
  return true;
}

export function disableBox(box: SampleBox) {
  if (box.life !== "未使用") return false;
  box.life = "停用";
  box.status = "停用";
  pushLog(box.id, "管理员停用，不能再绑定新任务", "系统管理员");
  return true;
}

export function restoreBox(box: SampleBox) {
  if (box.life !== "停用") return false;
  box.life = "未使用";
  box.status = "未使用";
  pushLog(box.id, "管理员恢复，状态改为未使用", "系统管理员");
  return true;
}
