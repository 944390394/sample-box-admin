<template>
  <div ref="rootRef" class="live" :class="{ wall }">
    <header class="bar">
      <div class="title">
        <h1>{{ wall ? "智采 · 采样箱实时监测" : "实时地图" }}</h1>
        <span class="text-muted">{{ updatedText }}</span>
      </div>
      <div class="kpis">
        <span v-for="item in kpis" :key="item.label" class="kpi" :class="item.tone">
          <b>{{ item.value }}</b>
          {{ item.label }}
        </span>
      </div>
      <div class="ops">
        <el-button :icon="Refresh" :loading="loading" @click="load">刷新</el-button>
        <el-button :icon="FullScreen" @click="toggleWall">
          {{ wall ? "退出大屏" : "大屏模式" }}
        </el-button>
      </div>
    </header>

    <div class="body">
      <aside class="side">
        <div class="filter-bar">
          <el-input v-model="keyword" :prefix-icon="Search" placeholder="名称或 IMEI" clearable />
          <el-radio-group v-model="life" size="small">
            <el-radio-button value="">全部</el-radio-button>
            <el-radio-button value="在途">{{ lifeLabel("在途") }}</el-radio-button>
            <el-radio-button value="未使用">{{ lifeLabel("未使用") }}</el-radio-button>
          </el-radio-group>
        </div>
        <div class="text-muted count">
          {{ shown.length }} 台
          <template v-if="unplaced">· {{ unplaced }} 台没有定位</template>
        </div>
        <ul class="list">
          <li
            v-for="box in shown"
            :key="box.id"
            :class="{ active: activeId === box.id }"
            @click="focus(box)"
          >
            <span class="dot" :class="onlineOf(box) ? 'on' : 'off'" />
            <div class="info">
              <div class="line">
                <b>{{ box.name || box.id }}</b>
                <el-tag size="small" :type="lifeTone(box.life)">{{ lifeLabel(box.life) }}</el-tag>
              </div>
              <LocationLine
                class="loc"
                :box="box"
                :period-sec="box.reportPeriodSec"
                compact
                hide-stale-gps
                empty-text="没有定位"
              />
              <div v-if="box.alert" class="alert">{{ box.alert }}</div>
            </div>
          </li>
        </ul>
        <section v-if="wall && feed.length" class="feed">
          <div class="card-head__title">最近动态</div>
          <div v-for="(item, index) in feed" :key="index" class="feed-line">
            <TimeText :value="item.time" mode="short" />
            <span>
              {{
                item.type === "task"
                  ? `${item.taskName} ${item.action}`
                  : `${item.boxName} ${item.action}`
              }}
            </span>
          </div>
        </section>
      </aside>
      <main class="map">
        <TiandituMap
          :points="points"
          compact
          :active-id="activeId"
          :focus-token="focusToken"
          @select="onSelect"
        />
      </main>
    </div>
    <BoxDrawer v-model="drawerOpen" :box="drawerBox" />
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: "SampleScreen" });

import { FullScreen, Refresh, Search } from "@element-plus/icons-vue";
import SampleBoxAPI from "@/api/sample/box";
import WorkbenchAPI, { type FeedItem } from "@/api/sample/workbench";
import LocationLine from "@/components/biz/LocationLine.vue";
import TimeText from "@/components/biz/TimeText.vue";
import BoxDrawer from "./BoxDrawer.vue";
import TiandituMap, { type TiandituPoint } from "@/components/TiandituMap/index.vue";
import { lifeLabel } from "@/utils/labels";
import { ageText, boxPositions } from "@/utils/position";
import { toDate, clock } from "@/utils/time";
import { lifeTone } from "@/utils/tone";
import { telemetryState } from "../boxes/telemetry";
import type { SampleBox } from "../data";

/**
 * 实时地图：全部箱子在地图上，左侧可搜可筛，点一台定位。
 * 「大屏模式」全屏深色，加上指标和最近动态，适合挂在值班室。按页取，最多 500 台；30 秒刷新。
 */
