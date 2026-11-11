<template>
  <div class="page-container page-flow">
    <PageHeader :title="task?.name || '任务详情'" back="/task/tasks">
      <template v-if="task" #tags>
        <el-tag :type="task.kind === '调拨' ? 'primary' : 'success'" effect="plain">
          {{ task.kind }}
        </el-tag>
        <el-tag :type="taskStatusType(task.status)">{{ task.status }}</el-tag>
        <el-tag v-if="task.trip" type="warning" effect="plain">{{ task.trip }}寄送</el-tag>
        <el-tag v-if="task.recordVideo" type="success" effect="plain">开箱录像</el-tag>
      </template>
      <template v-if="task" #meta>
        {{ task.id }} · {{ task.createdBy || "—" }} 创建于 {{ fullTime(task.createdAt) }}
      </template>
    </PageHeader>

    <el-skeleton v-if="loading && !detail" :rows="8" animated class="block" />
    <el-empty v-else-if="!detail" :description="error || '没有这张任务单'" />

    <template v-else-if="task">
      <!-- 概况：状态、操作、步骤、关键数字和安排信息放在一张卡里，地图和动态紧跟其后 -->
      <el-card shadow="never" class="block hero" :class="`tone-${headTone}`">
        <div class="hero-head">
          <div class="hero-status">
            <span class="pulse" />
            <div>
              <div class="now">{{ task.status }}</div>
              <div class="summary">{{ summary }}</div>
            </div>
          </div>
          <div v-if="actions.length" class="ops">
            <el-button
              v-for="to in actions"
              :key="to"
              :type="buttonType(to)"
              :plain="buttonType(to) !== 'primary'"
              @click="openAction(to)"
            >
              {{ TASK_ACTIONS[to] || to }}
            </el-button>
          </div>
          <span v-else-if="!ended && waitingFor" class="waiting">{{ waitingFor }}</span>
        </div>
        <ol class="track">
          <li v-for="step in stepView" :key="step.name" :class="`is-${step.state}`">
            <span class="dot">
              <el-icon v-if="step.state === 'done'"><Check /></el-icon>
              <el-icon v-else-if="step.state === 'error'"><Close /></el-icon>
              <template v-else>{{ step.no }}</template>
            </span>
            <span class="name">{{ step.name }}</span>
            <span v-if="step.log" class="meta">
              {{ step.log.by }}
              <br />
              {{ shortTime(step.log.time) }}
            </span>
            <span v-else-if="step.state === 'current'" class="meta">进行中</span>
          </li>
        </ol>

        <div class="stats">
          <div v-for="s in stats" :key="s.label" class="stat" :class="s.tone && `is-${s.tone}`">
            <span class="k">{{ s.label }}</span>
            <span class="v">
              {{ s.value }}
              <small v-if="s.unit">{{ s.unit }}</small>
            </span>
            <span v-if="s.hint" class="hint">{{ s.hint }}</span>
          </div>
        </div>

        <!-- 调拨、带寄送的采样单：寄出方 → 接收方（采样单位）；双向的箭头两头都有，表示采样后寄回 -->
        <div v-if="task.kind === '调拨' || task.trip" class="route">
          <div class="party">
            <span class="role from">寄出方</span>
            <b>{{ task.fromOrg || "—" }}</b>
            <span class="who">寄出人 {{ task.sender || "—" }}</span>
            <span class="addr"><PlaceText :place="task.fromPlace" /></span>
          </div>
          <div class="arrow">
            <el-icon>
              <Sort v-if="task.trip === '双向'" class="both" />
              <Right v-else />
            </el-icon>
            <small v-if="task.trip">{{ task.trip === "双向" ? "寄去 · 寄回" : "只寄去" }}</small>
          </div>
          <div v-if="task.kind === '调拨'" class="party">
            <span class="role to">接收方</span>
            <b>{{ task.toOrg || "—" }}</b>
            <span class="who">签收人 {{ task.signer || "—" }}</span>
            <span class="addr"><PlaceText :place="task.toPlace" /></span>
          </div>
          <div v-else class="party">
            <span class="role plan">采样单位</span>
            <b>{{ task.org || "—" }}</b>
            <span class="who">授权人员 {{ task.people || "未指定" }}</span>
            <span class="addr">
              <PlaceText :place="task.placeAt" :fallback="task.place || '计划地点未填写'" />
            </span>
          </div>
        </div>
        <dl v-if="task.trip" class="facts pair">
          <div class="wide">
            <dt>寄送方式</dt>
            <dd :title="TRIP_TEXT[task.trip]">
              {{
                task.trip === "双向"
                  ? `双向，采样封箱后寄回${task.fromOrg || "寄出单位"}`
                  : `单向，采样封箱后完成，箱子留在${task.org || "采样单位"}`
              }}
            </dd>
          </div>
          <div class="wide">
            <dt>样品</dt>
            <dd :class="{ empty: !task.sample }">{{ task.sample || "未填写" }}</dd>
          </div>
        </dl>
        <dl v-else-if="task.kind !== '调拨'" class="facts">
          <div>
            <dt>采样单位</dt>
            <dd>{{ task.org || "—" }}</dd>
          </div>
          <div>
            <dt>授权人员</dt>
            <dd :class="{ empty: !task.people }">{{ task.people || "未指定" }}</dd>
          </div>
          <div class="wide">
            <dt>计划地点</dt>
            <dd :class="{ empty: !task.placeAt && !task.place }">
              <PlaceText :place="task.placeAt" :fallback="task.place || '未填写'" />
            </dd>
          </div>
          <div class="wide">
            <dt>样品</dt>
            <dd :class="{ empty: !task.sample }">{{ task.sample || "未填写" }}</dd>
          </div>
        </dl>
        <p v-if="task.note" class="remark">
          <b>备注</b>
          {{ task.note }}
        </p>
      </el-card>

      <el-alert
        v-if="overLimit.length"
        type="error"
        :closable="false"
        class="block"
        :title="`${overLimit.map((b) => `${b.name || b.id} 开了 ${b.opensDuring} 次`).join('，')}，超过任务上限 ${task.maxOpens} 次，样品作废`"
      />

      <el-row :gutter="12" class="block equal">
        <el-col v-if="hasMap" :lg="16" :span="24">
          <el-card shadow="never" class="fill">
            <template #header>
              <div class="card-head">
                <span>
                  位置与轨迹
                  <span class="muted">{{ windowText }}</span>
                </span>
              </div>
            </template>
            <!-- 每台箱子一张小卡：电量、箱盖、最近上报，点一下在地图上定位 -->
            <div class="chips">
              <button
                v-if="detail.boxes.length > 1"
                type="button"
                class="chip"
                :class="{ on: !focusBox }"
                @click="focusBox = ''"
              >
                全部箱子
              </button>
              <button
                v-for="box in detail.boxes"
                :key="box.id"
                type="button"
                class="chip box-chip"
                :class="{ on: focusBox === box.id }"
                @click="focus(box.id, true)"
              >
                <i :style="{ background: colors[box.id] }" />
                <b>{{ box.name || box.id }}</b>
                <span
                  v-if="box.status?.batteryUsable != null"
                  :class="{ warn: box.status.batteryUsable < 20 }"
                >
                  电量 {{ box.status.batteryUsable }}%
                </span>
                <span v-else-if="box.status?.battery">{{ box.status.battery }}</span>
                <span v-if="box.status?.lid != null" :class="{ warn: box.status.lid === 1 }">
                  {{ box.status.lid === 1 ? "开着盖" : "关着盖" }}
                </span>
                <span>{{ box.last ? `${ago(box.last)}上报` : "未上报" }}</span>
              </button>
            </div>
            <TrackMap
              :tracks="tracks"
              :colors="colors"
              :names="names"
              :points="points"
              :circles="circles"
              :extra-lines="routeLines"
              :focus="focusBox"
              :active-id="activeId"
              :focus-token="focusToken"
              height="440px"
            >
              <template #legend>
                <span v-if="task.kind === '调拨' || task.trip">
                  <i :style="{ background: COLORS.from }" />
                  寄出地址
                </span>
                <span v-if="task.kind === '调拨'">
                  <i :style="{ background: COLORS.to }" />
                  收货地址
                </span>
                <span v-else>
                  <i :style="{ background: COLORS.plan }" />
                  计划地点
                </span>
                <span>
                  箱子当前位置：
                  <i :style="{ background: COLORS.near }" />
                  已到
                  <i :style="{ background: COLORS.far }" />
                  未到
                  <i :style="{ background: COLORS.unknown }" />
                  未判断
                </span>
                <span v-if="detail.target">
                  大虚线圈：{{ formatDistance(detail.arriveRadiusM) }}内算到达
                </span>
              </template>
            </TrackMap>
          </el-card>
        </el-col>
        <el-col :lg="hasMap ? 8 : 24" :span="24">
          <el-card shadow="never" class="fill feed" header="动态">
            <div class="feed-body">
              <TaskTimeline
                :logs="detail.logs"
                :events="detail.events || []"
                :videos="videos"
                :names="names"
                :record-video="Boolean(task.recordVideo)"
                @focus="focus"
                @video="openVideo"
              />
            </div>
          </el-card>
        </el-col>
      </el-row>

      <el-card shadow="never" class="block">
        <el-tabs v-model="tab">
          <el-tab-pane :label="`采样箱 ${detail.boxes.length}`" name="boxes">
            <p v-if="detail.target" class="muted target">
              距离按{{ detail.target.role }}计算：{{ detail.target.address || "已定位" }} ·
              {{ formatDistance(detail.arriveRadiusM) }}内算到达。点一行在地图上定位。
            </p>
            <TaskBoxes
              :boxes="detail.boxes"
              :tracks="detail.tracks || []"
              :colors="colors"
              :target-role="detail.target?.role"
              :max-opens="task.maxOpens"
              :active-id="focusBox"
              :inspect="Boolean(task.inspect)"
              :can-inspect="task.status === '待检测' && Boolean(detail.can?.['已检测'])"
              :busy-id="inspecting"
              :waiting-text="task.status === '待检测' ? '等检测站扫码' : '签收后检测'"
              @focus="focus"
              @inspect="inspectBox"
            />
          </el-tab-pane>
          <el-tab-pane v-if="detail.allow?.log" label="上报记录" name="log" lazy>
            <UplinkLog :load="loadLogs" :load-raw="loadRaw" :ranges="false" :boxes="boxList" />
          </el-tab-pane>
          <el-tab-pane label="事件" name="events" lazy>
            <TaskEvents :events="detail.events || []" :names="names" @focus="focus" />
          </el-tab-pane>
          <el-tab-pane
            v-if="detail.cameras?.length"
            :label="`监控 ${detail.cameras.length} 路`"
            name="cameras"
            lazy
          >
            <CameraWall :cameras="detail.cameras" />
          </el-tab-pane>
          <el-tab-pane
            v-if="task.kind === '采样' || videos.length"
            :label="`开箱录像 ${videos.length}`"
            name="videos"
          >
            <TaskVideos
              ref="videosRef"
              :videos="videos"
              :enabled="Boolean(task.recordVideo)"
              :names="names"
              :can-retry="Boolean(detail.allow?.video)"
              :task-id="task.id"
              @changed="(list) => detail && (detail.videos = list)"
            />
          </el-tab-pane>
          <el-tab-pane
            v-if="task.policy || Object.keys(task.overrides || {}).length"
            label="上报策略"
            name="policy"
          >
            <el-descriptions :column="1" border size="small">
              <el-descriptions-item label="统一">
                {{ task.policy ? policyText(task.policy) : "继承现有配置" }}
              </el-descriptions-item>
              <el-descriptions-item v-for="(p, id) in task.overrides" :key="id" :label="String(id)">
                {{ policyText(p) }}
              </el-descriptions-item>
            </el-descriptions>
          </el-tab-pane>
        </el-tabs>
      </el-card>
    </template>

    <el-dialog
      v-model="action.open"
      :title="TASK_ACTIONS[action.to] || action.to"
      width="560px"
      style="max-width: 94vw"
    >
      <p>{{ actionText }}</p>
      <!-- 签收核验：签收、强制签收、拒收时列出每台箱子的问题 -->
      <template v-if="detail?.check && receiveActions.includes(action.to)">
        <el-alert
          v-if="detail.check.problems.length"
          type="error"
          :closable="false"
          class="far"
          title="签收核验有异常，不能直接签收，只能拒收或强制签收"
        >
          <ul class="problems">
            <li v-for="(p, i) in detail.check.problems" :key="i">
              <b>{{ p.name }}</b>
              {{ p.text }}
            </li>
          </ul>
        </el-alert>
        <el-alert v-else type="success" :closable="false" class="far" :title="checkPassText" />
      </template>
      <el-checkbox
        v-if="action.to === '已拒收' && detail?.can?.['退回中']"
        v-model="action.back"
        class="back"
      >
        退回寄出单位（{{ task?.fromOrg || "寄出方" }}）：任务加上返程，寄出方扫码接收后结束
      </el-checkbox>
      <template
        v-if="
          detail?.target && showDistance && !(detail?.check && receiveActions.includes(action.to))
        "
      >
        <el-alert
          v-if="far.length"
          type="warning"
          :closable="false"
          class="far"
          :title="`${far.map((b) => `${b.name || b.id} 相距 ${formatDistance(b.distanceM)}`).join('，')} 超过 ${formatDistance(detail.arriveRadiusM)}，请确认箱子确实在${detail.target.role}`"
        />
        <el-alert
          v-else-if="unknown.length === detail.boxes.length"
          type="info"
          :closable="false"
          class="far"
          title="箱子暂无位置，无法核对距离"
        />
        <el-alert
          v-else
          type="success"
          :closable="false"
          class="far"
          :title="`已定位的箱子都在${detail.target.role} ${formatDistance(detail.arriveRadiusM)}以内`"
        />
      </template>
      <el-input
        v-model="action.note"
        type="textarea"
        :rows="3"
        maxlength="1000"
        show-word-limit
        :placeholder="
          NEEDS_REASON[action.to] ||
          (['运送中', '在途'].includes(action.to)
            ? '备注（选填），如快递单号、外箱情况'
            : '备注（选填）')
        "
      />
      <template #footer>
        <el-button @click="action.open = false">取消</el-button>
        <el-button :type="buttonType(action.to)" :loading="action.busy" @click="confirmAction">
          {{ TASK_ACTIONS[action.to] || "确认" }}
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ElMessage } from "element-plus";
import { Check, Close, Right, Sort } from "@element-plus/icons-vue";
import API, { formatDistance, type Policy, type TaskDetail } from "@/api/sample/report-policy";
import type {
  TiandituCircle,
  TiandituLine,
  TiandituPoint,
} from "@/components/TiandituMap/index.vue";
import PlaceText from "./PlaceText.vue";
import TaskBoxes from "./TaskBoxes.vue";
import TaskTimeline from "./TaskTimeline.vue";
import TaskVideos from "./TaskVideos.vue";
import CameraWall from "./CameraWall.vue";
import TaskEvents from "./TaskEvents.vue";
import TrackMap from "@/components/biz/TrackMap.vue";
import PageHeader from "@/components/biz/PageHeader.vue";
import UplinkLog, { type UplinkLoadParams } from "@/components/biz/UplinkLog.vue";
import SampleBoxAPI, { type BoxLogItem } from "@/api/sample/box";
import { NEEDS_REASON, TASK_ACTIONS, TRIP_TEXT, stepsOf, taskStatusType } from "./status";
import { ago, fullTime, shortTime, span, trackColor } from "@/utils/time";

