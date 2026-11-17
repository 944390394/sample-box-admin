<template>
  <div class="page-container page-flow">
    <PageHeader title="集团总览" :subtitle="headerSub">
      <template #meta>
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
      </template>
    </PageHeader>

    <el-alert v-if="error" type="warning" :closable="false" show-icon>
      <template #title>
        刷新失败：{{ error }}
        <el-button link type="primary" size="small" @click="refresh">重试</el-button>
      </template>
    </el-alert>

    <el-skeleton v-if="!data && loading" :rows="8" animated />
    <el-empty
      v-else-if="data && !data.branchTotal && !data.stationCount"
      description="你的数据范围里没有单位，只能看到自己保管的箱子"
    />
    <template v-else-if="data">
      <StatTiles
        :items="tiles"
        :max="6"
        data-test="group-station-tiles"
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

      <div v-if="data.total && data.total.total > 0" class="charts">
        <SectionCard title="箱子状态分布" :sub="`共 ${data.total.total.toLocaleString()} 台`">
          <div class="donut-wrap">
            <ECharts :options="donutOptions" height="240px" />
            <div class="donut-center">
              <strong>{{ data.total.total.toLocaleString() }}</strong>
              <span>台</span>
            </div>
          </div>
        </SectionCard>
        <SectionCard title="箱子最多的分公司" sub="前 8 家 · 按总数">
          <ECharts v-if="data.top.length" :options="topOptions" height="240px" />
          <el-empty v-else description="暂无分公司箱子" :image-size="60" />
        </SectionCard>
      </div>

      <SectionCard
        title="单位列表"
        :sub="`${data.unitTotal.toLocaleString()} 家`"
        flush
        data-test="group-units"
      >
        <template #extra>
          <el-radio-group v-model="typeFilter" size="small">
            <el-radio-button value="">全部</el-radio-button>
            <el-radio-button value="branch">分公司</el-radio-button>
            <el-radio-button value="station">检测站</el-radio-button>
          </el-radio-group>
          <el-select v-model="sort" size="small" style="width: 124px">
            <el-option label="箱子最多" value="total" />
            <el-option label="在途最多" value="moving" />
            <el-option label="异常最多" value="alert" />
            <el-option label="按名称" value="name" />
          </el-select>
          <el-input
            v-model="keyword"
            size="small"
            clearable
            placeholder="搜索单位名称"
            :prefix-icon="Search"
            style="width: 190px"
          />
        </template>

        <el-table
          v-if="!isMobile"
          v-loading="loading"
          :data="data.units"
          class="unit-table"
          max-height="560"
          @row-click="openUnit"
        >
          <el-table-column label="单位" min-width="240">
            <template #default="{ row }">
              <div class="unit-cell" :data-test="`unit-${row.id}`">
                <span class="avatar" :class="{ 'is-station': row.station }">
                  {{ row.name.slice(0, 1) }}
                </span>
                <div class="unit-name">
                  <div class="name-line">
                    <b>{{ row.name }}</b>
                    <el-tag
                      size="small"
                      :type="row.station ? 'warning' : row.hq ? 'info' : 'primary'"
                      effect="plain"
                    >
                      {{ row.station ? "检测站" : row.hq ? "总部" : "分公司" }}
                    </el-tag>
                  </div>
                  <div v-if="row.path !== row.name" class="text-muted path">{{ row.path }}</div>
                </div>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="状态分布" min-width="140">
            <template #default="{ row }">
              <DistributionBar v-if="row.stats" :segments="segmentsOf(row)" />
              <span v-else class="zero">—</span>
            </template>
          </el-table-column>
          <el-table-column label="箱子" width="82" align="right">
            <template #default="{ row }">
              <span class="num">{{ num(row, "total") }}</span>
            </template>
          </el-table-column>
          <el-table-column :label="lifeLabel('在途')" width="82" align="right">
            <template #default="{ row }">
              <span class="num" :class="tone(row, 'moving', 'primary')">
                {{ num(row, "moving") }}
              </span>
            </template>
          </el-table-column>
          <el-table-column label="在仓库" width="90" align="right">
            <template #default="{ row }">
              <span class="num" :class="tone(row, 'idle', 'success')">{{ num(row, "idle") }}</span>
            </template>
          </el-table-column>
          <el-table-column :label="lifeLabel('待激活')" width="90" align="right">
            <template #default="{ row }">
              <span class="num" :class="tone(row, 'pending', 'warning')">
                {{ num(row, "pending") }}
              </span>
            </template>
          </el-table-column>
          <el-table-column label="检测流转" width="180">
            <template #default="{ row }">
              <div v-if="row.station" class="flow-cell">
                <span>
                  来站
                  <b :class="{ zero: !row.station.moving }">{{ row.station.moving }}</b>
                </span>
                <span>
                  待检
                  <b :class="{ warn: row.station.arrived, zero: !row.station.arrived }">
                    {{ row.station.arrived }}
                  </b>
                </span>
                <span>
                  今检
                  <b :class="{ ok: row.station.inspected, zero: !row.station.inspected }">
                    {{ row.station.inspected }}
                  </b>
                </span>
              </div>
              <span v-else class="zero">—</span>
            </template>
          </el-table-column>
          <el-table-column label="异常" min-width="150">
            <template #default="{ row }">
              <div v-if="row.stats && hasFlags(row)" class="flag-cell">
                <el-tag v-if="row.stats.flags.offline" size="small" type="info" effect="plain">
                  离线 {{ row.stats.flags.offline }}
                </el-tag>
                <el-tag v-if="row.stats.flags.low" size="small" type="warning" effect="plain">
                  低电 {{ row.stats.flags.low }}
                </el-tag>
                <el-tag v-if="row.stats.flags.alert" size="small" type="danger" effect="plain">
                  告警 {{ row.stats.flags.alert }}
                </el-tag>
              </div>
              <span v-else class="zero">—</span>
            </template>
          </el-table-column>
          <template #empty>
            <el-empty description="没有匹配的单位" :image-size="70">
              <el-button v-if="keyword || typeFilter" size="small" @click="clearFilter">
                清除筛选
              </el-button>
            </el-empty>
          </template>
        </el-table>

        <div v-else v-loading="loading" class="unit-cards">
          <button
            v-for="row in data.units"
            :key="row.id"
            class="unit-card"
            :data-test="`unit-${row.id}`"
            @click="openUnit(row)"
          >
            <div class="name-line">
              <b>{{ row.name }}</b>
              <el-tag
                size="small"
                :type="row.station ? 'warning' : row.hq ? 'info' : 'primary'"
                effect="plain"
              >
                {{ row.station ? "检测站" : row.hq ? "总部" : "分公司" }}
              </el-tag>
              <el-icon class="go"><ArrowRight /></el-icon>
            </div>
            <div v-if="row.path !== row.name" class="text-muted path">{{ row.path }}</div>
            <DistributionBar v-if="row.stats" :segments="segmentsOf(row)" class="card-bar" />
            <div class="card-nums">
              <span>
                箱子
                <b>{{ num(row, "total") }}</b>
              </span>
              <template v-if="row.station">
                <span>
                  来站
                  <b>{{ row.station.moving }}</b>
                </span>
                <span>
                  待检
                  <b :class="{ warn: row.station.arrived }">{{ row.station.arrived }}</b>
                </span>
                <span>
                  今检
                  <b :class="{ ok: row.station.inspected }">{{ row.station.inspected }}</b>
                </span>
              </template>
              <template v-else>
                <span>
                  {{ lifeLabel("在途") }}
                  <b :class="{ primary: valueOf(row, 'moving') }">{{ num(row, "moving") }}</b>
                </span>
                <span>
                  在仓库
                  <b :class="{ ok: valueOf(row, 'idle') }">{{ num(row, "idle") }}</b>
                </span>
              </template>
            </div>
            <div v-if="row.stats && hasFlags(row)" class="flag-cell">
              <el-tag v-if="row.stats.flags.offline" size="small" type="info" effect="plain">
                离线 {{ row.stats.flags.offline }}
              </el-tag>
              <el-tag v-if="row.stats.flags.low" size="small" type="warning" effect="plain">
                低电 {{ row.stats.flags.low }}
              </el-tag>
              <el-tag v-if="row.stats.flags.alert" size="small" type="danger" effect="plain">
                告警 {{ row.stats.flags.alert }}
              </el-tag>
            </div>
          </button>
          <el-empty v-if="!data.units.length" description="没有匹配的单位" :image-size="70">
            <el-button v-if="keyword || typeFilter" size="small" @click="clearFilter">
              清除筛选
            </el-button>
          </el-empty>
        </div>

        <div v-if="data.unitTotal > 0" class="table-foot">
          <el-pagination
            v-model:current-page="page"
            v-model:page-size="pageSize"
            background
            :layout="
              isMobile ? 'total, prev, pager, next' : 'total, sizes, prev, pager, next, jumper'
            "
            :total="data.unitTotal"
            :page-sizes="[20, 50, 100]"
          />
        </div>
      </SectionCard>
    </template>
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: "SampleOverview" });

