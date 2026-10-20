<template>
  <div v-loading="!ready" class="page-container">
    <el-empty v-if="ready && !box" description="没有这台采样箱">
      <el-button @click="router.push('/device/boxes')">返回采样箱</el-button>
    </el-empty>
    <el-empty v-else-if="!allow(BOX_PERM.detail)" description="当前角色不能查看采样箱详情">
      <el-button @click="router.push('/device/boxes')">返回采样箱</el-button>
    </el-empty>

    <template v-else-if="box">
      <el-card shadow="never">
        <template #header>
          <div class="head">
            <div class="head-title">
              <el-button @click="router.push('/device/boxes')">返回</el-button>
              <strong>{{ box.id }}</strong>
              <el-tag :type="lifeTag(box.life)" size="small">{{ box.life }}</el-tag>
              <el-tag v-if="box.alert" type="warning" size="small">{{ box.alert }}</el-tag>
              <span class="org">{{ box.org }}</span>
            </div>
            <div class="ops">
              <el-button
                v-if="
                  !serverMode &&
                  box.life === '待激活' &&
                  box.activateStep === '等待激活' &&
                  allow(BOX_PERM.activate)
                "
                type="primary"
                @click="activateOpen = true"
              >
                激活
              </el-button>
              <el-button
                v-if="!serverMode && box.activateStep === '待设备确认' && allow(BOX_PERM.activate)"
                type="primary"
                plain
                @click="simulate"
              >
                模拟箱子确认
              </el-button>
              <el-button
                v-if="!serverMode && box.life === '未使用' && allow(BOX_PERM.disable)"
                type="danger"
                plain
                @click="stop"
              >
                停用
              </el-button>
              <el-button
                v-if="!serverMode && box.life === '停用' && allow(BOX_PERM.disable)"
                type="primary"
                plain
                @click="resume"
              >
                恢复
              </el-button>
            </div>
          </div>
        </template>

        <div class="facts">
          <div v-for="item in facts" :key="item.label" class="fact" :class="{ wide: item.wide }">
            <span>{{ item.label }}</span>
            <b>{{ item.value }}</b>
          </div>
        </div>

        <div class="progress">
          <div class="progress-head">激活进度 · {{ stepText }}</div>
          <el-steps :active="stepIndex" finish-status="success" class="steps">
            <el-step title="上电上报" />
            <el-step title="等待激活" />
            <el-step title="密钥已下发" />
            <el-step title="箱子已确认" />
          </el-steps>
        </div>
      </el-card>

      <div class="split">
        <el-card v-if="allow(BOX_PERM.event)" shadow="never" header="事件">
          <ul v-if="events.length" class="feed">
            <li v-for="(item, index) in events" :key="item.time + item.name + index">
              <time>{{ item.time }}</time>
              <div>
                <b>{{ item.name }}</b>
                <span>{{ item.detail }}</span>
              </div>
            </li>
          </ul>
          <el-empty v-else description="暂无事件" :image-size="56" />
        </el-card>

        <el-card v-if="allow(BOX_PERM.log)" shadow="never">
          <template #header>
            <div class="debug-head">
              <span>{{ serverMode ? "调试" : "日志（最近 7 天）" }}</span>
              <em v-if="serverMode">{{ streamState }} · 最近 7 天</em>
            </div>
          </template>
          <ul v-if="logs.length" class="feed">
            <li
              v-for="(item, index) in logs"
              :key="(item.id || item.time) + item.text + index"
              :class="{ pick: serverMode }"
              @click="openRaw(item)"
            >
              <time>{{ item.time }}</time>
              <div>
                <template v-if="serverMode">
                  <b>{{ uplinkType(item) }}</b>
                  <span>{{ uplinkSummary(item) }}</span>
                </template>
                <template v-else>
                  <span>{{ item.text }}</span>
                  <em>{{ item.by }}</em>
                </template>
                <el-button v-if="serverMode" link type="primary" @click.stop="openRaw(item)">
                  {{ shownRaw(item) ? "收起" : "原文" }}
                </el-button>
                <code v-if="shownRaw(item)" @click.stop>{{ formatRaw(shownRaw(item)) }}</code>
              </div>
            </li>
          </ul>
          <el-empty v-else :description="serverMode ? '暂无报文' : '暂无日志'" :image-size="56" />
        </el-card>
      </div>

      <el-card v-if="allow(BOX_PERM.task)" shadow="never" class="block" header="关联任务">
        <div v-if="linkedTasks.length" class="tasks">
          <div v-for="row in linkedTasks" :key="row.no" class="task">
            <div class="task-main">
              <b>{{ row.no }}</b>
              <span>{{ row.name }}</span>
              <el-tag :type="row.relation === '当前' ? 'primary' : 'info'" size="small">
                {{ row.relation }}
              </el-tag>
            </div>
            <div class="task-meta">
              {{ row.org }} · {{ row.place }} · {{ row.people }} · {{ row.status }}
            </div>
            <el-button link type="primary" @click="openTask(row)">查看任务单</el-button>
          </div>
        </div>
        <el-empty v-else description="没有关联任务" :image-size="56" />
      </el-card>
    </template>

    <el-dialog v-model="activateOpen" title="激活采样箱" width="480px">
      <p v-if="box">{{ box.id }} · IMEI {{ box.imei }}</p>
      <p>核对身份后确认激活。设备密钥会在这台箱子下次上线时下发，所属固定为总公司。</p>
      <template #footer>
        <el-button @click="activateOpen = false">取消</el-button>
        <el-button type="primary" @click="doActivate">确认激活</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="taskOpen" title="任务单" width="520px">
      <el-descriptions v-if="currentTask" :column="1" border>
        <el-descriptions-item label="任务单">{{ currentTask.no }}</el-descriptions-item>
        <el-descriptions-item label="名称">{{ currentTask.name }}</el-descriptions-item>
        <el-descriptions-item label="分公司">{{ currentTask.org }}</el-descriptions-item>
        <el-descriptions-item label="计划地点">{{ currentTask.place }}</el-descriptions-item>
        <el-descriptions-item label="授权人员">{{ currentTask.people }}</el-descriptions-item>
        <el-descriptions-item label="状态">{{ currentTask.status }}</el-descriptions-item>
      </el-descriptions>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import SampleBoxAPI, { type BoxLogItem } from "@/api/sample/box";