const routeInfo = useRoute();
/** 地图图标和图例共用的颜色。 */
const COLORS = {
  from: "#16a34a",
  to: "#dc2626",
  plan: "#7c3aed",
  near: "#16a34a",
  far: "#ea580c",
  unknown: "#64748b",
};
const detail = ref<TaskDetail | null>(null),
  loading = ref(false),
  error = ref("");
const task = computed(() => detail.value?.task || null);
const steps = computed(() => (task.value ? stepsOf(task.value) : []));
const ended = computed(() => ["已取消", "已拒收"].includes(task.value?.status || ""));
const stepIndex = computed(() => {
  const status = task.value?.status || "";
  if (status === "已签收" || status === "已完成") return steps.value.length;
  const index = steps.value.indexOf(status);
  if (ended.value) {
    // 结束在哪一步：取流转记录里最后一个正常状态
    const last = [...(detail.value?.logs || [])]
      .reverse()
      .find((log) => steps.value.includes(log.status));
    return last ? steps.value.indexOf(last.status) + 1 : 0;
  }
  return index < 0 ? 0 : index;
});
/** 每一步的状态，以及流转记录里最后一次进入这一步的人和时间。 */
const stepView = computed(() => {
  const logs = detail.value?.logs || [];
  const lastLog = (status: string) => [...logs].reverse().find((log) => log.status === status);
  const finished = ["已签收", "已完成"].includes(task.value?.status || "");
  const list = steps.value.map((name, index) => ({
    name,
    no: index + 1,
    log: index <= stepIndex.value ? lastLog(name) : undefined,
    state:
      index < stepIndex.value || (finished && index === steps.value.length - 1)
        ? "done"
        : index === stepIndex.value && !ended.value
          ? "current"
          : "todo",
  }));
  if (ended.value)
    list.push({
      name: task.value!.status,
      no: list.length + 1,
      log: lastLog(task.value!.status),
      state: "error",
    });
  return list;
});
const headTone = computed(() =>
  ended.value
    ? "error"
    : ["已签收", "已完成"].includes(task.value?.status || "")
      ? "done"
      : "current"
);
const summary = computed(() => {
  const t = task.value,
    d = detail.value;
  if (!t || !d) return "";
  if (ended.value) {
    const last = [...d.logs].reverse().find((log) => log.status === t.status);
    return last?.note ? `原因：${last.note}` : "任务已结束";
  }
  if (headTone.value === "done")
    return `${d.boxes.length} 台采样箱${t.kind === "调拨" ? `已归 ${t.toOrg}` : "已完成"}`;
  if (!d.target) return `${d.boxes.length} 台采样箱`;
  const near = d.boxes.filter((b) => b.near === true).length;
  return `${d.boxes.length} 台采样箱，${near} 台已到${d.target.role}附近（${formatDistance(d.arriveRadiusM)}内）`;
});