import {
  ArrowRight,
  Box,
  CircleCheck,
  House,
  Position,
  Refresh,
  Search,
  Suitcase,
  Van,
} from "@element-plus/icons-vue";
import { refDebounced, useMediaQuery } from "@vueuse/core";
import OverviewAPI, {
  type BoxStats,
  type GroupOverview,
  type StationCounts,
} from "@/api/sample/overview";
import DistributionBar, { type DistSegment } from "@/components/biz/DistributionBar.vue";
import PageHeader from "@/components/biz/PageHeader.vue";
import SectionCard from "@/components/biz/SectionCard.vue";
import StatTiles, { type StatTile } from "@/components/biz/StatTiles.vue";
import ECharts from "@/components/ECharts/index.vue";
import { useChartPalette } from "@/composables/useChartPalette";
import { useOverviewPolling } from "@/composables/useOverviewPolling";
import { lifeLabel } from "@/utils/labels";
import { ageText } from "@/utils/position";
import { clock } from "@/utils/time";

/**
 * 集团总览（补充协议 1.2.10）：全局指标、状态分布、Top 分公司，下面一张可搜索筛选排序的单位列表。
 * 单位几千家公司时列表在服务端分页，页面只拿一页；每 5 秒轮询，后台暂停、失败退避。
 */
