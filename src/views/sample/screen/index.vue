<template>
  <div ref="rootRef" class="live" :class="{ wall }">
    <header class="bar">
      <div class="title">
        <h1>{{ wall ? "智采 · 采样箱实时监测" : "实时地图" }}</h1>
        <span class="text-muted">{{ updatedText }}</span>
        <!-- 后台刷新失败：按设计约定标「旧」并给重试，不把已经看到的列表清空 -->
        <span v-if="stale" class="stale" data-test="screen-stale">
          <span class="stale__dot" aria-hidden="true" />
          刷新失败，列表可能不是最新
          <el-button link type="primary" size="small" :loading="loading" @click="load()">
            重试
          </el-button>
        </span>
      </div>
      <div class="kpis">
        <span v-for="item in kpis" :key="item.label" class="kpi" :class="item.tone">
          <b>{{ item.value }}</b>
          {{ item.label }}
        </span>
      </div>
      <div class="ops">
        <el-button :icon="Refresh" :loading="loading" @click="load()">刷新</el-button>
        <el-button :icon="FullScreen" @click="toggleWall">
          {{ wall ? "退出大屏" : "大屏模式" }}
        </el-button>
      </div>
    </header>

    <div class="body">
      <aside class="side">
        <div class="filter-bar">
          <el-input
            v-model="keyword"
            :prefix-icon="Search"
            :placeholder="canImei ? '名称或 IMEI' : '名称'"
            clearable
          />
          <el-radio-group v-model="life" size="small">
            <el-radio-button value="">全部</el-radio-button>
            <el-radio-button value="在途">{{ lifeLabel("在途") }}</el-radio-button>
            <el-radio-button value="未使用">{{ lifeLabel("未使用") }}</el-radio-button>
            <el-radio-button value="alert">异常</el-radio-button>
          </el-radio-group>
        </div>
        <div class="text-muted count" data-test="screen-count">
          {{ shown.length }} 台
          <template v-if="unplaced">· {{ unplaced }} 台没有定位</template>
        </div>
        <ErrorState
          v-if="error"
          :message="`采样箱列表加载失败：${error}`"
          :retrying="loading"
          data-test="screen-error"
          @retry="load()"
        />
        <ul v-else class="list" data-test="screen-list">
          <li
            v-for="box in shown"
            :key="box.id"
            :class="{ active: activeId === box.id }"
            @click="focus(box)"
          >
            <span class="dot" :class="onlineOf(box) ? 'on' : 'off'" />
            <div class="info">
              <div class="line">
                <b>{{ boxTitle(box) }}</b>
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
        <EmptyState
          v-if="!error && !loading && !shown.length"
          :description="filtered ? '没有符合条件的采样箱' : '你的数据范围里还没有采样箱'"
          data-test="screen-empty"
        />
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
import { usePerm } from "@/composables/usePerm";
import BoxDrawer from "./BoxDrawer.vue";
import TiandituMap, { type TiandituPoint } from "@/components/TiandituMap/index.vue";
import { lifeLabel } from "@/utils/labels";
import { ageText, boxPositions } from "@/utils/position";
import { toDate, clock } from "@/utils/time";
import { lifeTone } from "@/utils/tone";
import { telemetryState } from "../boxes/telemetry";
import { IMEI_PERMS, type SampleBox } from "../data";
import { boxTitle } from "@/utils/boxLabel";

/**
 * 实时地图：全部箱子在地图上，左侧可搜可筛，点一台定位。
 * 「大屏模式」全屏深色，加上指标和最近动态，适合挂在值班室。按页取，最多 500 台；30 秒刷新。
 */
const rootRef = ref<HTMLElement>();
const can = usePerm();
const boxes = ref<SampleBox[]>([]);
const feed = ref<FeedItem[]>([]);
const loading = ref(false);
const error = ref("");
// 轮询失败但手上还有上一轮数据：不炸整个页面，只把列表标成「可能不是最新」
const stale = ref(false);
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
  telemetryState(box.last, box.reportPeriodSec, now.value, box.charge, box.reportOnlyWhenCharging)
    .online;
const shown = computed(() => {
  const text = keyword.value.trim().toLowerCase();
  return boxes.value.filter((box) => {
    // 编号就是 IMEI：没有「设备标识」权限时这一项不参与筛选，和服务端口径一致
    if (
      text &&
      !(canImei.value && box.id.includes(text)) &&
      !(box.name || "").toLowerCase().includes(text)
    )
      return false;
    if (life.value === "alert") return Boolean(box.alert);
    return !life.value || box.life === life.value;
  });
});
const unplaced = computed(() => shown.value.filter((box) => !hasPlace(box)).length);
const filtered = computed(() => Boolean(keyword.value.trim() || life.value));
// 没有「设备标识」权限（现场角色默认如此）：搜索框别写 IMEI，也不按编号筛
const canImei = computed(() => IMEI_PERMS.every((perm) => can(perm)));
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
    {
      label: "台告警",
      value: list.filter((b) => b.alert).length,
      tone: list.some((b) => b.alert) ? "bad" : "",
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
      title: boxTitle(box),
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

/**
 * 按页取箱子，最多 500 台。30 秒一轮：翻页、切筛子、手动刷新和轮询会叠在一起，
 * 所以每一轮一个序号，旧响应回来直接丢——不然半截列表会贴到新数据上。
 * silent（轮询）不显示骨架、失败只标 stale。
 */
let seq = 0;
async function load(silent = false) {
  const mine = ++seq;
  if (!silent) loading.value = true;
  try {
    const all: SampleBox[] = [];
    for (let page = 1; page <= 5; page += 1) {
      const result = await SampleBoxAPI.page({ page, pageSize: 100 });
      if (mine !== seq) return;
      all.push(...result.list);
      if (all.length >= result.total) break;
    }
    let items = feed.value;
    if (wall.value) {
      const bench = await WorkbenchAPI.get();
      items = [...bench.feed].sort(
        (a, b) => (toDate(b.time)?.getTime() ?? 0) - (toDate(a.time)?.getTime() ?? 0)
      );
    }
    if (mine !== seq) return;
    boxes.value = all;
    feed.value = wall.value ? items.slice(0, 8) : [];
    updatedAt.value = new Date();
    error.value = "";
    stale.value = false;
  } catch (e) {
    if (mine !== seq) return;
    // 请求层已经弹过一次错误提示，这里只把页面状态摆出来（骨架不能一直转）
    if (boxes.value.length) stale.value = true;
    else error.value = e instanceof Error ? e.message : "加载失败";
  } finally {
    if (mine === seq) loading.value = false;
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
  // 30 秒一轮的后台刷新：不抢骨架屏，失败只标 stale
  poll = window.setInterval(() => void load(true), 30000);
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
/* 后台刷新失败的「旧」标：用全站的新鲜度配色，不跟正文抢注意力 */
.stale {
  display: inline-flex;
  gap: 6px;
  align-items: center;
  padding: 0 8px;
  font-size: 12px;
  line-height: 22px;
  color: var(--status-stale);
  background: var(--status-stale-bg);
  border-radius: 4px;
}
.stale__dot {
  width: 6px;
  height: 6px;
  background: var(--status-warn);
  border-radius: 50%;
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
