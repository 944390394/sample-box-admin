<template>
  <SectionCard title="电量曲线" class="battery-card">
    <template #title>
      估算总电量
      <span class="charge-key">绿色为接电时段（含已充满），断线为采样间隔过长</span>
    </template>
    <template #extra>
      <el-radio-group v-model="preset" size="small" @change="onPreset">
        <el-radio-button value="1h">1 小时</el-radio-button>
        <el-radio-button value="6h">6 小时</el-radio-button>
        <el-radio-button value="24h">24 小时</el-radio-button>
        <el-radio-button value="7d">7 天</el-radio-button>
      </el-radio-group>
      <!-- 加载反馈＝tabs 右侧小 chip（淡入淡出），不再用遮罩/骨架盖住旧曲线；
           固定宽度占位，chip 出现/消失不挤动日期选择器 -->
      <span class="load-slot">
        <Transition name="chip-fade">
          <el-tag v-if="loading" class="load-chip" size="small" type="info" effect="plain" round>
            <el-icon class="is-loading" :size="12"><Loading /></el-icon>
            加载中…
          </el-tag>
        </Transition>
      </span>
      <el-date-picker
        v-model="custom"
        type="datetimerange"
        size="small"
        :editable="false"
        range-separator="~"
        start-placeholder="开始"
        end-placeholder="结束"
        value-format="YYYY-MM-DD HH:mm:ss"
        class="range"
        @change="onCustom"
      />
    </template>
    <!-- 实例常驻：范围切换只换数据不重建画布。切换发起旧曲线降透明度保留（不 clear 不闪白），
         新数据 morph 过渡后恢复；空数据/失败先淡出旧图再淡入空态。骨架只用于本箱首次加载。 -->
    <div class="chart-stage">
      <div v-if="loading && points.length" class="load-bar" aria-hidden="true"><i /></div>
      <div class="chart-canvas" :class="{ 'is-dimmed': dimmed, 'is-fading-out': fadingOut }">
        <ECharts
          v-if="hasChart"
          v-show="points.length"
          :options="options"
          height="280px"
          :replace-merge="['series']"
        />
      </div>
      <Transition name="stage-fade">
        <el-skeleton v-if="showSkeleton" :rows="4" animated class="chart-skeleton" />
      </Transition>
      <Transition name="stage-fade">
        <el-empty
          v-if="showEmpty"
          class="chart-empty"
          description="这段时间没有电压上报"
          :image-size="56"
        />
      </Transition>
    </div>
  </SectionCard>
</template>

<script setup lang="ts">
import { Loading } from "@element-plus/icons-vue";

import SampleBoxAPI, { type BatteryPoint } from "@/api/sample/box";
import ECharts from "@/components/ECharts/index.vue";
import SectionCard from "@/components/biz/SectionCard.vue";
import { chargeBands, createSeriesCache, onCharge, presetRange } from "@/utils/batteryChart";

const props = defineProps<{ boxId: string; lastReport: string }>();

const preset = ref("24h");
const custom = ref<[string, string] | null>(null);
const points = ref<BatteryPoint[]>([]);
const loading = ref(false);
const hasChart = ref(false);
// 过渡状态：dimmed＝切换等待期旧曲线保持渲染但降到 0.35；fadingOut＝空态前旧图淡出；
// settled＝本箱首次加载已返回（骨架只在首次加载出现，之后空↔有数据都走淡入淡出）
const dimmed = ref(false);
const fadingOut = ref(false);
const settled = ref(false);
// 按范围缓存上一次结果：切换先即时回显，再后台刷新（7 天全量请求不再挡住每次切换）
const cache = createSeriesCache<BatteryPoint[]>(8);

const showSkeleton = computed(() => !settled.value && loading.value && !points.value.length);
const showEmpty = computed(() => settled.value && !points.value.length);

const REST = "#5470c6";
const CHARGE = "#67C23A";

function chargeText(charge: number | null | undefined) {
  if (charge === 1) return "充电中";
  if (charge === 2) return "已充满";
  if (charge === 0) return "未充电";
  return "";
}

/**
 * 时间轴按真实时间排（补传的点落在设备时间上），不做平滑；服务端在没数据的空档插了空点，曲线在那里断开。
 * 充电的时段用绿色底色标出来（区间数组 markArea，不逐点）。电量是实际电量（不扣预留），
 * 页头的「可用电量」扣了预留，所以会低一些。
 * 动画口径（R18）：初始渲染不播逐点动画（animationDuration:0，保 R15 大点集性能）；
 * 范围切换走 400ms cubicOut morph——折线/面积由 lineAnimationDiff 按索引插值（点数差异由 diff 补齐），
 * universalTransition 负责逐点元素过渡。注意数据点**不要带 id**：按时间 id diff 会把窗口外新点
 * 反算到旧坐标系（±十几万像素），触发 echarts boundingDiff>3000 保护而硬切。
 * animationThreshold:1500 兜底：点数超限自动整体关动画硬切（服务端已降采样 ≤720 点，正常不触发）。
 */