const router = useRouter();
const data = ref<GroupOverview | null>(null);
const palette = useChartPalette();
const isMobile = useMediaQuery("(max-width: 767px)");

const keyword = ref("");
const debouncedKeyword = refDebounced(keyword, 300);
const typeFilter = ref<"" | "branch" | "station">("");
const sort = ref<"total" | "moving" | "alert" | "name">("total");
const page = ref(1);
const pageSize = ref(20);

let token = 0;
async function load(): Promise<boolean> {
  const mine = ++token;
  const result = await OverviewAPI.group({
    q: debouncedKeyword.value.trim(),
    type: typeFilter.value,
    sort: sort.value,
    page: page.value,
    pageSize: pageSize.value,
  });
  if (mine !== token) return false;
  // 数据范围里只有一个单位时直接进它的总览
  if (
    result.unitTotal === 1 &&
    result.units.length === 1 &&
    !debouncedKeyword.value.trim() &&
    !typeFilter.value
  ) {
    void router.replace(`/monitor/overview/${result.units[0].id}`);
    return false;
  }
  data.value = result;
  return true;
}
const { updatedAt, error, loading, refresh } = useOverviewPolling(load, 5000);

const headerSub = computed(() =>
  data.value
    ? `${data.value.branchTotal.toLocaleString()} 家分公司 · ${data.value.stationCount} 个检测站`
    : ""
);
const dataStale = computed(
  () =>
    Boolean(error.value) ||
    (updatedAt.value ? clock.value - updatedAt.value.getTime() > 20000 : false)
);