import { useUserStore } from "@/stores/user";
import { AuthStorage } from "@/utils/auth";
import {
  alerts,
  BOX_PERM,
  boxTaskHistory,
  gpsText,
  lbsText,
  reports,
  tasks,
  type BoxLife,
  type SampleBox,
} from "../data";
import {
  boxSession,
  confirmDevice,
  disableBox,
  findBox,
  requestActivate,
  restoreBox,
} from "../box-state";

interface LinkedTask {
  no: string;
  name: string;
  org: string;
  place: string;
  people: string;
  status: string;
  relation: "当前" | "历史";
}

const route = useRoute();
const router = useRouter();
const userStore = useUserStore();
const activateOpen = ref(false);
const taskOpen = ref(false);
const currentTask = ref<LinkedTask | null>(null);

const DEBUG_LIMIT = 100;
const DAY_MS = 24 * 60 * 60 * 1000;
const POLL_MS = 3000;
const STREAM_RETRY_MS = 5000;

const serverMode = import.meta.env.VITE_MOCK_DEV_SERVER !== "true";
const remoteBox = ref<SampleBox | null>(null);
const remoteLogs = ref<BoxLogItem[]>([]);
const rawById = ref<Record<string, string>>({});
const ready = ref(!serverMode);
const streamLive = ref(false);
const polling = ref(false);
const boxId = computed(() => String(route.params.id || ""));
const box = computed(() => (serverMode ? remoteBox.value : findBox(boxId.value)));
const streamState = computed(() => {
  if (streamLive.value) return "实时";
  if (polling.value) return "轮询";
  return "连接中";
});