/** 概况卡上的关键数字。 */
const stats = computed(() => {
  const t = task.value,
    d = detail.value;
  if (!t || !d) return [];
  const n = d.boxes.length;
  const list: {
    label: string;
    value: string | number;
    unit?: string;
    hint?: string;
    tone?: string;
  }[] = [{ label: "采样箱", value: n, unit: "台" }];
  if (d.target && headTone.value === "current") {
    const near = d.boxes.filter((b) => b.near === true).length;
    list.push({
      label: `已到${d.target.role}`,
      value: `${near}/${n}`,
      unit: "台",
      hint: `${formatDistance(d.arriveRadiusM)}内算到达`,
      tone: n && near === n ? "success" : "",
    });
  }
  const opens = d.boxes.reduce((sum, b) => sum + (b.opensDuring || 0), 0);
  list.push({
    label: "任务期间开箱",
    value: opens,
    unit: "次",
    hint: t.maxOpens != null ? `上限每台 ${t.maxOpens} 次` : "不限次数",
    tone: overLimit.value.length ? "danger" : "",
  });
  const low = d.boxes.filter(
    (b) => b.status?.batteryUsable != null && b.status.batteryUsable < 20
  ).length;
  list.push({
    label: "低电量",
    value: low,
    unit: "台",
    hint: "可用电量低于 20%",
    tone: low ? "warning" : "",
  });
  const live = headTone.value === "current";
  list.push({
    label: live ? "已进行" : "用时",
    value: span(t.createdAt, live ? new Date().toISOString() : d.window?.to) || "—",
  });
  return list;
});