const options = computed(() => {
  const ms = (time: string) => Date.parse(time.replace(" ", "T"));
  const bands = chargeBands(points.value);
  // 前后都断开（或在头尾）的单独一个读数：线画不出来，单独标个小圆点，不至于整片空白
  const readings = points.value.map((item, index) => {
    const before = points.value[index - 1],
      after = points.value[index + 1];
    const isolated = !item.gap && (!before || before.gap) && (!after || after.gap);
    return { value: [ms(item.time), item.gap ? null : item.percent], symbolSize: isolated ? 5 : 0 };
  });
  return {
    animation: true,
    animationDuration: 0,
    animationDurationUpdate: 400,
    animationEasingUpdate: "cubicOut" as const,
    animationThreshold: 1500,
    grid: { left: 48, right: 24, top: 28, bottom: 32 },
    tooltip: {
      trigger: "axis",
      formatter(params: Array<{ dataIndex: number }> | { dataIndex: number }) {
        const row = Array.isArray(params)
          ? params.find((p) => !points.value[p.dataIndex]?.gap)
          : params;
        if (!row) return "";
        const item = points.value[row?.dataIndex];
        if (!item || item.gap || item.mv == null) return "";
        const state = chargeText(item.charge);
        const stateLine = onCharge(item)
          ? `<br/><span style="color:${CHARGE}">${state}</span>`
          : state
            ? `<br/>${state}`
            : "";
        return `${item.time}<br/>估算总电量 ${item.percent}%<br/>电压 ${(item.mv / 1000).toFixed(2)} V${stateLine}`;
      },
    },
    xAxis: { type: "time", axisLabel: { hideOverlap: true } },
    yAxis: { type: "value", min: 0, max: 100, name: "%" },
    series: [
      {
        // 稳定 id：replaceMerge 按 id 匹配走增量合并；也是 universalTransition 的 seriesKey
        id: "battery",
        type: "line",
        name: "电量",
        universalTransition: true,
        showSymbol: true,
        showAllSymbol: true,
        symbol: "circle",
        connectNulls: false,
        data: readings,
        lineStyle: { color: REST, width: 2 },
        itemStyle: { color: REST },
        areaStyle: { color: REST, opacity: 0.12 },
        markArea: { silent: true, itemStyle: { color: CHARGE, opacity: 0.12 }, data: bands },
      },
    ],
  };
});

function rangeKey() {
  return custom.value?.length === 2 ? `c:${custom.value[0]}~${custom.value[1]}` : preset.value;
}

function currentRange(): [string, string] {
  return custom.value?.length === 2 ? custom.value : presetRange(preset.value);
}

/** 与 animationDurationUpdate 对齐：morph 播完再把透明度恢复到 1（CSS 220ms 淡回） */
const MORPH_MS = 400;
/** ≥ chart-canvas 的 opacity 过渡时长：淡出到位后才切空态，避免硬跳 */
const FADE_MS = 240;
let morphTimer: ReturnType<typeof setTimeout> | undefined;
let fadeTimer: ReturnType<typeof setTimeout> | undefined;

function settleMorph() {
  clearTimeout(morphTimer);
  morphTimer = setTimeout(() => {
    dimmed.value = false;
  }, MORPH_MS + 40);
}

/** 空数据/失败：旧图先淡出（透明度→0），再换成空态文案淡入；已空则直接收尾 */
function fadeToEmpty() {
  clearTimeout(morphTimer);
  clearTimeout(fadeTimer);
  if (!points.value.length) {
    fadingOut.value = false;
    dimmed.value = false;
    return;
  }
  fadingOut.value = true;
  fadeTimer = setTimeout(() => {
    fadingOut.value = false;
    dimmed.value = false;
    points.value = [];
  }, FADE_MS);
}

/** 切换发起：旧曲线保留渲染并降透明度；取消未完成的淡出（连点只保留最后一次的目标态） */
function beginSwitch() {
  clearTimeout(fadeTimer);
  fadingOut.value = false;
  dimmed.value = true;
}