let debugTicket = 0;
let reconcileTimer = 0;
let pollTimer = 0;
let retryTimer = 0;
let connectTimer = 0;
let socket: WebSocket | null = null;
let streamStopped = false;

function padStamp(value: number, width = 2) {
  return String(value).padStart(width, "0");
}

function formatStamp(date: Date) {
  return `${date.getFullYear()}-${padStamp(date.getMonth() + 1)}-${padStamp(date.getDate())} ${padStamp(date.getHours())}:${padStamp(date.getMinutes())}:${padStamp(date.getSeconds())}.${padStamp(date.getMilliseconds(), 3)}`;
}

/** 结束时间多留一天，避免浏览器时区和服务器不一致时把刚到的报文排除。不按上报间隔抽稀。 */
function debugQuery() {
  const now = Date.now();
  return {
    from: formatStamp(new Date(now - 7 * DAY_MS)),
    to: formatStamp(new Date(now + DAY_MS)),
    limit: DEBUG_LIMIT,
  };
}

function stripRaw(item: BoxLogItem): BoxLogItem {
  const next = { ...item };
  delete next.raw;
  return next;
}

function sortLogs(rows: BoxLogItem[]) {
  return [...rows].sort((left, right) => {
    if (left.time !== right.time) return left.time < right.time ? 1 : -1;
    return (Number(right.id) || 0) - (Number(left.id) || 0);
  });
}

function sameUplink(left: BoxLogItem, right: BoxLogItem) {
  if (left.id && right.id) return left.id === right.id;
  return left.time === right.time && left.kind === right.kind && left.text === right.text;
}

async function loadDebug() {
  const ticket = ++debugTicket;
  const id = boxId.value;
  const page = await SampleBoxAPI.logs(id, debugQuery());
  if (ticket !== debugTicket || id !== boxId.value) return;
  remoteLogs.value = sortLogs(page.list.map(stripRaw)).slice(0, DEBUG_LIMIT);
}

function scheduleReconcile() {
  window.clearTimeout(reconcileTimer);
  reconcileTimer = window.setTimeout(() => {
    loadDebug().catch(() => undefined);
  }, 200);
}

function prependUplink(item: BoxLogItem) {
  if (item.box && item.box !== boxId.value) return;
  const next = stripRaw(item);
  if (remoteLogs.value.some((row) => sameUplink(row, next))) return;
  remoteLogs.value = sortLogs([next, ...remoteLogs.value]).slice(0, DEBUG_LIMIT);
  scheduleReconcile();
}

async function loadRemote() {
  if (!serverMode || !boxId.value) return;
  const id = boxId.value;
  try {
    const next = await SampleBoxAPI.detail(id);
    if (id === boxId.value) remoteBox.value = next;
  } catch {
    if (id === boxId.value) remoteBox.value = null;
  }
  try {
    await loadDebug();
  } catch {
    // 初次失败保持空列表，轮询或下一条实时报文再补。
  } finally {
    if (id === boxId.value) ready.value = true;
  }
}

async function refreshLive() {
  const id = boxId.value;
  try {
    const next = await SampleBoxAPI.detail(id);
    if (id === boxId.value) remoteBox.value = next;
  } catch {
    // 短轮询失败时留着已经打开的箱子。
  }
  try {
    await loadDebug();
  } catch {
    // 留着已经列出的报文。
  }
}

function startPoll() {
  if (pollTimer || streamStopped) return;
  polling.value = true;
  void refreshLive();
  pollTimer = window.setInterval(() => {
    void refreshLive();
  }, POLL_MS);
}

function stopPoll() {
  window.clearInterval(pollTimer);
  pollTimer = 0;
  polling.value = false;
}