const rootRef = ref<HTMLElement>();
const boxes = ref<SampleBox[]>([]);
const feed = ref<FeedItem[]>([]);
const loading = ref(false);
const updatedAt = ref<Date | null>(null);
const keyword = ref("");
const life = ref("");
const activeId = ref("");
const drawerOpen = ref(false);
const drawerBox = ref<SampleBox | null>(null);
const focusToken = ref(0);
const wall = ref(false);
// 跟全站时钟走：在线点和「x 秒前」每秒刷新
const now = clock;

const updatedText = computed(() =>
  updatedAt.value ? `更新于 ${updatedAt.value.toTimeString().slice(0, 8)}` : "正在读取…"
);
const hasPlace = (box: SampleBox) =>
  (box.gpsLng != null && box.gpsLat != null) || (box.lbsLng != null && box.lbsLat != null);
const onlineOf = (box: SampleBox) =>
  telemetryState(box.last, box.reportPeriodSec, now.value).online;
const shown = computed(() => {
  const text = keyword.value.trim().toLowerCase();
  return boxes.value.filter((box) => {
    if (text && !box.id.includes(text) && !(box.name || "").toLowerCase().includes(text))
      return false;
    return !life.value || box.life === life.value;
  });
});
const unplaced = computed(() => shown.value.filter((box) => !hasPlace(box)).length);
const kpis = computed(() => {
  const list = boxes.value;
  const online = list.filter(onlineOf).length;
  return [
    { label: "台在线", value: online, tone: "ok" },
    { label: "台离线", value: list.length - online, tone: list.length - online ? "warn" : "" },
    {
      label: `台${lifeLabel("在途")}`,
      value: list.filter((b) => b.life === "在途").length,
      tone: "",
    },
  ];
});
const points = computed<TiandituPoint[]>(() =>
  shown.value.filter(hasPlace).map((box) => {
    // 当前位置按全站规则选：GPS 过时、基站更新时用基站
    const { current, gps, gpsStale } = boxPositions(box);
    const here = current!;
    const isGps = here.source === "GPS";
    return {
      id: box.id,
      lng: here.lng,
      lat: here.lat,
      title: box.name || box.id,
      status: box.alert ? "异常" : isGps ? "gps" : undefined,
      address: here.address || undefined,
      lines: [
        `${lifeLabel(box.life)} · ${box.org || "总公司"}`,
        `${isGps ? "GPS 定位" : "基站定位，误差较大"}${here.at ? `（${ageText(here.at)}）` : ""}`,
        gpsStale && gps ? `最后一次 GPS：${ageText(gps.at)}` : "",
        box.alert,
      ].filter(Boolean),
      emphasis: activeId.value === box.id,
    };
  })
);

/** 点列表里的箱子：地图定位过去，右侧抽屉打开它的详情。 */
function focus(box: SampleBox) {
  activeId.value = box.id;
  focusToken.value += 1;
  drawerBox.value = box;
  drawerOpen.value = true;
}
/** 点地图上的箱子：同样打开抽屉。 */
function onSelect(id: string) {
  const box = boxes.value.find((item) => item.id === id);
  if (!box) return;
  activeId.value = id;
  drawerBox.value = box;
  drawerOpen.value = true;
}

async function load() {
  loading.value = true;
  try {
    const all: SampleBox[] = [];
    for (let page = 1; page <= 5; page += 1) {
      const result = await SampleBoxAPI.page({ page, pageSize: 100 });
      all.push(...result.list);
      if (all.length >= result.total) break;
    }
    boxes.value = all;
    updatedAt.value = new Date();
    if (wall.value) {
      const bench = await WorkbenchAPI.get();
      feed.value = [...bench.feed]
        .sort((a, b) => (toDate(b.time)?.getTime() ?? 0) - (toDate(a.time)?.getTime() ?? 0))
        .slice(0, 8);
    }
  } finally {
    loading.value = false;
  }
}

