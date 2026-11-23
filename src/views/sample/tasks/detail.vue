<template>
  <div class="page-container page-flow">
    <PageHeader :title="task?.name || '任务详情'" :back="'/task/tasks'">
      <template v-if="task" #tags>
        <el-tag :type="kindTone(kindLabel(task))" effect="plain">
          {{ kindLabel(task) }}
        </el-tag>
        <el-tag :type="taskStatusType(task)">{{ task.status }}</el-tag>
        <el-tag
          v-if="task.trip"
          :type="merged ? (task.trip === '双向' ? 'warning' : 'success') : 'warning'"
          effect="plain"
          :title="tripTitle"
        >
          {{ task.trip }}{{ tripTagSuffix }}
        </el-tag>
        <el-tag v-if="task.recordVideo" type="success" effect="plain">开箱录像</el-tag>
        <el-tag v-if="stale" type="warning" effect="plain" data-test="task-stale">
          刷新失败，内容可能不是最新
        </el-tag>
      </template>
      <template v-if="task" #meta>
        {{ task.id }} · {{ task.createdBy || "—" }} 创建于 {{ fullTime(task.createdAt) }}
      </template>
    </PageHeader>

    <el-skeleton v-if="loading && !detail" :rows="8" animated class="block" />
    <el-empty v-else-if="!detail" :description="error || '没有这张任务单'" />

    <template v-else-if="task">
      <!-- R-5：最近一次签收交接有跳过的箱子（已改挂他单位/已删除）：不能让「签收成功」盖住归属未全移 -->
      <el-alert
        v-if="handOverSkipped.length"
        type="warning"
        :closable="false"
        class="block handover-warn"
        data-test="handover-skipped"
        :title="`${handOverSkippedCount} 台箱子未随单交接：未自动改归属，仍归原单位`"
      >
        <div v-for="item in handOverSkipped" :key="item.boxId" class="handover-line">
          {{ handOverBoxTitle(item.boxId) }}：{{ item.reason }}
        </div>
        <div v-if="handOverSkippedCount > handOverSkipped.length" class="handover-line">
          …仅列出前 {{ handOverSkipped.length }} 台，其余见运行日志
        </div>
      </el-alert>
      <!-- 概况：状态、操作、步骤、关键数字和安排信息放在一张卡里，地图和动态紧跟其后 -->
      <el-card ref="heroCard" shadow="never" class="block hero" :class="`tone-${headTone}`">
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

        <!-- 旧物流单/合并单/带寄送的旧采样单：寄出方 → 接收方；R22 双向合并单三段：寄出方（检测站）→采样单位→检测站 -->
        <div v-if="showRoute" class="route">
          <div class="party">
            <span class="role from">寄出方</span>
            <b>{{ task.fromOrg || "—" }}</b>
            <span class="who">寄出人 {{ task.sender || "—" }}</span>
            <span class="addr"><PlaceText :place="task.fromPlace" /></span>
          </div>
          <template v-if="roundTrip">
            <div class="arrow">
              <el-icon><Right /></el-icon>
              <small>寄去采样</small>
            </div>
            <div class="party">
              <span class="role plan">采样单位</span>
              <b>{{ task.org || "—" }}</b>
              <span class="who">授权人员 {{ task.people || "未指定" }}</span>
              <span class="addr">
                <PlaceText :place="task.placeAt" :fallback="task.place || '计划地点未填写'" />
              </span>
            </div>
            <div class="arrow">
              <el-icon><Right /></el-icon>
              <small>采样后寄回</small>
            </div>
          </template>
          <div v-else class="arrow">
            <el-icon>
              <Sort v-if="task.trip === '双向'" class="both" />
              <Right v-else />
            </el-icon>
            <small v-if="task.trip">{{ task.trip === "双向" ? "寄去 · 寄回" : "只寄去" }}</small>
          </div>
          <div v-if="toStation" class="party">
            <span class="role to">检测站</span>
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
        <dl v-if="task.trip && !merged" class="facts pair">
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
        <dl v-else-if="!logistics" class="facts">
          <div v-if="merged && task.trip" class="wide">
            <dt>寄送方向</dt>
            <dd :title="tripTitle" data-test="task-trip-fact">
              {{ task.trip }}{{ tripMode === "stationFirst" ? "（按箱归属派生）" : "" }} ·
              {{ tripTitle }}
            </dd>
          </div>
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
        :title="`${overLimit.map((b) => `${boxTitle(b)} 开了 ${b.opensDuring} 次`).join('，')}，超过任务上限 ${task.maxOpens} 次`"
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
                <b>{{ boxTitle(box) }}</b>
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
                <span v-if="showRoute">
                  <i :style="{ background: COLORS.from }" />
                  寄出地址
                </span>
                <span v-if="toStation">
                  <i :style="{ background: COLORS.to }" />
                  收货地址
                </span>
                <span v-if="!logistics">
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
            v-if="task.kind === '采样' || task.kind === '采样后送检' || videos.length"
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
          :title="`${far.map((b) => `${boxTitle(b)} 相距 ${formatDistance(b.distanceM)}`).join('，')} 超过 ${formatDistance(detail.arriveRadiusM)}，请确认箱子确实在${detail.target.role}`"
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
import {
  MERGED_TRIP_TEXT,
  NEEDS_REASON,
  TASK_ACTIONS,
  TRIP_MODE_TEXT,
  TRIP_TEXT,
  endedToneFor,
  isEndedFor,
  isLocalSample,
  isMergedSample,
  stepsOf,
  taskStatusType,
  tripModeOf,
} from "./status";
import { ago, fullTime, shortTime, span, trackColor } from "@/utils/time";
import { boxTitle, imeiText } from "@/utils/boxLabel";
import { kindLabel, kindTone } from "../doc-flow";

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
  error = ref(""),
  /** 后台刷新失败但单子还在屏幕上：标一下，不清空 */
  stale = ref(false);
