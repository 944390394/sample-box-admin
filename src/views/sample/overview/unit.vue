<template>
  <div class="page-container page-flow">
    <PageHeader :title="data?.unit.name || '单位总览'" back="/monitor/overview">
      <template #tags>
        <el-tag
          v-if="data"
          size="small"
          :type="data.station ? 'warning' : data.unit.hq ? 'info' : 'primary'"
          effect="plain"
        >
          {{ data.station ? "检测站" : data.unit.hq ? "总部" : "分公司" }}
        </el-tag>
      </template>
      <template #meta>
        <span v-if="data && data.unit.path !== data.unit.name" class="path-text">
          {{ data.unit.path }}
        </span>
        <FreshnessMeta :updated-at="updatedAt" :error="error" :interval="5000" />
      </template>
      <template #actions>
        <el-button :icon="Refresh" :loading="loading" @click="refresh">刷新</el-button>
        <el-button :icon="Box" @click="openBoxes">本单位的箱子</el-button>
      </template>
    </PageHeader>

    <!-- 范围外/不存在的单位：重试永远不会成功，给友好错态＋回自己总览的出口（R4） -->
    <EmptyState
      v-if="error && errorCode === 'A0404'"
      description="这个单位不存在，或不在你的数据范围内"
    >
      <div class="unit-error-guide">
        <p class="text-muted guide-text">
          链接里的单位编号可能有误，或你的数据范围没有覆盖它。 返回总览会自动落到你有权查看的单位。
        </p>
        <div class="guide-actions">
          <el-button type="primary" :icon="ArrowLeft" @click="backToMyOverview">
            返回我的总览
          </el-button>
          <el-button :icon="Refresh" :loading="loading" @click="refresh">重试</el-button>
        </div>
      </div>
    </EmptyState>
    <ErrorState
      v-else-if="error"
      :message="`刷新失败：${error}`"
      :retrying="loading"
      @retry="refresh"
    >
      <el-button link type="primary" size="small" @click="backToMyOverview">返回我的总览</el-button>
    </ErrorState>

    <el-skeleton v-if="!data && loading && !error" :rows="8" animated />
    <template v-else-if="data">
      <!-- 检测站：流转管线，点某一段切换下方明细页签 -->
      <FlowPipeline
        v-if="data.station"
        :steps="flowSteps"
        :active="stationTab"
        data-test="station-tiles"
        @step-click="onFlowStep"
      />
      <!-- 分公司：四张 KPI，点卡进箱子列表对应筛选 -->
      <div v-else-if="data.stats" class="kpi-grid" data-test="unit-tiles">
        <KpiCard v-for="item in kpis" :key="item.key" :item="item" @select="openTile" />
      </div>
      <EmptyState v-else description="本单位暂无箱子数据" />

      <div v-if="flagChips.length" class="flag-strip" role="group" aria-label="异常箱子">
        <button
          v-for="chip in flagChips"
          :key="chip.key"
          type="button"
          class="flag-chip"
          :class="`is-${chip.tone}`"
          :aria-label="`${chip.label} ${chip.value} 台，查看这些箱子`"
          @click="openTile(chip.key)"
        >
          <i class="dot" aria-hidden="true" />
          {{ chip.label }}
          <b>{{ chip.value }}</b>
        </button>
      </div>

      <SectionCard
        v-if="!data.station && data.stats"
        title="状态分布"
        :sub="`共 ${data.stats.total.toLocaleString()} 台`"
      >
        <template v-if="data.stats.total > 0">
          <DistributionBar :segments="segments" :height="10" />
          <div class="legend">
            <span v-for="seg in segments" :key="seg.label" class="legend-item">
              <i class="dot" :style="{ background: seg.color }" aria-hidden="true" />
              {{ seg.label }}
              <b>{{ seg.value.toLocaleString() }}</b>
              <em>{{ percent(seg.value, data.stats.total) }}</em>
            </span>
          </div>
        </template>
        <EmptyState v-else description="本单位还没有箱子" />
      </SectionCard>

      <SectionCard
        v-if="data.station"
        title="送检明细"
        :sub="`${data.station.companyTotal} 家来源公司`"
        flush
      >
        <StationBoard
          :key="orgId"
          v-model:tab="stationTab"
          :station="data.station"
          :day-text="dayText"
          @query="onStationQuery"
        />
      </SectionCard>

      <div v-if="data.tasks" class="day-grid" data-test="unit-day">
        <SectionCard title="按日查看任务" :sub="dayText">
          <template #extra>
            <el-button size="small" :disabled="isToday" @click="goToday">今天</el-button>
          </template>
          <ControlledCalendar
            :day="day"
            :month="month"
            :counts="data.calendar"
            :loading="loading"
            @select="onSelectDay"
            @month-change="onMonthChange"
            @today="goToday"
          />
        </SectionCard>
        <SectionCard :title="`${dayText}任务`" sub="点任务看详情">
          <DayTasks :tasks="data.tasks" :day-text="dayText" />
        </SectionCard>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: "SampleOverviewUnit" });