const overLimit = computed(() => {
  const max = task.value?.maxOpens;
  if (max == null) return [];
  return (detail.value?.boxes || []).filter((b) => b.opensDuring != null && b.opensDuring > max);
});
const actions = computed(() =>
  Object.entries(detail.value?.can || {})
    .filter(([to, ok]) => ok && to !== "退回中")
    .map(([to]) => to)
);
const waitingFor = computed(() => {
  const t = task.value;
  if (!t || !Object.keys(detail.value?.can || {}).length) return "";
  if (t.kind === "调拨" && t.status === "待签收") return `等待 ${t.toOrg} 签收`;
  if (t.status === "退回中") return `已拒收，等待 ${t.fromOrg} 接收退回的箱子`;
  if (t.status === "待检测")
    return `等待 ${t.kind === "调拨" ? t.toOrg : t.fromOrg} 逐台扫码开始检测`;
  if (t.kind === "调拨" && t.status === "待寄出") return `等待 ${t.fromOrg} 寄出`;
  return "你没有推进这一步的权限";
});

const points = computed<TiandituPoint[]>(() => {
  const t = task.value;
  if (!t || !detail.value) return [];
  const list: TiandituPoint[] = [];
  const place = (
    id: string,
    title: string,
    glyph: string,
    color: string,
    p?: { address: string; lng: number | null; lat: number | null } | null
  ) => {
    if (p?.lng != null && p?.lat != null)
      list.push({
        id,
        lng: p.lng,
        lat: p.lat,
        title,
        lines: [p.address || ""],
        marker: { glyph, color, shape: "pin" },
      });
  };
  if (t.kind === "调拨") {
    place("from", `寄出 · ${t.fromOrg || ""}`, "寄", COLORS.from, t.fromPlace);
    place("to", `收货 · ${t.toOrg || ""}`, "收", COLORS.to, t.toPlace);
  } else {
    if (t.trip) place("from", `寄出 · ${t.fromOrg || ""}`, "寄", COLORS.from, t.fromPlace);
    place("plan", "计划地点", "采", COLORS.plan, t.placeAt);
  }
  for (const box of detail.value.boxes) {
    if (!box.position) continue;
    const color =
      box.near === true ? COLORS.near : box.near === false ? COLORS.far : COLORS.unknown;
    list.push({
      id: `box-${box.id}`,
      lng: box.position.lng,
      lat: box.position.lat,
      title: box.name || box.id,
      marker: { glyph: box.position.source === "GPS" ? "G" : "基", color, shape: "badge" },
      lines: [
        `${box.position.source} · ${box.last || ""}`,
        detail.value.target ? `距${detail.value.target.role} ${formatDistance(box.distanceM)}` : "",
      ].filter(Boolean),
    });
  }
  return list;
});
const circles = computed<TiandituCircle[]>(() => {
  const target = detail.value?.target;
  if (target?.lng == null || target?.lat == null || ended.value) return [];
  const color = target.role.includes("寄出")
    ? COLORS.from
    : task.value?.kind === "调拨"
      ? COLORS.to
      : COLORS.plan;
  return [{ lng: target.lng, lat: target.lat, radiusM: detail.value!.arriveRadiusM, color }];
});

