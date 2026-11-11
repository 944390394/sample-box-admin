<template>
  <div class="page-container page-flow">
    <PageHeader title="总览" :subtitle="subtitle">
      <template #actions>
        <el-button :icon="Refresh" :loading="loading" @click="load">刷新</el-button>
      </template>
    </PageHeader>

    <el-skeleton v-if="!data && loading" :rows="6" animated />
    <el-empty
      v-else-if="data && !data.units.length"
      description="你的数据范围里没有单位，只能看到自己保管的箱子"
    />
    <template v-else-if="data">
      <StatTiles :items="tiles" :max="7" @update:model-value="openTile" />
      <StatTiles
        v-if="stationTiles.length"
        :items="stationTiles"
        :max="3"
        data-test="group-station-tiles"
      />

      <SectionCard
        title="各单位"
        :sub="`${data.units.length} 个单位 · 点一行进入单位总览`"
        flush
        data-test="group-units"
      >
        <template #extra>
          <span class="auto">
            <el-switch v-model="autoScroll" size="small" />
            <span class="text-muted">自动滚动</span>
          </span>
        </template>
        <div class="head-row">
          <span class="col-name">单位</span>
          <span v-for="col in COLS" :key="col.key" class="col-num">{{ col.label }}</span>
        </div>
        <div
          ref="scroller"
          class="scroller"
          @mouseenter="hover = true"
          @mouseleave="hover = false"
          @touchstart.passive="hover = true"
        >
          <button
            v-for="unit in data.units"
            :key="unit.id"
            type="button"
            class="unit-row"
            :data-test="`unit-${unit.id}`"
            @click="router.push(`/monitor/overview/${unit.id}`)"
          >
            <span class="col-name">
              <span class="name">
                <b>{{ unit.name }}</b>
                <el-tag size="small" :type="unit.station ? 'warning' : 'primary'" effect="plain">
                  {{ unit.hq ? "总部" : unit.station ? "检测站" : "分公司" }}
                </el-tag>
              </span>
              <span v-if="unit.path !== unit.name" class="text-muted path">{{ unit.path }}</span>
            </span>
            <span
              v-for="col in COLS"
              :key="col.key"
              class="col-num"
              :class="{
                zero: !valueOf(unit, col.key),
                [`tone-${col.tone}`]: valueOf(unit, col.key),
              }"
            >
              <em class="mobile-label">{{ col.label }}</em>
              {{ valueOf(unit, col.key) ?? "—" }}
            </span>
          </button>
        </div>
      </SectionCard>
    </template>
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: "SampleOverview" });

import { Refresh } from "@element-plus/icons-vue";
import OverviewAPI, { type GroupOverview, type OverviewUnit } from "@/api/sample/overview";
import PageHeader from "@/components/biz/PageHeader.vue";
import SectionCard from "@/components/biz/SectionCard.vue";
import StatTiles, { type StatTile } from "@/components/biz/StatTiles.vue";
import { lifeLabel } from "@/utils/labels";

/**
 * 集团总览（补充协议 1.2.10）：所有项目分公司（顶级单位）和检测站的箱子数量、状态，滚动列表，点一行进单位总览。
 * 只看得到一个单位的人（分公司、检测站的人员）直接进自己的单位总览。30 秒刷新。
 */
const router = useRouter();
const data = ref<GroupOverview | null>(null);
const loading = ref(false);
const updatedAt = ref<Date | null>(null);

const subtitle = computed(() =>
  updatedAt.value
    ? `各分公司、检测站的采样箱数量和状态 · 数据更新于 ${updatedAt.value.toTimeString().slice(0, 5)}，每 30 秒刷新`
    : "各分公司、检测站的采样箱数量和状态"
);

type ColKey =
  | "total"
  | "moving"
  | "idle"
  | "pending"
  | "offline"
  | "low"
  | "alert"
  | "inbound"
  | "arrived"
  | "inspected";
const COLS: { key: ColKey; label: string; tone: string }[] = [
  { key: "total", label: "箱子", tone: "default" },
  { key: "moving", label: lifeLabel("在途"), tone: "primary" },
  { key: "idle", label: "在仓库", tone: "success" },
  { key: "pending", label: lifeLabel("待激活"), tone: "warning" },
  { key: "offline", label: "离线", tone: "warning" },
  { key: "low", label: "低电量", tone: "danger" },
  { key: "alert", label: "告警", tone: "danger" },
  { key: "inbound", label: "来站在途", tone: "primary" },
  { key: "arrived", label: "待检测", tone: "warning" },
  { key: "inspected", label: "今日已检测", tone: "success" },
];

function valueOf(unit: OverviewUnit, key: ColKey): number | null {
  const s = unit.stats;
  if (key === "inbound") return unit.station ? unit.station.moving : null;
  if (key === "arrived") return unit.station ? unit.station.arrived : null;
  if (key === "inspected") return unit.station ? unit.station.inspected : null;
  if (!s) return null;
  if (key === "total") return s.total;
  if (key === "moving") return s.counts["在途"] ?? 0;
  if (key === "idle") return s.counts["未使用"] ?? 0;
  if (key === "pending") return s.counts["待激活"] ?? 0;
  return s.flags[key] ?? 0;
}

