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
        @change="load"
      />
    </template>
    <ECharts v-if="points.length" :options="options" height="280px" />
    <el-empty v-else description="这段时间没有电压上报" :image-size="56" />
  </SectionCard>
</template>

<script setup lang="ts">
import SampleBoxAPI, { type BatteryPoint } from "@/api/sample/box";
import ECharts from "@/components/ECharts/index.vue";
import SectionCard from "@/components/biz/SectionCard.vue";

const props = defineProps<{ boxId: string; lastReport: string }>();

const preset = ref("24h");
const custom = ref<[string, string] | null>(null);
const points = ref<BatteryPoint[]>([]);

function pad(value: number, width = 2) {
  return String(value).padStart(width, "0");
}

function stamp(date: Date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function presetRange(key: string) {
  const end = new Date();
  const start = new Date(end);
  const hours = key === "1h" ? 1 : key === "6h" ? 6 : key === "24h" ? 24 : 24 * 7;
  start.setTime(end.getTime() - hours * 60 * 60 * 1000);
  return [stamp(start), stamp(end)] as [string, string];
}

const REST = "#5470c6";
const CHARGE = "#67C23A";

function onCharge(item: BatteryPoint | undefined) {
  return item?.charge === 1 || item?.charge === 2;
}

function chargeText(charge: number | null | undefined) {
  if (charge === 1) return "充电中";
  if (charge === 2) return "已充满";
  if (charge === 0) return "未充电";
  return "";
}

/**
 * 时间轴按真实时间排（补传的点落在设备时间上），不做平滑；服务端在没数据的空档插了空点，曲线在那里断开。
 * 充电的时段用绿色底色标出来。电量是实际电量（不扣预留），页头的「可用电量」扣了预留，所以会低一些。
 */
const options = computed(() => {
  const ms = (time: string) => Date.parse(time.replace(" ", "T"));
  const bands: Array<[{ xAxis: number }, { xAxis: number }]> = [];
  let start: number | null = null;
  points.value.forEach((item, index) => {
    if (onCharge(item) && start == null) start = ms(item.time);
    const ends = !onCharge(item) || item.gap || index === points.value.length - 1;
    if (start != null && ends) {
      const end = item.gap && index > 0 ? ms(points.value[index - 1].time) : ms(item.time);
      bands.push([{ xAxis: start }, { xAxis: end }]);
      start = null;
    }
  });
  // 前后都断开（或在头尾）的单独一个读数：线画不出来，单独标个小圆点，不至于整片空白
  const readings = points.value.map((item, index) => {
    const before = points.value[index - 1],
      after = points.value[index + 1];
    const isolated = !item.gap && (!before || before.gap) && (!after || after.gap);
    return { value: [ms(item.time), item.gap ? null : item.percent], symbolSize: isolated ? 5 : 0 };
  });
  return {
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
        type: "line",
        name: "电量",
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

let requestId = 0;
let lastRequestAt = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
async function load() {
  clearTimeout(timer);
  timer = undefined;
  lastRequestAt = Date.now();
  const request = ++requestId;
  const id = props.boxId;
  if (!id) return;
  const [from, to] = custom.value?.length === 2 ? custom.value : presetRange(preset.value);
  try {
    const rows = await SampleBoxAPI.battery(id, from, to);
    if (request !== requestId) return;
    points.value = Array.isArray(rows) ? rows : [];
  } catch {
    if (request === requestId) points.value = [];
  }
}

function onPreset() {
  custom.value = null;
  void load();
}

watch(() => props.boxId, load, { immediate: true });
watch(
  () => props.lastReport,
  () => {
    if (custom.value || timer !== undefined) return;
    timer = setTimeout(load, Math.max(0, 60000 - (Date.now() - lastRequestAt)));
  }
);
onBeforeUnmount(() => clearTimeout(timer));
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
.range {
  width: 320px;
  max-width: 100%;
}
</style>