/** 切换即时回显缓存（不等网络）：有数据立即 morph 回显，空结果走淡出；无缓存保持旧图降透明等待 */
function applyCached(key: string) {
  const hit = cache.get(key);
  if (!hit) return false;
  if (hit.length) {
    points.value = hit;
    hasChart.value = true;
    settleMorph();
  } else {
    fadeToEmpty();
  }
  return true;
}

let requestId = 0;
let lastRequestAt = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let debounce: ReturnType<typeof setTimeout> | undefined;

async function runLoad() {
  clearTimeout(timer);
  timer = undefined;
  lastRequestAt = Date.now();
  const request = ++requestId;
  const id = props.boxId;
  if (!id) return;
  const key = rangeKey();
  const [from, to] = currentRange();
  loading.value = true;
  try {
    const rows = await SampleBoxAPI.battery(id, from, to);
    if (request !== requestId) return;
    const list = Array.isArray(rows) ? rows : [];
    cache.set(key, list);
    settled.value = true;
    if (list.length) {
      points.value = list;
      hasChart.value = true;
      settleMorph();
    } else {
      fadeToEmpty();
    }
  } catch {
    if (request !== requestId) return;
    settled.value = true;
    // 后台刷新失败且有缓存：保持当前回显；无缓存：旧图淡出→空态
    if (cache.get(key)) dimmed.value = false;
    else fadeToEmpty();
  } finally {
    if (request === requestId) loading.value = false;
  }
}

/** 范围切换 debounce 250ms：连点只发最后一次请求；缓存回显在点击当下已完成 */
function scheduleLoad() {
  clearTimeout(debounce);
  debounce = setTimeout(() => void runLoad(), 250);
}

function onPreset() {
  custom.value = null;
  beginSwitch();
  applyCached(preset.value);
  scheduleLoad();
}

function onCustom() {
  beginSwitch();
  applyCached(rangeKey());
  scheduleLoad();
}

watch(
  () => props.boxId,
  () => {
    cache.clear();
    clearTimeout(morphTimer);
    clearTimeout(fadeTimer);
    dimmed.value = false;
    fadingOut.value = false;
    settled.value = false;
    points.value = [];
    void runLoad();
  },
  { immediate: true }
);
watch(
  () => props.lastReport,
  () => {
    if (custom.value || timer !== undefined) return;
    timer = setTimeout(() => void runLoad(), Math.max(0, 60000 - (Date.now() - lastRequestAt)));
  }
);
onBeforeUnmount(() => {
  clearTimeout(timer);
  clearTimeout(debounce);
  clearTimeout(morphTimer);
  clearTimeout(fadeTimer);
});
</script>

<style scoped>
.charge-key {
  display: inline-flex;
  gap: 6px;
  align-items: center;
  font-size: 12px;
  font-weight: 400;
  color: var(--el-text-color-secondary);
}
.charge-key::before {
  width: 12px;
  height: 10px;
  content: "";
  background: rgb(103 194 58 / 25%);
  border-radius: 2px;
}
.load-slot {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 82px;
}
.load-chip {
  display: inline-flex;
  gap: 4px;
  align-items: center;
}
.chip-fade-enter-active,
.chip-fade-leave-active {
  transition: opacity 180ms ease;
}
.chip-fade-enter-from,
.chip-fade-leave-to {
  opacity: 0;
}
.chart-stage {
  position: relative;
  min-height: 280px;
}
.chart-canvas {
  transition: opacity 220ms ease;
}
.chart-canvas.is-dimmed {
  opacity: 0.35;
}
.chart-canvas.is-fading-out {
  opacity: 0;
}
.load-bar {
  position: absolute;
  top: 0;
  right: 0;
  left: 0;
  z-index: 1;
  height: 2px;
  overflow: hidden;
  background: var(--el-color-primary-light-8);
  border-radius: 1px;
}
.load-bar i {
  display: block;
  width: 30%;
  height: 100%;
  background: var(--el-color-primary);
  border-radius: 1px;
  animation: load-slide 1.1s ease-in-out infinite;
}
@keyframes load-slide {
  0% {
    transform: translateX(-100%);
  }
  100% {
    transform: translateX(340%);
  }
}
.chart-skeleton {
  position: absolute;
  inset: 0;
  padding: 12px 8px;
}
.chart-empty {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}
.stage-fade-enter-active {
  transition: opacity 240ms ease;
}
.stage-fade-leave-active {
  transition: opacity 180ms ease;
}
.stage-fade-enter-from,
.stage-fade-leave-to {
  opacity: 0;
}
.range {
  width: 320px;
  max-width: 100%;
}
</style>