const tiles = computed<StatTile[]>(() => {
  const s = data.value?.total;
  if (!s) return [];
  return [
    { key: "total", label: "箱子总数", value: s.total, clickable: false },
    { key: "life:在途", label: lifeLabel("在途"), value: s.counts["在途"] ?? 0, tone: "primary" },
    {
      key: "life:未使用",
      label: "在仓库",
      value: s.counts["未使用"] ?? 0,
      tone: "success",
      hint: lifeLabel("未使用") === "在仓库" ? "" : `即「${lifeLabel("未使用")}」`,
    },
    {
      key: "life:待激活",
      label: lifeLabel("待激活"),
      value: s.counts["待激活"] ?? 0,
      tone: s.counts["待激活"] ? "warning" : "default",
    },
    {
      key: "flag:offline",
      label: "离线",
      value: s.flags.offline ?? 0,
      tone: s.flags.offline ? "warning" : "default",
    },
    {
      key: "flag:low",
      label: "低电量",
      value: s.flags.low ?? 0,
      tone: s.flags.low ? "danger" : "default",
    },
    {
      key: "flag:alert",
      label: "告警",
      value: s.flags.alert ?? 0,
      tone: s.flags.alert ? "danger" : "default",
    },
  ];
});
const stationTiles = computed<StatTile[]>(() => {
  const stations = (data.value?.units || []).filter((u) => u.station);
  if (!stations.length) return [];
  const sum = (key: "moving" | "arrived" | "inspected") =>
    stations.reduce((n, u) => n + (u.station?.[key] ?? 0), 0);
  return [
    {
      key: "moving",
      label: "运往检测站途中",
      value: sum("moving"),
      tone: "primary",
      clickable: false,
      hint: "已寄出、还没签收",
    },
    {
      key: "arrived",
      label: "已到检测站 · 未开箱检测",
      value: sum("arrived"),
      tone: "warning",
      clickable: false,
      hint: "已签收，等扫码开始检测",
    },
    {
      key: "inspected",
      label: "今日已开箱检测",
      value: sum("inspected"),
      tone: "success",
      clickable: false,
    },
  ];
});
function openTile(key: string) {
  if (key) void router.push({ path: "/device/boxes", query: { tile: key } });
}

async function load() {
  loading.value = true;
  try {
    const result = await OverviewAPI.group();
    // 只能看到一个单位：直接进它的总览
    if (result.units.length === 1) {
      void router.replace(`/monitor/overview/${result.units[0].id}`);
      return;
    }
    data.value = result;
    updatedAt.value = new Date();
  } finally {
    loading.value = false;
  }
}

/* 滚动列表：内容超出时慢慢往下滚，到底停 2 秒回到顶；鼠标放上去、手指按住或关掉开关就停。 */
const scroller = ref<HTMLElement | null>(null);
const autoScroll = ref(true);
const hover = ref(false);
const reduced =
  typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
let tick = 0;
let pauseUntil = 0;
function step() {
  const el = scroller.value;
  if (!el || !autoScroll.value || hover.value || reduced || document.hidden) return;
  if (el.scrollHeight <= el.clientHeight + 2) return;
  const now = Date.now();
  if (now < pauseUntil) return;
  if (el.scrollTop + el.clientHeight >= el.scrollHeight - 1) {
    pauseUntil = now + 2000;
    window.setTimeout(() => el.scrollTo({ top: 0, behavior: "smooth" }), 2000);
    pauseUntil = now + 4000;
    return;
  }
  el.scrollTop += 1;
}
watch(hover, (on) => {
  if (!on) pauseUntil = Date.now() + 1500;
});

let poll = 0;
onMounted(() => {
  void load();
  poll = window.setInterval(() => void load(), 30000);
  tick = window.setInterval(step, 50);
});
onActivated(() => {
  if (data.value) void load();
});
onBeforeUnmount(() => {
  window.clearInterval(poll);
  window.clearInterval(tick);
});
</script>

<style scoped>
.auto {
  display: inline-flex;
  gap: 6px;
  align-items: center;
  font-size: 12px;
}
.head-row,
.unit-row {
  display: grid;
  grid-template-columns: minmax(180px, 1.6fr) repeat(10, minmax(56px, 1fr));
  gap: 8px;
  align-items: center;
  padding: 10px 16px;
}
.head-row {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  background: var(--el-fill-color-lighter);
  border-bottom: 1px solid var(--el-border-color-lighter);
}
.scroller {
  max-height: 520px;
  overflow-y: auto;
}
.unit-row {
  width: 100%;
  font: inherit;
  color: inherit;
  text-align: left;
  cursor: pointer;
  background: none;
  border: 0;
  border-bottom: 1px solid var(--el-border-color-extra-light);
}
.unit-row:hover,
.unit-row:focus-visible {
  outline: none;
  background: var(--el-color-primary-light-9);
}
.col-name {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.name {
  display: inline-flex;
  gap: 6px;
  align-items: center;
  min-width: 0;
}
.name b {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.path {
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 12px;
  white-space: nowrap;
}
.col-num {
  font-variant-numeric: tabular-nums;
  text-align: right;
}
.unit-row .col-num {
  font-size: 15px;
  font-weight: 600;
}
.col-num.zero {
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
.tone-danger {
  color: var(--el-color-danger);
}
.mobile-label {
  display: none;
}
@media (max-width: 900px) {
  .head-row {
    display: none;
  }
  .unit-row {
    grid-template-columns: repeat(5, minmax(0, 1fr));
    row-gap: 6px;
  }
  .unit-row .col-name {
    grid-column: 1 / -1;
  }
  .col-num {
    display: flex;
    flex-direction: column;
    text-align: left;
  }
  .mobile-label {
    display: block;
    font-size: 11px;
    font-style: normal;
    font-weight: 400;
    color: var(--el-text-color-secondary);
  }
}
</style>