/** 轨迹和地图交互：每台箱子一种颜色；选中一台时其他箱子的轨迹变淡、定位点隐藏。 */
const colors = computed(() =>
  Object.fromEntries((detail.value?.boxes || []).map((b, i) => [b.id, trackColor(i)]))
);
const focusBox = ref(""),
  focusToken = ref(0);
const activeId = computed(() => (focusBox.value ? `box-${focusBox.value}` : ""));
const tracks = computed(() => detail.value?.tracks || []);
const hasMap = computed(
  () => points.value.length > 0 || tracks.value.some((t) => t.gpsCount || t.lbsCount)
);
/** 调拨单寄出地址到收货地址的灰色虚线。 */
const routeLines = computed<TiandituLine[]>(() => {
  const t = task.value;
  if (!t || (t.kind !== "调拨" && !t.trip)) return [];
  const ends = [t.fromPlace, t.kind === "调拨" ? t.toPlace : t.placeAt].filter(
    (p): p is { lng: number; lat: number; address: string } => p?.lng != null && p?.lat != null
  );
  return ends.length === 2
    ? [{ points: ends, color: "#94a3b8", weight: 2, opacity: 0.8, dashed: true }]
    : [];
});
const names = computed(() =>
  Object.fromEntries((detail.value?.boxes || []).map((b) => [b.id, b.name || b.id]))
);
const boxList = computed(() =>
  (detail.value?.boxes || []).map((b) => ({ id: b.id, name: b.name || b.id }))
);
const loadLogs = (params: UplinkLoadParams) => API.taskLogs(task.value!.id, params);
const loadRaw = async (item: BoxLogItem) =>
  (await SampleBoxAPI.raw(item.box, item.id || "", item.time)).raw;
const windowText = computed(() => {
  const w = detail.value?.window;
  if (!w) return "";
  const live = headTone.value === "current";
  return `${shortTime(w.from)} 至 ${live ? "现在" : shortTime(w.to)}（${span(w.from, w.to)}）`;
});
function focus(boxId: string, toggle = false) {
  focusBox.value = toggle && focusBox.value === boxId ? "" : boxId;
  focusToken.value += 1;
}

const tab = ref("boxes");
const videos = computed(() => detail.value?.videos || []);
const videosRef = ref<InstanceType<typeof TaskVideos>>();
/** 有视频地址的直接播放；还没录好的只切到录像标签页看状态。 */
function openVideo(id: string) {
  tab.value = "videos";
  if (videos.value.find((v) => v.id === id)?.url) void nextTick(() => videosRef.value?.open(id));
}

function policyText(p: Policy) {
  return `${p.reportPeriodSec} 秒 · ${p.reportOnlyWhenCharging ? "仅充电时" : "持续定时"} · ${p.periodicGps === false ? "关闭卫星定位" : p.periodicGps ? "随定时上报定位" : "定位随任务默认"}`;
}

/** silent：后台刷新时不显示骨架屏，出错也保留已有内容。 */
async function load(silent = false) {
  const id = String(routeInfo.params.id || "");
  if (!id || !routeInfo.path.startsWith("/task/detail/")) return;
  if (!silent) loading.value = true;
  error.value = "";
  try {
    detail.value = await API.task(id);
  } catch (e) {
    if (!silent) {
      detail.value = null;
      error.value = e instanceof Error ? e.message : "";
    }
  } finally {
    loading.value = false;
  }
}

const action = reactive({ open: false, to: "", note: "", busy: false, back: true });
/** 走签收核验的动作。 */
const receiveActions = computed(() => [
  task.value?.inspect ? "待检测" : "已签收",
  "强制签收",
  "已拒收",
]);
const checkPassText = computed(() => {
  const c = detail.value?.check;
  if (!c) return "";
  const opens = c.boxes.map((b) => b.opensDuring).filter((n): n is number => n != null);
  const parts = [`核验通过：${c.boxes.length} 台箱子`];
  if (opens.length)
    parts.push(
      `本次开箱 ${Math.min(...opens)}–${Math.max(...opens)} 次${c.maxOpens != null ? `（上限 ${c.maxOpens}）` : ""}`
    );
  if (c.target?.hasCoords)
    parts.push(
      c.boxes.every((b) => b.near == null) ? "暂无位置、没法核对距离" : `都在${c.target.role}附近`
    );
  parts.push("箱盖关着、没有告警");
  return parts.join("，");
});