type ColKey = "total" | "moving" | "idle" | "pending";
/** el-table 插槽行是宽松类型，这里只要求用到的字段 */
type UnitLike = { stats?: BoxStats | null; station?: StationCounts | null };
function valueOf(unit: UnitLike, key: ColKey): number | null {
  const s = unit.stats;
  if (!s) return null;
  if (key === "total") return s.total;
  if (key === "moving") return s.counts["在途"] ?? 0;
  if (key === "idle") return s.counts["未使用"] ?? 0;
  return s.counts["待激活"] ?? 0;
}
function num(unit: UnitLike, key: ColKey) {
  const value = valueOf(unit, key);
  return value == null ? "—" : value.toLocaleString();
}
function tone(unit: UnitLike, key: ColKey, name: string) {
  return valueOf(unit, key) ? `tone-${name}` : "zero";
}
function hasFlags(unit: UnitLike) {
  const f = unit.stats?.flags;
  return Boolean(f && (f.offline || f.low || f.alert));
}
function segmentsOf(unit: UnitLike): DistSegment[] {
  const s = unit.stats;
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
}

const tiles = computed<StatTile[]>(() => {
  const s = data.value?.total;
  if (!s) return [];
  const list: StatTile[] = [
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
  ];
  const st = data.value?.stationTotal;
  if (st) {
    list.push(
      {
        key: "moving",
        label: "运往检测站",
        value: st.moving,
        tone: "primary",
        clickable: false,
        icon: Position,
      },
      {
        key: "arrived",
        label: "已到检测站 · 未开箱检测",
        value: st.arrived,
        tone: st.arrived ? "warning" : "default",
        clickable: false,
        icon: Suitcase,
      },
      {
        key: "inspected",
        label: "今日已检测",
        value: st.inspected,
        tone: "success",
        clickable: false,
        icon: CircleCheck,
      }
    );
  }
  return list;
});

const flagChips = computed(() => {
  const f = data.value?.total?.flags;
  if (!f) return [];
  return [
    { key: "flag:alert", label: "告警", value: f.alert ?? 0, tone: "danger" },
    { key: "flag:offline", label: "离线", value: f.offline ?? 0, tone: "warning" },
    { key: "flag:low", label: "低电量", value: f.low ?? 0, tone: "danger" },
  ].filter((chip) => chip.value > 0);
});

const donutOptions = computed(() => {
  const p = palette.value;
  const s = data.value?.total;
  if (!s) return {};
  const parts = [
    { name: lifeLabel("在途"), value: s.counts["在途"] ?? 0, color: p.primary },
    { name: "在仓库", value: s.counts["未使用"] ?? 0, color: p.success },
    { name: lifeLabel("待激活"), value: s.counts["待激活"] ?? 0, color: p.warning },
    { name: lifeLabel("停用"), value: s.counts["停用"] ?? 0, color: p.info },
  ].filter((part) => part.value > 0);
  return {
    tooltip: { trigger: "item", formatter: "{b}：{c} 台（{d}%）" },
    legend: {
      bottom: 0,
      icon: "circle",
      itemWidth: 8,
      itemHeight: 8,
      itemGap: 14,
      textStyle: { color: p.textSecondary, fontSize: 12 },
    },
    series: [
      {
        type: "pie",
        radius: ["60%", "80%"],
        center: ["50%", "44%"],
        padAngle: 2,
        itemStyle: { borderColor: p.bg, borderWidth: 2, borderRadius: 5 },
        label: { show: false },
        emphasis: { scaleSize: 4 },
        data: parts.map((part) => ({
          name: part.name,
          value: part.value,
          itemStyle: { color: part.color },
        })),
      },
    ],
  };
});

const topOptions = computed(() => {
  const p = palette.value;
  const top = data.value?.top || [];
  const names = top.map((item) => item.name);
  const seriesOf = (name: string, key: "moving" | "idle" | "pending", color: string) => ({
    name,
    type: "bar",
    stack: "total",
    barWidth: 14,
    itemStyle: { color },
    emphasis: { focus: "series" },
    data: top.map((item) => item[key]),
  });
  return {
    tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
    legend: {
      bottom: 0,
      icon: "circle",
      itemWidth: 8,
      itemHeight: 8,
      itemGap: 14,
      textStyle: { color: p.textSecondary, fontSize: 12 },
    },
    grid: { left: 8, right: 28, top: 8, bottom: 30, containLabel: true },
    xAxis: {
      type: "value",
      splitLine: { lineStyle: { color: p.splitLine } },
      axisLabel: { color: p.textSecondary, fontSize: 11 },
    },
    yAxis: {
      type: "category",
      inverse: true,
      data: names,
      axisTick: { show: false },
      axisLine: { show: false },
      axisLabel: {
        color: p.text,
        fontSize: 12,
        formatter: (value: string) => (value.length > 7 ? `${value.slice(0, 7)}…` : value),
      },
    },
    series: [
      seriesOf(lifeLabel("在途"), "moving", p.primary),
      seriesOf("在仓库", "idle", p.success),
      seriesOf(lifeLabel("待激活"), "pending", p.warning),
    ],
  };
});