function streamUrl() {
  const token = encodeURIComponent(AuthStorage.getAccessToken());
  const base = String(import.meta.env.VITE_APP_BASE_API || "").replace(/\/$/, "");
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}${base}/api/v1/sample/stream?token=${token}`;
}

function applyLiveBox(next: SampleBox) {
  if (!remoteBox.value || next.id !== remoteBox.value.id) return;
  remoteBox.value = {
    ...remoteBox.value,
    ...next,
    status: next.life || remoteBox.value.status,
  };
}

function onStreamMessage(raw: string) {
  let message: { type?: string; box?: SampleBox; uplink?: BoxLogItem };
  try {
    message = JSON.parse(raw) as { type?: string; box?: SampleBox; uplink?: BoxLogItem };
  } catch {
    return;
  }
  const live = message.box;
  if (message.type !== "box" || !live || live.id !== boxId.value) return;
  applyLiveBox(live);
  if (message.uplink) prependUplink(message.uplink);
}

function connectStream() {
  if (!serverMode || streamStopped) return;
  window.clearTimeout(retryTimer);
  if (!AuthStorage.getAccessToken()) {
    streamLive.value = false;
    startPoll();
    return;
  }
  const current = new WebSocket(streamUrl());
  socket = current;
  window.clearTimeout(connectTimer);
  connectTimer = window.setTimeout(() => {
    if (streamStopped || socket !== current) return;
    if (current.readyState !== WebSocket.OPEN) startPoll();
  }, POLL_MS);
  current.onopen = () => {
    if (socket !== current) return;
    streamLive.value = true;
    stopPoll();
    // 连上之前漏掉的报文补一次，之后只靠这条通道追加。
    loadDebug().catch(() => undefined);
  };
  current.onmessage = (event) => {
    if (socket !== current) return;
    onStreamMessage(String(event.data));
  };
  current.onclose = () => {
    if (socket !== current) return;
    socket = null;
    streamLive.value = false;
    if (streamStopped) return;
    startPoll();
    retryTimer = window.setTimeout(connectStream, STREAM_RETRY_MS);
  };
}

function stopStream() {
  streamStopped = true;
  window.clearTimeout(retryTimer);
  window.clearTimeout(connectTimer);
  window.clearTimeout(reconcileTimer);
  stopPoll();
  const current = socket;
  socket = null;
  current?.close();
}

watch(
  boxId,
  () => {
    if (!serverMode) return;
    ready.value = false;
    remoteBox.value = null;
    remoteLogs.value = [];
    rawById.value = {};
    window.clearTimeout(reconcileTimer);
    loadRemote();
  },
  { immediate: true }
);

onMounted(() => {
  if (!serverMode) return;
  connectStream();
});

onUnmounted(() => {
  stopStream();
});

const stepIndex = computed(() => {
  if (!box.value || box.value.activateStep === "已确认") return 4;
  if (box.value.activateStep === "待设备确认") return 2;
  return 1;
});

const stepText = computed(() => {
  if (!box.value) return "";
  if (box.value.activateStep === "已确认") return "箱子已确认";
  return box.value.activateStep;
});

const facts = computed(() => {
  if (!box.value) return [];
  return [
    { label: "IMEI", value: box.value.imei },
    { label: "ICCID", value: box.value.iccid },
    { label: "IMSI", value: box.value.imsi },
    { label: "固件", value: box.value.firmware },
    { label: "电压", value: box.value.battery },
    { label: "信号", value: String(box.value.csq) },
    { label: "上电时间", value: box.value.poweredAt, wide: true },
    { label: "基站", value: lbsText(box.value), wide: true },
    { label: "GPS", value: gpsText(box.value), wide: true },
  ];
});

const events = computed(() => {
  const id = boxId.value;
  const rows = [
    ...reports
      .filter((item) => item.box === id)
      .map((item) => ({
        time: item.time,
        name: item.event,
        detail:
          item.event === "心跳" ? `基站 ${item.lbs}` : `${item.person}，开箱 ${item.opens} 次`,
      })),
    ...alerts
      .filter((item) => item.box === id)
      .map((item) => ({
        time: item.time,
        name: item.rule,
        detail: item.detail,
      })),
  ];
  return rows.sort((a, b) => (a.time < b.time ? 1 : -1));
});

const logs = computed((): BoxLogItem[] => {
  if (serverMode) return remoteLogs.value;
  return boxSession.logs
    .filter((item) => item.box === boxId.value)
    .slice()
    .sort((a, b) => (a.time < b.time ? 1 : -1))
    .map((item) => ({
      box: item.box,
      time: item.time,
      text: item.text,
      by: item.by,
      raw: item.raw,
      lbsLng: null,
      lbsLat: null,
      gpsLng: null,
      gpsLat: null,
    }));
});

function uplinkType(item: BoxLogItem) {
  if (item.kind === "boot") return "上电上报";
  if (item.kind === "timer") return "定时上报";
  if (item.kind === "pad") return "开箱上报";
  if (item.text) return item.text;
  return "设备上报";
}

function uplinkSummary(item: BoxLogItem) {
  const summary = item.text && item.text !== uplinkType(item) ? item.text : "";
  const device = item.deviceTime ? `设备时间 ${item.deviceTime}` : "";
  return [summary, device].filter(Boolean).join(" · ") || item.text || "—";
}

function shownRaw(item: BoxLogItem) {
  if (serverMode) return item.id ? rawById.value[item.id] || "" : "";
  return item.raw || "";
}

function hideRaw(id: string) {
  if (!rawById.value[id]) return false;
  const next = { ...rawById.value };
  delete next[id];
  rawById.value = next;
  return true;
}

async function openRaw(item: BoxLogItem) {
  if (!serverMode) return;
  let target = item;
  if (!target.id) {
    try {
      await loadDebug();
    } catch {
      return;
    }
    target = remoteLogs.value.find((row) => row.id && sameUplink(row, item)) || item;
  }
  if (!target.id) return;
  if (hideRaw(target.id)) return;
  const data = await SampleBoxAPI.raw(boxId.value, target.id, target.time);
  rawById.value = { ...rawById.value, [target.id]: data.raw };
}

function formatRaw(raw: string) {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

const linkedTasks = computed<LinkedTask[]>(() => {
  const id = boxId.value;
  const current = tasks
    .filter((item) => item.box === id)
    .map((item) => ({ ...item, relation: "当前" as const }));
  const past = boxTaskHistory
    .filter((item) => item.box === id)
    .map((item) => ({ ...item, relation: "历史" as const }));
  return [...current, ...past];
});

function allow(perm: string) {
  return userStore.userInfo.perms?.includes(perm) ?? false;
}

function lifeTag(life: BoxLife) {
  if (life === "在途") return "primary";
  if (life === "未使用") return "success";
  if (life === "待激活") return "warning";
  return "info";
}

function doActivate() {
  if (!box.value) return;
  if (requestActivate(box.value)) ElMessage.success(`${box.value.id} 已等待设备确认`);
  activateOpen.value = false;
}

async function simulate() {
  if (!box.value) return;
  try {
    await ElMessageBox.confirm(
      "模拟这台箱子下次上线，并确认已经保存设备密钥。确认后状态变为未使用，所属仍是总公司。",
      "模拟箱子确认",
      { type: "warning", confirmButtonText: "确认", cancelButtonText: "取消" }
    );
  } catch {
    return;
  }
  if (confirmDevice(box.value)) ElMessage.success(`${box.value.id} 已变为未使用`);
}

async function stop() {
  if (!box.value) return;
  try {
    await ElMessageBox.confirm(`${box.value.id} 停用后不能再绑定新任务。`, "停用采样箱", {
      type: "warning",
      confirmButtonText: "停用",
      cancelButtonText: "取消",
    });
  } catch {
    return;
  }
  if (disableBox(box.value)) ElMessage.success(`${box.value.id} 已停用`);
}

async function resume() {
  if (!box.value) return;
  try {
    await ElMessageBox.confirm(`恢复 ${box.value.id} 后，状态变为未使用。`, "恢复采样箱", {
      type: "warning",
      confirmButtonText: "恢复",
      cancelButtonText: "取消",
    });
  } catch {
    return;
  }
  if (restoreBox(box.value)) ElMessage.success(`${box.value.id} 已恢复为未使用`);
}

function openTask(row: LinkedTask) {
  if (!allow(BOX_PERM.task)) return;
  currentTask.value = row;
  taskOpen.value = true;
}
</script>

<style scoped>
.head {
  display: flex;
  gap: 12px;
  align-items: center;
  justify-content: space-between;
}
.head-title {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  min-width: 0;
}
.head-title strong {
  font-size: 18px;
}
.org {
  color: var(--el-text-color-secondary);
}
.ops {
  display: flex;
  flex-shrink: 0;
  gap: 8px;
}
.facts {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 1px;
  overflow: hidden;
  background: var(--el-border-color-lighter);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
}
.fact {
  min-width: 0;
  padding: 10px 14px;
  background: var(--el-bg-color);
}
.fact.wide {
  grid-column: span 2;
}
.fact span {
  display: block;
  margin-bottom: 4px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.fact b {
  display: block;
  font-weight: 500;
  word-break: break-all;
}
.progress {
  padding-top: 14px;
  margin-top: 16px;
  border-top: 1px solid var(--el-border-color-lighter);
}
.progress-head {
  margin-bottom: 8px;
  color: var(--el-text-color-regular);
}
.steps {
  max-width: 640px;
}
.split {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
  gap: 12px;
  margin-top: 12px;
}
.block {
  margin-top: 12px;
}
.feed {
  padding: 0;
  margin: 0;
  list-style: none;
}
.feed li {
  display: grid;
  grid-template-columns: 168px minmax(0, 1fr);
  gap: 12px;
  padding: 8px 0;
  border-bottom: 1px solid var(--el-border-color-lighter);
}
.feed li:last-child {
  padding-bottom: 0;
  border-bottom: 0;
}
.feed time {
  font-variant-numeric: tabular-nums;
  color: var(--el-text-color-secondary);
}
.feed b {
  margin-right: 8px;
}
.feed em {
  margin-left: 8px;
  font-style: normal;
  color: var(--el-text-color-secondary);
}
.feed li.pick {
  cursor: pointer;
}
.feed li > div {
  min-width: 0;
}
.debug-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.debug-head em {
  font-size: 12px;
  font-style: normal;
  color: var(--el-text-color-secondary);
}
.feed code {
  display: block;
  padding: 8px 10px;
  margin-top: 6px;
  font-family: ui-monospace, Consolas, monospace;
  font-size: 12px;
  line-height: 1.45;
  color: var(--el-text-color-regular);
  word-break: break-all;
  white-space: pre-wrap;
  background: var(--el-fill-color-light);
  border-radius: 6px;
}
.tasks {
  display: flex;
  flex-direction: column;
}
.task {
  display: flex;
  gap: 16px;
  align-items: center;
  padding: 10px 0;
  border-bottom: 1px solid var(--el-border-color-lighter);
}
.task:last-child {
  padding-bottom: 0;
  border-bottom: 0;
}
.task-main {
  display: flex;
  flex-shrink: 0;
  gap: 8px;
  align-items: center;
  width: 320px;
}
.task-meta {
  flex: 1;
  min-width: 0;
  color: var(--el-text-color-secondary);
}
@media (max-width: 1100px) {
  .facts {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .head,
  .task {
    flex-direction: column;
    align-items: flex-start;
  }
  .task-main {
    width: auto;
  }
}
</style>