/** 检测站逐台开始检测：这台箱子的本次任务结束，开箱次数不再累计；最后一台检测完整张单变「已检测」。 */
const inspecting = ref("");
async function inspectBox(boxId: string) {
  const box = detail.value?.boxes.find((b) => b.id === boxId);
  try {
    await ElMessageBox.confirm(
      `${box?.name || boxId} 开始检测后，这台箱子的本次任务结束，开箱次数从下一张任务单重新算。`,
      "开始检测",
      { confirmButtonText: "开始检测", cancelButtonText: "取消" }
    );
  } catch {
    return;
  }
  inspecting.value = boxId;
  try {
    const result = await API.inspect(String(routeInfo.params.id), boxId);
    const skipped = (detail.value?.boxes || []).some((b) => b.voided && !b.inspectedAt);
    ElMessage.success(
      result.done
        ? skipped
          ? "已开始检测，任务结束；作废的箱子不检测"
          : "全部箱子已开始检测，任务结束"
        : `已开始检测，还剩 ${result.left} 台`
    );
    await load();
  } finally {
    inspecting.value = "";
  }
}
/** 寄出、到达、签收、开始采样、封箱这几步要和当前目标地址比距离。 */
const showDistance = computed(() =>
  [
    "运送中",
    "待签收",
    "已签收",
    "待检测",
    "强制签收",
    "待采样",
    "采样中",
    "已封箱",
    "待核验",
    "已退回",
  ].includes(action.to)
);
/** 取消、拒收标红，强制签收标黄，其余是主按钮。 */
function buttonType(to: string) {
  if (to === "已取消" || to === "已拒收") return "danger";
  return to === "强制签收" ? "warning" : "primary";
}
const far = computed(() => (detail.value?.boxes || []).filter((b) => b.near === false));
const unknown = computed(() => (detail.value?.boxes || []).filter((b) => b.near == null));
const actionText = computed(() => {
  const t = task.value;
  if (!t) return "";
  const n = t.boxIds.length;
  if (action.to === "待检测") {
    const over = overLimit.value.length
      ? `其中 ${overLimit.value.length} 台开箱次数超过上限，样品作废：可以拒收；签收后这几台也不能开始检测。`
      : "";
    return `签收 ${n} 台采样箱${t.kind === "调拨" ? `，箱子改归 ${t.toOrg}` : ""}。签收后开箱次数不再累计，开箱检测时每台扫码点「开始检测」。${over}`;
  }
  if (action.to === "已检测") {
    const waiting = (detail.value?.boxes || []).filter((b) => !b.inspectedAt);
    const voided = waiting.filter((b) => b.voided).length;
    const left = waiting.length - voided;
    const skip = voided ? `${voided} 台开箱超限、样品作废，不检测。` : "";
    return left
      ? `剩下 ${left} 台箱子一起开始检测，任务结束。${skip}也可以在箱子列表里逐台开始检测。`
      : `${skip}任务结束，箱子回到未使用。`;
  }
  if (action.to === "已签收" && t.kind === "调拨")
    return `由 ${t.signer} 签收 ${n} 台采样箱，签收后箱子改归 ${t.toOrg}${t.signerId ? `，由 ${t.signer} 保管` : ""}。`;
  if (action.to === "强制签收") {
    const voided = overLimit.value.length
      ? `开箱超限的 ${overLimit.value.length} 台签收后仍算样品作废，不能开始检测。`
      : "";
    if (t.kind !== "调拨")
      return `核验有异常，你仍要签收 ${n} 台采样箱。流转记录里记为「强制签收」并写明原因。${voided}`;
    return `${t.signer ? `指定签收人是 ${t.signer}。你代为签收` : "签收"} ${n} 台采样箱，流转记录里记为「强制签收」并写明原因；箱子改归 ${t.toOrg}${t.signer ? `，仍由 ${t.signer} 保管` : ""}。${voided}`;
  }
  if (action.to === "已拒收" && t.kind === "采样")
    return `拒收即样品作废：任务结束，箱子回到未使用，需要的话重新建单补采。`;
  if (action.to === "已拒收")
    return detail.value?.can?.["退回中"]
      ? `拒收后箱子仍属 ${t.fromOrg}。勾选退回时任务加上返程，寄出方扫码接收后结束；不勾任务直接结束。`
      : `拒收后箱子仍属 ${t.fromOrg}，任务结束。`;
  if (action.to === "已退回")
    return `确认退回的 ${n} 台箱子已回到 ${t.fromOrg}，任务结束，箱子回到在仓库。`;
  if (action.to === "已取消")
    return "取消后任务结束，箱子恢复原来的上报设置；已经发生的流转记录会保留。";
  if (action.to === "运送中")
    return `确认 ${n} 台箱子已从 ${t.fromOrg || "寄出方"} 寄出${t.kind === "采样" ? `，寄往 ${t.org || "采样单位"}` : ""}。`;
  if (action.to === "待签收") return `确认箱子已到达 ${t.toOrg || "接收方"}，等待签收。`;
  // 采样单各步
  if (action.to === "待采样")
    return `确认 ${n} 台箱子已送到 ${t.org || "采样单位"}，可以开始采样。`;
  if (action.to === "采样中")
    return `开始采样：${n} 台箱子进入采样阶段${t.recordVideo ? "，在计划地点开箱会自动请求录像" : ""}。`;
  if (action.to === "已封箱")
    return `确认样品已装好、${n} 台箱子已封箱。封箱后再开箱会记入开箱次数。`;
  if (action.to === "在途")
    return `确认 ${n} 台箱子已寄回${t.trip ? ` ${t.fromOrg || "寄出单位"}` : ""}。`;
  if (action.to === "待核验")
    return `确认箱子已到达${t.trip ? ` ${t.fromOrg || "寄出单位"}` : "核验点"}，等待核验签收。`;
  if (action.to === "已签收") return `核验无误，签收 ${n} 台采样箱，任务完成。`;
  if (action.to === "已完成")
    return `采样已完成，任务结束${t.trip === "单向" ? `，箱子留在 ${t.org || "采样单位"}` : ""}。`;
  return `确认将任务推进到「${action.to}」？`;
});
function openAction(to: string) {
  Object.assign(action, { open: true, to, note: "", busy: false, back: true });
}
async function confirmAction() {
  if (NEEDS_REASON[action.to] && !action.note.trim()) {
    ElMessage.warning(`请填写${action.to === "已拒收" ? "拒收" : "强制签收的"}原因`);
    return;
  }
  action.busy = true;
  try {
    // 拒收时勾了退回：推进到「退回中」
    const to =
      action.to === "已拒收" && action.back && detail.value?.can?.["退回中"] ? "退回中" : action.to;
    await API.transition(String(routeInfo.params.id), to, action.note.trim());
    ElMessage.success(`已${TASK_ACTIONS[to] || "更新"}`);
    action.open = false;
    await load();
  } finally {
    action.busy = false;
  }
}