function openTile(key: string) {
  if (key.startsWith("life:") || key.startsWith("flag:"))
    void router.push({ path: "/device/boxes", query: { tile: key } });
}
function openUnit(row: { id: string }) {
  void router.push(`/monitor/overview/${row.id}`);
}
function clearFilter() {
  keyword.value = "";
  typeFilter.value = "";
}

watch([debouncedKeyword, typeFilter, sort], () => {
  if (page.value !== 1) page.value = 1;
  else void refresh();
});
watch([page, pageSize], () => {
  void refresh();
});
</script>

<style scoped>
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
.charts {
  display: grid;
  grid-template-columns: minmax(0, 2fr) minmax(0, 3fr);
  gap: var(--page-gap);
}
.donut-wrap {
  position: relative;
}
.donut-center {
  position: absolute;
  top: 44%;
  left: 50%;
  display: flex;
  flex-direction: column;
  align-items: center;
  pointer-events: none;
  transform: translate(-50%, -50%);
}
.donut-center strong {
  font-size: 26px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  line-height: 1.2;
  color: var(--el-text-color-primary);
}
.donut-center span {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.unit-table {
  width: 100%;
}
.unit-table :deep(.el-table__row) {
  cursor: pointer;
}
.unit-cell {
  display: flex;
  gap: 10px;
  align-items: center;
  min-width: 0;
}
.avatar {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  font-size: 14px;
  font-weight: 600;
  color: var(--el-color-primary);
  background: color-mix(in srgb, var(--el-color-primary) 10%, transparent);
  border-radius: 8px;
}
.avatar.is-station {
  color: var(--el-color-warning);
  background: color-mix(in srgb, var(--el-color-warning) 12%, transparent);
}
.unit-name {
  min-width: 0;
}
.name-line {
  display: flex;
  gap: 8px;
  align-items: center;
  min-width: 0;
}
.name-line b {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.path {
  margin-top: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 12px;
  white-space: nowrap;
}
.num {
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.zero {
  font-weight: 400;
  color: var(--el-text-color-placeholder);
}
.tone-primary {
  color: var(--el-color-primary);
}
.tone-success {
  color: var(--el-color-success);
}
.tone-warning {
  color: var(--el-color-warning);
}
.flow-cell {
  display: flex;
  gap: 10px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  white-space: nowrap;
}
.flow-cell b {
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  color: var(--el-text-color-primary);
}
.flow-cell b.warn {
  color: var(--el-color-warning);
}
.flow-cell b.ok {
  color: var(--el-color-success);
}
.flow-cell b.zero {
  color: var(--el-text-color-placeholder);
}
.flag-cell {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.table-foot {
  display: flex;
  justify-content: flex-end;
  padding: 12px 16px;
  border-top: 1px solid var(--card-divider);
}
.unit-cards {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 80px;
  padding: 12px;
}
.unit-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px;
  font: inherit;
  text-align: left;
  cursor: pointer;
  background: var(--content-bg);
  border: 1px solid var(--card-border);
  border-radius: 8px;
}
.unit-card .go {
  margin-left: auto;
  color: var(--el-text-color-placeholder);
}
.card-bar {
  margin: 2px 0;
}
.card-nums {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 14px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.card-nums b {
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  color: var(--el-text-color-primary);
}
.card-nums b.primary {
  color: var(--el-color-primary);
}
.card-nums b.warn {
  color: var(--el-color-warning);
}
.card-nums b.ok {
  color: var(--el-color-success);
}
@media (max-width: 1000px) {
  .charts {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