import { AlarmClock, ArrowLeft, Box, House, Refresh, Van } from "@element-plus/icons-vue";
import OverviewAPI, { type UnitOverview } from "@/api/sample/overview";
import DistributionBar, { type DistSegment } from "@/components/biz/DistributionBar.vue";
import FreshnessMeta from "@/components/biz/FreshnessMeta.vue";
import PageHeader from "@/components/biz/PageHeader.vue";
import SectionCard from "@/components/biz/SectionCard.vue";
import ControlledCalendar from "@/components/ov/ControlledCalendar.vue";
import EmptyState from "@/components/ov/EmptyState.vue";
import ErrorState from "@/components/ov/ErrorState.vue";
import FlowPipeline from "@/components/ov/FlowPipeline.vue";
import KpiCard from "@/components/ov/KpiCard.vue";
import type { FlowStep, KpiItem } from "@/components/ov/types";
import { monthOf, todayStr } from "@/composables/useCalendarGrid";
import { useOverviewPolling } from "@/composables/useOverviewPolling";
import { lifeLabel } from "@/utils/labels";
import DayTasks from "./components/DayTasks.vue";
import StationBoard, { type StationQuery } from "./components/StationBoard.vue";

/**
 * 单位总览（补充协议 1.2.8、1.2.9）：分公司看 KPI + 状态分布 + 日历选日看任务时间线；
 * 检测站看流转管线（点段切页签）+ 来源公司主从明细 + 日历任务时间线。
 * 每 5 秒轮询，后台暂停、失败退避；轮询只换数据，不重置选中日 / 页签 / 公司选择。
 */
const route = useRoute();
const router = useRouter();
const orgId = computed(() => String(route.params.orgId || ""));
const data = ref<UnitOverview | null>(null);

const today = todayStr();
const day = ref(
  typeof route.query.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(route.query.day)
    ? route.query.day
    : today
);
const month = ref(monthOf(day.value));
const stationTab = ref("waiting");
const stationQuery = ref<StationQuery>({
  company: "",
  companyQ: "",
  companyPage: 1,
  waitingPage: 1,
  donePage: 1,
  inboundPage: 1,
});

const dayText = computed(() =>
  day.value === today
    ? "今天"
    : `${Number(day.value.slice(5, 7))} 月 ${Number(day.value.slice(8))} 日`
);
const isToday = computed(() => day.value === today);

let token = 0;
async function load(): Promise<boolean> {
  if (!orgId.value) return false;
  const mine = ++token;
  const id = orgId.value;
  const result = await OverviewAPI.unit(id, {
    day: day.value,
    month: month.value,
    company: stationQuery.value.company,
    companyQ: stationQuery.value.companyQ,
    companyPage: stationQuery.value.companyPage,
    waitingPage: stationQuery.value.waitingPage,
    donePage: stationQuery.value.donePage,
    inboundPage: stationQuery.value.inboundPage,
  });
  if (mine !== token || id !== orgId.value) return false;
  data.value = result;
  return true;
}
const { updatedAt, error, errorCode, loading, refresh } = useOverviewPolling(load, 5000);

/** 404/范围外错态的出口：回总览入口，由它按数据范围落到自己有权看的单位（R4）。 */
function backToMyOverview() {
  void router.replace("/monitor/overview");
}

function percent(value: number, total: number) {
  return `${total > 0 ? Math.round((value / total) * 100) : 0}%`;
}

const kpis = computed<KpiItem[]>(() => {
  const s = data.value?.stats;
  if (!s) return [];
  const moving = s.counts["在途"] ?? 0;
  const idle = s.counts["未使用"] ?? 0;
  const pending = s.counts["待激活"] ?? 0;
  const stopped = s.counts["停用"] ?? 0;
  return [
    {
      key: "total",
      label: "箱子总数",
      value: s.total,
      clickable: false,
      icon: Box,
      hint: `${lifeLabel("停用")} ${stopped.toLocaleString()} 台`,
    },
    {
      key: "life:在途",
      label: lifeLabel("在途"),
      value: moving,
      tone: "primary",
      icon: Van,
      hint: `占总数 ${percent(moving, s.total)}`,
    },
    {
      key: "life:未使用",
      label: "在仓库",
      value: idle,
      tone: "success",
      icon: House,
      hint: `占总数 ${percent(idle, s.total)}`,
    },
    {
      key: "life:待激活",
      label: lifeLabel("待激活"),
      value: pending,
      tone: pending ? "warning" : "default",
      icon: AlarmClock,
      hint: `占总数 ${percent(pending, s.total)}`,
    },
  ];
});
const flowSteps = computed<FlowStep[]>(() => {
  const st = data.value?.station;
  if (!st) return [];
  return [
    { key: "inbound", label: "运往本站途中", value: st.moving, tone: "primary" },
    {
      key: "waiting",
      label: "已到 · 未开箱检测",
      value: st.arrived,
      tone: st.arrived ? "warning" : "default",
    },
    { key: "done", label: `${dayText.value}已开箱检测`, value: st.inspected, tone: "success" },
  ];
});
const flagChips = computed(() => {
  const f = data.value?.stats?.flags;
  if (!f) return [];
  return [
    { key: "flag:alert", label: "告警", value: f.alert ?? 0, tone: "danger" },
    { key: "flag:offline", label: "离线", value: f.offline ?? 0, tone: "warning" },
    { key: "flag:low", label: "低电量", value: f.low ?? 0, tone: "danger" },
  ].filter((chip) => chip.value > 0);
});
const segments = computed<DistSegment[]>(() => {
  const s = data.value?.stats;
  if (!s) return [];
  return [
    { label: lifeLabel("在途"), value: s.counts["在途"] ?? 0, color: "var(--el-color-primary)" },
    { label: "在仓库", value: s.counts["未使用"] ?? 0, color: "var(--el-color-success)" },
    {
      label: lifeLabel("待激活"),
      value: s.counts["待激活"] ?? 0,
      color: "var(--el-color-warning)",
    },
    { label: lifeLabel("停用"), value: s.counts["停用"] ?? 0, color: "var(--status-stale)" },
  ];
});

