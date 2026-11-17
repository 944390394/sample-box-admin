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
        <span v-if="updatedAt" class="freshness" :class="{ stale: dataStale }">
          <i class="dot" />
          更新于 {{ ageText(updatedAt.toISOString()) }}
          <em v-if="dataStale">旧</em>
        </span>
        <span v-if="!error" class="auto-hint">
          <i class="pulse" />
          每 5 秒自动刷新
        </span>
      </template>
      <template #actions>
        <el-button :icon="Refresh" :loading="loading" @click="refresh">刷新</el-button>
        <el-button :icon="Box" @click="router.push({ path: '/device/boxes', query: { orgId } })">
          本单位的箱子
        </el-button>
      </template>
    </PageHeader>

    <el-alert v-if="error" type="warning" :closable="false" show-icon>
      <template #title>
        刷新失败：{{ error }}
        <el-button link type="primary" size="small" @click="refresh">重试</el-button>
      </template>
    </el-alert>

    <el-skeleton v-if="!data && loading" :rows="8" animated />
    <template v-else-if="data">
      <StatTiles v-if="data.station" :items="stationTiles" :max="3" data-test="station-tiles" />
      <StatTiles
        v-else
        :items="tiles"
        :max="4"
        data-test="unit-tiles"
        @update:model-value="openTile"
      />

      <div v-if="flagChips.length" class="flag-strip">
        <button
          v-for="chip in flagChips"
          :key="chip.key"
          class="flag-chip"
          :class="`is-${chip.tone}`"
          @click="openTile(chip.key)"
        >
          <i class="dot" />
          {{ chip.label }}
          <b>{{ chip.value }}</b>
        </button>
      </div>

      <SectionCard
        v-if="!data.station && data.stats"
        title="状态分布"
        :sub="`共 ${data.stats.total.toLocaleString()} 台`"
      >
        <DistributionBar :segments="segments" :height="10" />
        <div class="legend">
          <span v-for="seg in segments" :key="seg.label" class="legend-item">
            <i class="dot" :style="{ background: seg.color }" />
            {{ seg.label }}
            <b>{{ seg.value.toLocaleString() }}</b>
            <em v-if="data.stats.total">{{ Math.round((seg.value / data.stats.total) * 100) }}%</em>
          </span>
        </div>
      </SectionCard>

      <SectionCard
        v-if="data.station"
        title="送检明细"
        :sub="`${data.station.companyTotal} 家来源公司`"
        flush
      >
        <StationBoard
          :key="orgId"
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
          <UnitCalendar :day="day" :calendar="data.calendar" @change="onDayChange" />
        </SectionCard>
        <SectionCard :title="`${dayText}任务`" :sub="`${data.tasks.length} 张`">
          <DayTasks :tasks="data.tasks" :day-text="dayText" />
        </SectionCard>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: "SampleOverviewUnit" });

import {
  AlarmClock,
  Box,
  CircleCheck,
  House,
  Refresh,
  Suitcase,
  Van,
} from "@element-plus/icons-vue";
import OverviewAPI, { type UnitOverview } from "@/api/sample/overview";
import DistributionBar, { type DistSegment } from "@/components/biz/DistributionBar.vue";
import PageHeader from "@/components/biz/PageHeader.vue";
import SectionCard from "@/components/biz/SectionCard.vue";
import StatTiles, { type StatTile } from "@/components/biz/StatTiles.vue";
import { useOverviewPolling } from "@/composables/useOverviewPolling";
import { lifeLabel } from "@/utils/labels";
import { ageText } from "@/utils/position";
import { clock } from "@/utils/time";
import DayTasks from "./components/DayTasks.vue";
import StationBoard, { type StationQuery } from "./components/StationBoard.vue";
import UnitCalendar from "./components/UnitCalendar.vue";

/**
 * 单位总览（补充协议 1.2.8、1.2.9）：分公司看箱子数量状态、日历选日看任务；
 * 检测站看在途 / 已到未检测 / 已检测的流转，来源公司主从列表 + 三页签明细。
 * 每 5 秒轮询，后台暂停、失败退避；明细全部服务端分页。
 */
const route = useRoute();
const router = useRouter();
const orgId = computed(() => String(route.params.orgId || ""));
const data = ref<UnitOverview | null>(null);

function pad(n: number) {
  return String(n).padStart(2, "0");
}
function localDay(d: Date) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
const today = localDay(new Date());
const day = ref(
  typeof route.query.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(route.query.day)
    ? route.query.day
    : today
);
const month = ref(day.value.slice(0, 7));
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
const { updatedAt, error, loading, refresh } = useOverviewPolling(load, 5000);
const dataStale = computed(
  () =>
    Boolean(error.value) ||
    (updatedAt.value ? clock.value - updatedAt.value.getTime() > 20000 : false)
);

const tiles = computed<StatTile[]>(() => {
  const s = data.value?.stats;
  if (!s) return [];
  return [
    { key: "total", label: "箱子总数", value: s.total, clickable: false, icon: Box },
    {
      key: "life:在途",
      label: lifeLabel("在途"),
      value: s.counts["在途"] ?? 0,
      tone: "primary",
      icon: Van,
    },
    {
      key: "life:未使用",
      label: "在仓库",
      value: s.counts["未使用"] ?? 0,
      tone: "success",
      icon: House,
    },
    {
      key: "life:待激活",
      label: lifeLabel("待激活"),
      value: s.counts["待激活"] ?? 0,
      tone: s.counts["待激活"] ? "warning" : "default",
      icon: AlarmClock,
    },
  ];
});
const stationTiles = computed<StatTile[]>(() => {
  const st = data.value?.station;
  if (!st) return [];
  return [
    {
      key: "moving",
      label: "运往本站途中",
      value: st.moving,
      tone: "primary",
      clickable: false,
      icon: Van,
    },
    {
      key: "arrived",
      label: "已到 · 未开箱检测",
      value: st.arrived,
      tone: st.arrived ? "warning" : "default",
      clickable: false,
      icon: Suitcase,
    },
    {
      key: "inspected",
      label: `${dayText.value}已开箱检测`,
      value: st.inspected,
      tone: "success",
      clickable: false,
      icon: CircleCheck,
    },
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
function goToday() {
  onDayChange(today, today.slice(0, 7));
}

watch(orgId, () => {
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
.freshness {
  display: inline-flex;
  gap: 5px;
  align-items: center;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: var(--el-text-color-secondary);
}
.freshness .dot {
  width: 6px;
  height: 6px;
  background: var(--status-ok);
  border-radius: 50%;
}
.freshness.stale .dot {
  background: var(--status-warn);
}
.freshness em {
  padding: 0 4px;
  font-size: 11px;
  font-style: normal;
  line-height: 16px;
  color: var(--status-stale);
  border: 1px solid currentcolor;
  border-radius: 3px;
}
.auto-hint {
  display: inline-flex;
  gap: 5px;
  align-items: center;
  margin-left: 10px;
  font-size: 12px;
  color: var(--el-text-color-placeholder);
}
.pulse {
  width: 6px;
  height: 6px;
  background: var(--el-color-primary);
  border-radius: 50%;
  animation: pulse 2s ease-in-out infinite;
}
@keyframes pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.25;
  }
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
  transition: border-color 0.15s;
}
.flag-chip:hover {
  border-color: var(--card-border-hover);
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
@media (max-width: 1000px) {
  .day-grid {
    grid-template-columns: minmax(0, 1fr);
  }
  .legend {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