async function toggleWall() {
  wall.value = !wall.value;
  try {
    if (wall.value) await rootRef.value?.requestFullscreen?.();
    else if (document.fullscreenElement) await document.exitFullscreen();
  } catch {
    /* 浏览器不允许全屏时只切换样式 */
  }
  void load();
}
function onFullscreenChange() {
  if (!document.fullscreenElement && wall.value) wall.value = false;
}

let poll = 0;
onMounted(() => {
  void load();
  poll = window.setInterval(() => void load(), 30000);
  document.addEventListener("fullscreenchange", onFullscreenChange);
});
onBeforeUnmount(() => {
  window.clearInterval(poll);
  document.removeEventListener("fullscreenchange", onFullscreenChange);
});
</script>

<style scoped>
.live {
  display: flex;
  flex-direction: column;
  gap: 10px;
  height: 100%;
  min-height: 0;
  padding: var(--page-padding);
  background: var(--page-bg);
}
.bar {
  display: flex;
  flex-wrap: wrap;
  gap: 10px 20px;
  align-items: center;
  justify-content: space-between;
}
.title {
  display: flex;
  gap: 10px;
  align-items: baseline;
}
h1 {
  margin: 0;
  font-size: 18px;
}
.kpis {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
}
.kpi {
  font-size: 13px;
  color: var(--el-text-color-secondary);
}
.kpi b {
  margin-right: 3px;
  font-size: 20px;
  color: var(--el-text-color-primary);
}
.kpi.ok b {
  color: var(--el-color-success);
}
.kpi.warn b {
  color: var(--el-color-warning);
}
.kpi.bad b {
  color: var(--el-color-danger);
}
.ops {
  display: flex;
  gap: 8px;
}
.body {
  display: flex;
  flex: 1;
  gap: 10px;
  min-height: 0;
}
.side {
  display: flex;
  flex: 0 0 300px;
  flex-direction: column;
  gap: 8px;
  min-height: 0;
  padding: 12px;
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
}
.count {
  padding: 0 2px;
}
.list {
  flex: 1;
  min-height: 0;
  padding: 0;
  margin: 0;
  overflow: auto;
  list-style: none;
}
.list li {
  display: flex;
  gap: 8px;
  padding: 8px 6px;
  cursor: pointer;
  border-radius: 6px;
}
.list li:hover {
  background: var(--el-fill-color-lighter);
}
.list li.active {
  background: var(--el-color-primary-light-9);
}
.dot {
  flex-shrink: 0;
  width: 8px;
  height: 8px;
  margin-top: 7px;
  border-radius: 50%;
}
.dot.on {
  background: var(--el-color-success);
}
.dot.off {
  background: var(--el-text-color-placeholder);
}
.info {
  flex: 1;
  min-width: 0;
  font-size: 13px;
}
.line {
  display: flex;
  gap: 6px;
  align-items: center;
  justify-content: space-between;
}
.alert {
  font-size: 12px;
  color: var(--el-color-danger);
}
.map {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
}
.feed {
  padding-top: 8px;
  border-top: 1px solid var(--el-border-color-lighter);
}
.feed-line {
  display: flex;
  gap: 8px;
  padding: 3px 0;
  font-size: 12px;
}
@media (max-width: 768px) {
  .body {
    flex-direction: column;
  }
  .side {
    flex: 0 0 auto;
    max-height: 40vh;
  }
  .map {
    min-height: 360px;
  }
}
/* 大屏：深色、字号加大 */
.live.wall {
  --el-bg-color: #0f172a;
  --el-text-color-primary: #e2e8f0;
  --el-text-color-regular: #cbd5e1;
  --el-text-color-secondary: #94a3b8;
  --el-border-color-lighter: #1e293b;
  --el-fill-color-lighter: #1e293b;
  --el-color-primary-light-9: #1e3a5f;
  color: #e2e8f0;
  background: #020617;
}
.live.wall h1 {
  font-size: 24px;
}
.live.wall .kpi b {
  font-size: 28px;
}
</style>