const task = computed(() => detail.value?.task || null);
/** 旧调拨/送检（只读）共用物流形详情（寄出方→接收方/检测站、收货地址、签收交接）。 */
const logistics = computed(() => task.value?.kind === "调拨" || task.value?.kind === "送检");
/** 合并采样单（R23 采样后送检＋旧合并别名）：分公司自采＋直寄检测站，既有采样安排又有寄出方→检测站物流段。 */
const merged = computed(() => isMergedSample(task.value as Record<string, unknown>));
/** R23 仅本地采样单：无物流段，已封箱终态、箱留采样单位。 */
const localOnly = computed(() => isLocalSample(task.value as Record<string, unknown>));
/** R28 方向语义：oneWay/return（寄回腿）/stationFirst（历史 R22 派生双向，只读旧样）。 */
const tripMode = computed(() =>
  task.value ? tripModeOf(task.value as Record<string, unknown>) : "oneWay"
);
/** 方向说明（tag title/facts 共用）：历史站首腿用旧派生文案，新单按 tripMode，旧采样单用旧手选文案。 */
const tripTitle = computed(() => {
  const t = task.value;
  if (!t?.trip) return "";
  if (merged.value)
    return tripMode.value === "stationFirst"
      ? MERGED_TRIP_TEXT[t.trip]
      : TRIP_MODE_TEXT[tripMode.value];
  if (t.kind === "送检") return TRIP_MODE_TEXT[tripMode.value];
  return TRIP_TEXT[t.trip];
});
/** 方向 tag 后缀：历史派生单标「（派生）」、旧手选单标「寄送」，R28 新单（显式 tripMode）不加后缀。 */
const tripTagSuffix = computed(() => {
  const t = task.value;
  if (!t?.trip) return "";
  if (t.tripMode) return tripMode.value === "stationFirst" ? "（派生）" : "";
  return merged.value ? "（派生）" : "寄送";
});
/** R22 历史站首腿双向（stationFirst）：寄出方（检测站）→采样单位（分公司）→检测站三段路线，步条含首腿。 */
const roundTrip = computed(() => merged.value && tripMode.value === "stationFirst");
/** R28 双向寄回腿（return）：合并流＋寄回分公司，步条含寄回腿；路线仍是寄出分公司→检测站（寄去·寄回）。 */
const returnLeg = computed(() => tripMode.value === "return");
/** 寄出方→接收方路线：旧物流单、合并单、带寄送的旧采样单都画。 */
const showRoute = computed(() => logistics.value || merged.value || Boolean(task.value?.trip));
/** 接收方是检测站：旧送检与合并单固定寄检测站。 */
const toStation = computed(() => logistics.value || merged.value);
const steps = computed(() => (task.value ? stepsOf(task.value) : []));
// 结束口径和流程校验同一份（shared/taskFlow.js，R23 含本地采样已封箱终态）
const ended = computed(() => isEndedFor(task.value as Record<string, unknown>));
// 走完最后一步结束的：进度条全绿。已取消/已拒收不在步骤里，另按流转记录停在最后一步。
const finished = computed(() => ended.value && steps.value.includes(task.value?.status || ""));
const stepIndex = computed(() => {
  const status = task.value?.status || "";
  if (finished.value) return steps.value.length;
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
  const list = steps.value.map((name, index) => ({
    name,
    no: index + 1,
    log: index <= stepIndex.value ? lastLog(name) : undefined,
    state:
      index < stepIndex.value || (finished.value && index === steps.value.length - 1)
        ? "done"
        : index === stepIndex.value && !ended.value
          ? "current"
          : "todo",
  }));
  // 已取消/已拒收不在步骤里，末尾补一格；已签收、已检测、已退回这些走完最后一步的不用再补
  if (ended.value && !finished.value)
    list.push({
      name: task.value!.status,
      no: list.length + 1,
      log: lastLog(task.value!.status),
      state: "error",
    });
  return list;
});
const headTone = computed(() =>
  ended.value ? endedToneFor(task.value as Record<string, unknown>) : "current"
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
    return `${d.boxes.length} 台采样箱${toStation.value ? `已归 ${t.toOrg}` : "已完成"}`;
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
/** R-5：最近一次签收交接跳过的箱子（建单后已改挂他单位/已删除），非空时页面顶部警示。 */
const handOverSkipped = computed(() => detail.value?.handOver?.skipped || []);
const handOverSkippedCount = computed(
  () => detail.value?.handOver?.skippedCount ?? handOverSkipped.value.length
);
function handOverBoxTitle(boxId: string) {
  const box = detail.value?.boxes.find((b) => b.id === boxId);
  return box ? boxTitle(box) : imeiText({ id: boxId });
}
/** 概况卡上能推进的动作，和服务端 can 同一口径（列表/mp 都直接按 can 出按钮）。
 * 唯一例外：旧调拨/送检的「拒收并退回」挂在「拒收」对话框的勾选里（can.已拒收 与 can.退回中
 * 同时为真），不再单独出按钮免得两个入口；合并单从 待检测/已检测 发起退回没有拒收可勾，
 * 退回中必须单独成按钮——以前一律过滤 to==="退回中"，网页整条退回分支不可达（org-b4b 观察①）。 */
const actions = computed(() => {
  const can = detail.value?.can || {};
  const backViaReject = Boolean(can["已拒收"] && can["退回中"]);
  return Object.entries(can)
    .filter(([to, ok]) => ok && !(to === "退回中" && backViaReject))
    .map(([to]) => to);
});
const waitingFor = computed(() => {
  const t = task.value;
  if (!t || !Object.keys(detail.value?.can || {}).length) return "";
  // R22 双向首腿：检测站寄出→分公司确认到达
  if (roundTrip.value && t.status === "待寄出") return `等待 ${t.fromOrg || "检测站"} 寄出箱子`;
  if (roundTrip.value && t.status === "运送中")
    return `箱子寄往 ${t.org || "采样单位"} 途中，等待确认到达`;
  // R28 双向寄回腿：检测站发起寄回/确认寄回/确认到达，分公司签收归还
  if (returnLeg.value && t.status === "已检测")
    return `检测完成，等待 ${t.toOrg || "检测站"} 发起寄回`;
  if (returnLeg.value && t.status === "待寄回")
    return `等待 ${t.toOrg || "检测站"} 把箱子寄回 ${t.fromOrg || "寄出分公司"}`;
  if (returnLeg.value && t.status === "寄回在途")
    return `箱子寄回 ${t.fromOrg || "寄出分公司"} 途中，等待确认到达`;
  if (returnLeg.value && t.status === "待归还")
    return `等待 ${t.fromOrg || "寄出分公司"} 签收归还（签收后箱子归属回分公司）`;
  if (toStation.value && t.status === "待签收") return `等待 ${t.toOrg} 签收`;
  // 合并单退回不必经拒收（待检测/已检测可直接发起），等待文案不再写「已拒收」
  if (t.status === "退回中")
    return merged.value
      ? `箱子退回途中，等待 ${t.fromOrg || "寄出方"} 确认退回`
      : `已拒收，等待 ${t.fromOrg} 接收退回的箱子`;
  if (t.status === "待检测")
    return `等待 ${toStation.value ? t.toOrg : t.fromOrg} 逐台扫码开始检测`;
  if (logistics.value && t.status === "待寄出") return `等待 ${t.fromOrg} 寄出`;
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
  if (toStation.value) {
    place("from", `寄出 · ${t.fromOrg || ""}`, "寄", COLORS.from, t.fromPlace);
    place("to", `收货 · ${t.toOrg || ""}`, "收", COLORS.to, t.toPlace);
  } else if (t.trip) {
    place("from", `寄出 · ${t.fromOrg || ""}`, "寄", COLORS.from, t.fromPlace);
  }
  // 合并单与旧采样单都有计划地点（采样段）；旧物流单没有
  if (!logistics.value) place("plan", "计划地点", "采", COLORS.plan, t.placeAt);
  for (const box of detail.value.boxes) {
    if (!box.position) continue;
    const color =
      box.near === true ? COLORS.near : box.near === false ? COLORS.far : COLORS.unknown;
    list.push({
      id: `box-${box.id}`,
      lng: box.position.lng,
      lat: box.position.lat,
      title: boxTitle(box),
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
    : toStation.value
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
/** 寄出地址到收货地址（合并单/旧物流单）或计划地点（旧寄送采样单）的灰色虚线。 */
const routeLines = computed<TiandituLine[]>(() => {
  const t = task.value;
  if (!t || !showRoute.value) return [];
  const ends = [t.fromPlace, toStation.value ? t.toPlace : t.placeAt].filter(
    (p): p is { lng: number; lat: number; address: string } => p?.lng != null && p?.lat != null
  );
  return ends.length === 2
    ? [{ points: ends, color: "#94a3b8", weight: 2, opacity: 0.8, dashed: true }]
    : [];
});
/**
 * names / boxList 是给子组件的「编号 → 原始 name」查表：name 可能就是服务端回显的整串 IMEI，
 * 所以显示一律由消费方（TrackMap、TaskTimeline、TaskEvents、TaskVideos、UplinkLog）过一遍 boxTitle。
 */
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
/**
 * R23/D5（#66）：?tab=task 深链定位「任务推进段」＝hero 概况卡（当前状态＋推进按钮＋步条）。
 * 工作台「我保管的箱子」行内「开始采样／封箱」跳这里复用既有推进弹窗与原因校验。
 * 只加 query 解析与滚动/激活：底部 el-tabs 无 task 页签，保持默认 boxes，不改其它逻辑。
 */
const heroCard = ref<{ $el?: HTMLElement } | null>(null);
function focusTaskSection() {
  if (String(routeInfo.query.tab || "") !== "task") return;
  void nextTick(() => {
    heroCard.value?.$el?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
}
watch(() => routeInfo.query.tab, focusTaskSection);
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

/**
 * silent：后台刷新时不显示骨架屏，出错也保留已有内容。
 * 15 秒轮询 + 切单号会叠在一起：每轮一个序号，旧响应回来时已经不是最新一轮就整轮丢掉，
 * 免得上一张单的内容贴到这张单上（详情接口慢的时候特别容易撞上）。
 */
let seq = 0;
async function load(silent = false) {
  const id = String(routeInfo.params.id || "");
  if (!id || !routeInfo.path.startsWith("/task/detail/")) return;
  const mine = ++seq;
  if (!silent) loading.value = true;
  error.value = "";
  try {
    const next = await API.task(id);
    if (mine !== seq) return;
    detail.value = next;
    stale.value = false;
    // ?tab=task 深链：首屏/切单加载完成后定位任务推进段（后台静默刷新不重复滚动）
    if (!silent) focusTaskSection();
  } catch (e) {
    if (mine !== seq) return;
    if (!silent) {
      detail.value = null;
      error.value = e instanceof Error ? e.message : "";
    } else if (detail.value) stale.value = true;
  } finally {
    if (mine === seq) loading.value = false;
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
      `${box ? boxTitle(box) : `采样箱 ${imeiText({ id: boxId })}`} 开始检测后，开箱次数从下一张任务单重新算。${
        returnLeg.value
          ? "双向寄回单：箱子随后由检测站寄回分公司，分公司签收归还后任务结束。"
          : "这台箱子的本次任务结束。"
      }`,
      "开始检测",
      { confirmButtonText: "开始检测", cancelButtonText: "取消" }
    );
  } catch {
    return;
  }
  inspecting.value = boxId;
  try {
    const result = await API.inspect(String(routeInfo.params.id), boxId);
    ElMessage.success(
      result.done
        ? returnLeg.value
          ? "全部箱子已开始检测，等待检测站发起寄回"
          : "全部箱子已开始检测，任务结束"
        : `已开始检测，还剩 ${result.left} 台`
    );
    await load();
  } finally {
    inspecting.value = "";
  }
}
/** 寄出、到达、签收、开始采样、封箱、发起退回、寄回腿这几步要和当前目标地址比距离。 */
const showDistance = computed(() =>
  [
    "运送中",
    "在途",
    "待签收",
    "已签收",
    "待检测",
    "强制签收",
    "待采样",
    "采样中",
    "已封箱",
    "待核验",
    "退回中",
    "已退回",
    "待寄回",
    "寄回在途",
    "待归还",
    "已归还",
  ].includes(action.to)
);
/** 取消、拒收、退回标红，强制签收标黄，其余是主按钮。 */
function buttonType(to: string) {
  if (to === "已取消" || to === "已拒收" || to === "退回中") return "danger";
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
      ? `其中 ${overLimit.value.length} 台开箱次数超过上限，异常的可以拒收。`
      : "";
    return `签收 ${n} 台采样箱${toStation.value ? `，箱子改归 ${t.toOrg}` : ""}。签收后开箱次数不再累计，开箱检测时每台扫码点「开始检测」。${over}`;
  }
  if (action.to === "已检测") {
    const left = (detail.value?.boxes || []).filter((b) => !b.inspectedAt && !b.voided).length;
    return returnLeg.value
      ? `剩下 ${left} 台箱子一起开始检测。检测完成后进入寄回腿：检测站寄回 ${t.fromOrg || "寄出分公司"}，分公司签收归还后任务结束。`
      : `剩下 ${left} 台箱子一起开始检测，任务结束。也可以在箱子列表里逐台开始检测。`;
  }
  if (action.to === "已签收" && t.kind === "调拨")
    return `由 ${t.signer} 签收 ${n} 台采样箱，签收后箱子改归 ${t.toOrg}${t.signerId ? `，由 ${t.signer} 保管` : ""}。`;
  if (action.to === "强制签收")
    return `指定签收人是 ${t.signer}。你代为签收 ${n} 台采样箱，流转记录里记为「强制签收」并写明原因；箱子改归 ${t.toOrg}，仍由 ${t.signer} 保管。`;
  if (action.to === "已拒收")
    return detail.value?.can?.["退回中"]
      ? `拒收后箱子仍属 ${t.fromOrg}。勾选退回时任务加上返程，寄出方扫码接收后结束；不勾任务直接结束。`
      : `拒收后箱子仍属 ${t.fromOrg}，任务结束。`;
  if (action.to === "退回中")
    return `拒收并退回：${n} 台箱子退回 ${t.fromOrg || "寄出方"}，任务加上返程；寄出方确认退回后任务结束，箱子回到在仓库。`;
  if (action.to === "已退回")
    return `确认退回的 ${n} 台箱子已回到 ${t.fromOrg}，任务结束，箱子回到在仓库。`;
  // R28 双向寄回腿
  if (action.to === "待寄回")
    return `检测完成，发起寄回：${n} 台箱子将寄回 ${t.fromOrg || "寄出分公司"}，由分公司签收归还后箱子归属回分公司。`;
  if (action.to === "寄回在途")
    return `确认 ${n} 台箱子已从 ${t.toOrg || "检测站"} 寄出，寄回 ${t.fromOrg || "寄出分公司"}。`;
  if (action.to === "待归还")
    return `确认 ${n} 台箱子已到达 ${t.fromOrg || "寄出分公司"}，等待分公司签收归还。`;
  if (action.to === "已归还")
    return `签收归还 ${n} 台箱子：箱子归属回 ${t.fromOrg || "寄出分公司"}，保管人清空（可重新分配），任务结束。`;
  if (action.to === "已取消")
    return "取消后任务结束，箱子恢复原来的上报设置；已经发生的流转记录会保留。";
  if (action.to === "运送中")
    return `确认 ${n} 台箱子已从 ${t.fromOrg || "寄出方"} 寄出${t.kind === "采样" ? `，寄往 ${t.org || "采样单位"}` : ""}。`;
  if (action.to === "待签收") return `确认箱子已到达 ${t.toOrg || "接收方"}，等待签收。`;
  // 采样单各步
  if (action.to === "待采样")
    return roundTrip.value
      ? `确认 ${n} 台箱子已送到 ${t.org || "采样单位"}（首腿签收）：箱子归属交采样单位，可以开始采样。`
      : `确认 ${n} 台箱子已送到 ${t.org || "采样单位"}，可以开始采样。`;
  if (action.to === "采样中")
    return `开始采样：${n} 台箱子进入采样阶段${t.recordVideo ? "，在计划地点开箱会自动请求录像" : ""}。`;
  if (action.to === "已封箱")
    return localOnly.value
      ? `确认样品已装好、${n} 台箱子已封箱。仅本地采样：封箱后任务结束，箱子留在 ${t.org || "采样单位"}。`
      : `确认样品已装好、${n} 台箱子已封箱。封箱后再开箱会记入开箱次数。`;
  if (action.to === "在途")
    return merged.value
      ? `确认 ${n} 台箱子已封箱寄出，寄往 ${t.toOrg || "检测站"}，等待检测站签收。`
      : `确认 ${n} 台箱子已寄回${t.trip ? ` ${t.fromOrg || "寄出单位"}` : ""}。`;
  if (action.to === "待核验")
    return `箱子进入${t.trip ? ` ${t.fromOrg || "寄出单位"}` : "核验点"}范围后会自动到达。也可以现在手动确认，然后等待核验签收。`;
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
    const kind = action.to === "强制签收" ? "强制签收的" : action.to === "退回中" ? "退回" : "拒收";
    ElMessage.warning(`请填写${kind}原因`);
    return;
  }
  action.busy = true;
  try {
    // 拒收时勾了退回：推进到「退回中」
    const to =
      action.to === "已拒收" && action.back && detail.value?.can?.["退回中"] ? "退回中" : action.to;
    const result = await API.transition(String(routeInfo.params.id), to, action.note.trim());
    // R-5：签收交接有跳过的箱子时明确警示，不让成功文案盖住「归属未全移」
    const skipped = result.handOver?.skipped || [];
    if (skipped.length)
      ElMessage.warning({
        message: `签收成功，但 ${skipped.length} 台箱子未随单交接：${skipped
          .slice(0, 3)
          .map((s) => `${handOverBoxTitle(s.boxId)} ${s.reason}`)
          .join("；")}${skipped.length > 3 ? "等" : ""}。详见页面顶部警示`,
        duration: 8000,
      });
    else ElMessage.success(`已${TASK_ACTIONS[to] || "更新"}`);
    action.open = false;
    await load();
  } finally {
    action.busy = false;
  }
}

watch(
  () => routeInfo.params.id,
  (id) => {
    if (!id) return;
    // 切到另一张单：旧内容、旧的「不是最新」标记都不能留，否则新单加载期间显示的是上一张单
    detail.value = null;
    stale.value = false;
    void load();
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
/* R-5 交接警示：逐台列出跳过原因，行距放宽便于扫读 */
.handover-warn :deep(.el-alert__description) {
  margin-top: 6px;
}
.handover-line {
  line-height: 1.8;
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