watch(
  () => routeInfo.params.id,
  (id) => {
    if (id) void load();
  }
);
// 任务进行中位置、开箱、录像都在变：15 秒刷新一次，切回这个页签时也立即刷新
let poll = 0;
onMounted(() => {
  void load();
  poll = window.setInterval(() => {
    if (!ended.value && headTone.value === "current") void load(true);
  }, 15000);
});
onActivated(() => {
  if (detail.value) void load(true);
});
onBeforeUnmount(() => window.clearInterval(poll));
</script>

<style scoped>
/* 公共 .page-container 是定高的纵向 flex，卡片默认会被压扁、把操作按钮和表格挤到看不见；这里整页滚动，卡片保持原高。 */
.page-container {
  overflow: auto;
}
.page-container > * {
  flex-shrink: 0;
}
.title {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
.block {
  margin-top: 12px;
}
/* 概况卡：顶部一条状态色，状态名和圆点跟着变色 */
.hero {
  --tone: var(--el-color-primary);
  --tone-soft: var(--el-color-primary-light-9);
  position: relative;
  overflow: hidden;
  border-radius: 10px;
}
.hero.tone-done {
  --tone: var(--el-color-success);
  --tone-soft: var(--el-color-success-light-9);
}
.hero.tone-error {
  --tone: var(--el-color-danger);
  --tone-soft: var(--el-color-danger-light-9);
}
.hero::before {
  position: absolute;
  inset: 0 0 auto;
  height: 3px;
  content: "";
  background: var(--tone);
}
.hero :deep(.el-card__body) {
  padding: 18px 20px 16px;
}
.hero-head {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: center;
  justify-content: space-between;
}
.hero-status {
  display: flex;
  gap: 12px;
  align-items: center;
  min-width: 0;
}
.pulse {
  position: relative;
  flex: none;
  width: 12px;
  height: 12px;
  background: var(--tone);
  border-radius: 50%;
  box-shadow: 0 0 0 5px var(--tone-soft);
}
.tone-current .pulse::after {
  position: absolute;
  inset: 0;
  content: "";
  background: var(--tone);
  border-radius: 50%;
  animation: pulse 1.8s ease-out infinite;
}
@keyframes pulse {
  from {
    opacity: 0.6;
    transform: scale(1);
  }
  to {
    opacity: 0;
    transform: scale(2.8);
  }
}
.now {
  font-size: 22px;
  font-weight: 600;
  line-height: 1.3;
  color: var(--tone);
}
.summary {
  margin-top: 2px;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}
/* 关键数字：自动换行的小格子 */
.stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
  gap: 10px;
  margin-top: 18px;
}
.stat {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 10px 14px;
  background: var(--el-fill-color-lighter);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
}
.stat .k {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.stat .v {
  font-size: 22px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  line-height: 1.3;
  color: var(--el-text-color-primary);
}
.stat .v small {
  margin-left: 3px;
  font-size: 12px;
  font-weight: 400;
  color: var(--el-text-color-secondary);
}
.stat .hint {
  font-size: 12px;
  color: var(--el-text-color-placeholder);
}
.stat.is-success .v {
  color: var(--el-color-success);
}
.stat.is-warning {
  background: var(--el-color-warning-light-9);
  border-color: var(--el-color-warning-light-7);
}
.stat.is-warning .v {
  color: var(--el-color-warning-dark-2);
}
.stat.is-danger {
  background: var(--el-color-danger-light-9);
  border-color: var(--el-color-danger-light-7);
}
.stat.is-danger .v {
  color: var(--el-color-danger);
}
/* 采样安排：标签在上、内容在下，空值显示成浅色文字 */
.facts {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 14px 24px;
  padding-top: 16px;
  margin: 16px 0 0;
  border-top: 1px dashed var(--el-border-color-lighter);
}
.facts.pair {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}
.facts dt {
  margin-bottom: 4px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.facts dd {
  margin: 0;
  font-size: 14px;
  line-height: 1.6;
  color: var(--el-text-color-primary);
  word-break: break-all;
}
.facts dd.empty {
  color: var(--el-text-color-placeholder);
}
/* 调拨：寄出方 → 接收方 */
.route {
  display: flex;
  gap: 12px;
  align-items: stretch;
  padding-top: 16px;
  margin-top: 16px;
  border-top: 1px dashed var(--el-border-color-lighter);
}
.party {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
  padding: 12px 14px;
  background: var(--el-fill-color-lighter);
  border-radius: 8px;
}
.party b {
  font-size: 15px;
}
.party .who,
.party .addr {
  font-size: 13px;
  color: var(--el-text-color-secondary);
}
.role {
  align-self: flex-start;
  padding: 0 8px;
  font-size: 12px;
  line-height: 20px;
  border-radius: 10px;
}
.role.from {
  color: var(--el-color-success);
  background: var(--el-color-success-light-9);
}
.role.to {
  color: var(--el-color-danger);
  background: var(--el-color-danger-light-9);
}
.role.plan {
  color: #7c3aed;
  background: color-mix(in srgb, #7c3aed 12%, transparent);
}
.arrow {
  display: flex;
  flex: none;
  flex-direction: column;
  gap: 2px;
  align-items: center;
  align-self: center;
  font-size: 20px;
  color: var(--el-text-color-placeholder);
}
.arrow small {
  font-size: 12px;
  white-space: nowrap;
}
.arrow .both {
  transform: rotate(90deg);
}
@media (max-width: 992px) {
  .facts {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
@media (max-width: 640px) {
  .hero :deep(.el-card__body) {
    padding: 16px 14px 14px;
  }
  .stat {
    padding: 8px 12px;
  }
  .stat .v {
    font-size: 18px;
  }
  .facts,
  .facts.pair {
    grid-template-columns: 1fr;
  }
  .route {
    flex-direction: column;
  }
  .arrow {
    flex-direction: row;
    gap: 6px;
  }
  .arrow .el-icon {
    transform: rotate(90deg);
  }
  .arrow .both {
    transform: rotate(-90deg);
  }
}
.ops {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.waiting {
  padding: 4px 10px;
  font-size: 13px;
  color: var(--el-color-warning-dark-2);
  background: var(--el-color-warning-light-9);
  border-radius: 4px;
}
/* 自绘步骤条：第一步贴左、最后一步贴右，和下面的数字格对齐；圆点之间的连线用前一个 li 的 ::after，完成的段落染成绿色。
   上下左右留 6px，给当前步骤的光圈留位置，不被横向滚动裁掉。 */
.track {
  display: flex;
  padding: 6px;
  margin: 14px -6px 0;
  overflow-x: auto;
  list-style: none;
}
.track li {
  position: relative;
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 4px;
  align-items: flex-start;
  min-width: 110px;
  text-align: left;
}
.track li:last-child {
  flex: none;
  align-items: flex-end;
  min-width: 0;
  text-align: right;
}
.track li:not(:last-child)::after {
  position: absolute;
  top: 13px;
  right: 8px;
  left: 36px;
  height: 2px;
  content: "";
  background: var(--el-border-color);
  border-radius: 1px;
}
.track li.is-done:not(:last-child)::after {
  background: var(--el-color-success);
}
.dot {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  font-size: 13px;
  font-weight: 600;
  color: var(--el-text-color-placeholder);
  background: var(--el-bg-color);
  border: 2px solid var(--el-border-color);
  border-radius: 50%;
}
.is-done .dot {
  color: #fff;
  background: var(--el-color-success);
  border-color: var(--el-color-success);
}
.is-current .dot {
  color: #fff;
  background: var(--el-color-primary);
  border-color: var(--el-color-primary);
  box-shadow: 0 0 0 5px var(--el-color-primary-light-8);
}
.is-error .dot {
  color: #fff;
  background: var(--el-color-danger);
  border-color: var(--el-color-danger);
}
.name {
  font-size: 14px;
  color: var(--el-text-color-secondary);
}
.is-done .name {
  color: var(--el-text-color-primary);
}
.is-current .name {
  font-weight: 600;
  color: var(--el-color-primary);
}
.is-error .name {
  font-weight: 600;
  color: var(--el-color-danger);
}
.meta {
  font-size: 12px;
  line-height: 1.5;
  color: var(--el-text-color-secondary);
  white-space: nowrap;
}
.legend {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  margin-top: 8px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.legend i {
  display: inline-block;
  width: 10px;
  height: 10px;
  margin-right: 4px;
  vertical-align: -1px;
  border-radius: 50%;
}
.muted {
  font-size: 12px;
  line-height: 1.6;
  color: var(--el-text-color-secondary);
}
.map {
  height: 440px;
}
.card-head {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: space-between;
}
.tag {
  margin-left: 6px;
}
.by {
  margin-left: 8px;
  color: var(--el-text-color-secondary);
}
.note {
  margin: 4px 0 0;
}
.far {
  margin-bottom: 12px;
}
.danger {
  font-weight: 600;
  color: var(--el-color-danger);
}
/* 地图和动态并排等高：动态列表绝对定位填满卡片，内容多时在卡片里滚动，不把整行撑高。 */
.equal > .el-col {
  display: flex;
  margin-bottom: 12px;
}
.equal {
  margin-bottom: -12px;
}
.fill {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
}
.fill :deep(.el-card__body) {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
}
.feed-body {
  position: relative;
  flex: 1;
  min-height: 420px;
}
.feed-body > * {
  position: absolute;
  inset: 0;
}
.map-tools {
  display: inline-flex;
  gap: 12px;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 10px;
}
.chip {
  display: inline-flex;
  gap: 5px;
  align-items: center;
  padding: 2px 10px;
  font-size: 12px;
  line-height: 20px;
  color: var(--el-text-color-regular);
  cursor: pointer;
  background: var(--el-fill-color-lighter);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 999px;
}
.chip.on {
  color: var(--el-color-primary);
  background: var(--el-color-primary-light-9);
  border-color: var(--el-color-primary-light-5);
}
.chip i {
  width: 8px;
  height: 8px;
  border-radius: 2px;
}
.box-chip {
  gap: 8px;
  padding: 5px 12px;
  background: var(--el-bg-color);
  border-radius: 8px;
  transition:
    border-color 0.15s,
    background 0.15s;
}
.box-chip:hover {
  border-color: var(--el-color-primary-light-5);
}
.box-chip b {
  font-weight: 600;
  color: var(--el-text-color-primary);
}
.box-chip span {
  color: var(--el-text-color-secondary);
}
.box-chip span.warn {
  color: var(--el-color-danger);
}
.legend .line-sample {
  display: inline-block;
  width: 18px;
  height: 4px;
  margin-right: 4px;
  vertical-align: 2px;
  background: #2563eb;
  border-radius: 2px;
}
.legend i.hollow {
  box-sizing: border-box;
  background: #fff;
  border: 2px solid #2563eb;
}
.remark {
  padding: 8px 12px;
  margin: 14px 0 0;
  font-size: 13px;
  background: var(--el-color-warning-light-9);
  border-radius: 6px;
}
.remark b {
  margin-right: 8px;
}
.target {
  margin: 0 0 8px;
}
.problems {
  padding-left: 18px;
  margin: 6px 0 0;
  line-height: 1.7;
}
.back {
  height: auto;
  margin: 4px 0 10px;
  white-space: normal;
}
</style>