function openTile(key: string) {
  if (key) void router.push({ path: "/device/boxes", query: { orgId: orgId.value, tile: key } });
}
function openBoxes() {
  void router.push({ path: "/device/boxes", query: { orgId: orgId.value } });
}
function onFlowStep(key: string) {
  stationTab.value = key;
}
function onStationQuery(q: StationQuery) {
  stationQuery.value = q;
  void refresh();
}
function onDayChange(next: string, nextMonth: string) {
  day.value = next;
  month.value = nextMonth;
  void router.replace({ query: { ...route.query, day: next } });
  void refresh();
}
function onSelectDay(next: string) {
  onDayChange(next, monthOf(next));
}
function onMonthChange(nextMonth: string) {
  // 翻月只换显示月与角标数据，不动选中日
  month.value = nextMonth;
  void refresh();
}
function goToday() {
  onDayChange(today, monthOf(today));
}

watch(orgId, () => {
  stationTab.value = "waiting";
  stationQuery.value = {
    company: "",
    companyQ: "",
    companyPage: 1,
    waitingPage: 1,
    donePage: 1,
    inboundPage: 1,
  };
  void refresh();
});
</script>

<style scoped>
.path-text {
  margin-right: 10px;
  font-size: 12px;
  color: var(--el-text-color-placeholder);
}
.unit-error-guide {
  display: flex;
  flex-direction: column;
  gap: 12px;
  align-items: center;
}
.unit-error-guide .guide-text {
  max-width: 460px;
  margin: 0;
  font-size: 13px;
  line-height: 1.7;
  text-align: center;
}
.unit-error-guide .guide-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: center;
}
.kpi-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--page-gap);
}
.flag-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.flag-chip {
  display: inline-flex;
  gap: 6px;
  align-items: center;
  padding: 5px 12px;
  font: inherit;
  font-size: 13px;
  color: var(--el-text-color-regular);
  cursor: pointer;
  background: var(--content-bg);
  border: 1px solid var(--card-border);
  border-radius: 999px;
  transition: border-color var(--motion-fast, 150ms);
}
.flag-chip:hover {
  border-color: var(--card-border-hover);
}
.flag-chip:focus-visible {
  outline: var(--focus-ring, 2px solid var(--el-color-primary));
  outline-offset: 1px;
}
.flag-chip .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
}
.flag-chip b {
  font-variant-numeric: tabular-nums;
}
.flag-chip.is-danger .dot {
  background: var(--status-danger);
}
.flag-chip.is-danger b {
  color: var(--status-danger);
}
.flag-chip.is-warning .dot {
  background: var(--status-warn);
}
.flag-chip.is-warning b {
  color: var(--status-warn);
}
.legend {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
  margin-top: 12px;
}
.legend-item {
  display: flex;
  gap: 6px;
  align-items: center;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}
.legend-item .dot {
  flex-shrink: 0;
  width: 8px;
  height: 8px;
  border-radius: 50%;
}
.legend-item b {
  font-variant-numeric: tabular-nums;
  color: var(--el-text-color-primary);
}
.legend-item em {
  font-size: 12px;
  font-style: normal;
  font-variant-numeric: tabular-nums;
  color: var(--el-text-color-placeholder);
}
.day-grid {
  display: grid;
  grid-template-columns: 400px minmax(0, 1fr);
  gap: var(--page-gap);
  align-items: start;
}
@media (max-width: 1024px) {
  .kpi-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .day-grid {
    grid-template-columns: minmax(0, 1fr);
  }
  .legend {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
@media (max-width: 480px) {
  .kpi-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
