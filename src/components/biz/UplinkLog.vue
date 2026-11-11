<template>
  <div class="uplink-log">
    <div class="filter-bar">
      <el-select v-model="kind" placeholder="全部类型" style="width: 130px" @change="reload">
        <el-option
          v-for="item in kindOptions"
          :key="item.value"
          :label="item.label"
          :value="item.value"
        />
      </el-select>
      <el-select v-if="ranges" v-model="days" style="width: 120px" @change="reload">
        <el-option label="最近 1 天" :value="1" />
        <el-option label="最近 7 天" :value="7" />
        <el-option label="最近 30 天" :value="30" />
      </el-select>
      <el-select
        v-if="boxOptions.length > 1"
        v-model="boxId"
        clearable
        placeholder="全部箱子"
        style="width: 180px"
        @change="reload"
      >
        <el-option v-for="box in boxOptions" :key="box.id" :label="box.name" :value="box.id" />
      </el-select>
      <el-input v-model="seqText" placeholder="按 seq 查" clearable style="width: 120px" />
      <el-switch v-if="!eventsOnly" v-model="folded" active-text="折叠定时上报" />
      <span class="filter-bar__spacer" />
      <slot name="actions" />
    </div>

    <div v-if="list.length" class="summary">
      <span>
        已载入
        <b>{{ list.length }}</b>
        条
      </span>
      <span v-if="span">时间 {{ span }}</span>
      <span v-if="voltRange">电压 {{ voltRange }}</span>
      <span v-for="(n, label) in eventCounts" :key="label">
        {{ label }}
        <b>{{ n }}</b>
        次
      </span>
    </div>

    <div v-loading="loading && !list.length" class="feed">
      <template v-for="group in groups" :key="group.day">
        <div class="day">{{ group.day }}</div>
        <div
          v-for="row in group.rows"
          :key="row.key"
          class="row"
          :class="row.type === 'run' ? 'is-run' : `is-${row.item.kind || 'unknown'}`"
        >
          <template v-if="row.type === 'run'">
            <button type="button" class="run-head" @click="toggle(row.key)">
              <el-icon class="caret" :class="{ open: opened.has(row.key) }"><ArrowRight /></el-icon>
              <span class="clock">{{ clock(row.from, row.to) }}–{{ clock(row.to, row.from) }}</span>
              <el-tag size="small" type="info" effect="plain">
                定时上报 {{ row.items.length - row.charges }} 次
                <template v-if="row.charges">· 充电状态 {{ row.charges }} 次</template>
              </el-tag>
              <span v-if="showBox" class="box">{{ nameOf(row.boxId) }}</span>
              <span v-if="row.volts" class="fact">
                {{ row.volts[0].toFixed(2) }}–{{ row.volts[1].toFixed(2) }} V
              </span>
              <span v-if="row.lid" class="fact">{{ row.lid }}</span>
            </button>
            <div v-if="opened.has(row.key)" class="run-body">
              <UplinkLine
                v-for="entry in row.items"
                :key="entry.item.id || entry.item.time"
                :item="entry.item"
                :facts="entry.facts"
                :show-box="showBox"
                :box-name="nameOf(entry.item.box)"
                :raw="rawOf(entry.item)"
                :raw-allowed="Boolean(loadRaw)"
                @raw="openRaw(entry.item)"
              />
            </div>
          </template>
          <UplinkLine
            v-else
            :item="row.item"
            :facts="row.facts"
            :show-box="showBox"
            :box-name="nameOf(row.item.box)"
            :raw="rawOf(row.item)"
            :raw-allowed="Boolean(loadRaw)"
            highlight
            @raw="openRaw(row.item)"
          />
        </div>
      </template>
      <el-empty
        v-if="!loading && !shown.length"
        :image-size="56"
        :description="list.length ? '没有符合 seq 的记录' : '这段时间没有上报'"
      />
    </div>

    <DataPager
      :shown="list.length"
      :has-more="Boolean(cursor)"
      :loading="loading"
      @more="loadMore"
    />
  </div>
</template>

<script setup lang="ts">
import { ArrowRight } from "@element-plus/icons-vue";
import type { BoxLogItem, UplinkPage } from "@/api/sample/box";
import DataPager from "@/components/biz/DataPager.vue";
import { fullTime, lastDays, toDate } from "@/utils/time";
import { groupRuns, KIND_FILTERS, uplinkFacts, type UplinkRow } from "@/views/sample/boxes/uplink";
import UplinkLine from "./UplinkLine.vue";

/**
 * 上报记录：采样箱详情和任务详情共用。
 * 连续的定时上报折成一行（起止时间、次数、电压范围），开关箱、上电等事件单独高亮；原文点开才取。
 * load 由使用方给：采样箱按最近 N 天查，任务按任务时间段查。
 */
export interface UplinkLoadParams {
  kind?: string;
  from?: string;
  to?: string;
  boxId?: string;
  cursorTime?: string;
  cursorId?: string;
  limit?: number;
}

const props = withDefaults(
  defineProps<{
    load: (params: UplinkLoadParams) => Promise<UplinkPage>;
    /** 不给就不显示原文按钮（只有事件权限的人）。 */
    loadRaw?: (item: BoxLogItem) => Promise<string>;
    /** 只看开关箱、上电、充电（事件权限）。 */
    eventsOnly?: boolean;
    /** 显示「最近 N 天」选择（任务按任务时间段，不显示）。 */
    ranges?: boolean;
    /** 多台箱子时可以按箱子筛选，并在每行显示箱子名称。 */
    boxes?: { id: string; name: string }[];
    initialKind?: string;
  }>(),
  { ranges: true, boxes: () => [], initialKind: "", loadRaw: undefined, eventsOnly: false }
);

const kindOptions = computed(() =>
  props.eventsOnly
    ? KIND_FILTERS.filter((item) =>
        ["boot,pad,shut,chg", "pad", "shut", "boot", "chg"].includes(item.value)
      )
    : KIND_FILTERS
);
const kind = ref(props.initialKind || (props.eventsOnly ? "boot,pad,shut,chg" : ""));
const days = ref(1);
const boxId = ref("");
const seqText = ref("");
const folded = ref(true);
const list = ref<BoxLogItem[]>([]);
const cursor = ref<{ time: string; id: string } | null>(null);
const loading = ref(false);
const rawById = ref<Record<string, string>>({});
const opened = ref(new Set<string>());
const boxOptions = computed(() => props.boxes);
const showBox = computed(() => props.boxes.length > 1);
const names = computed(() => Object.fromEntries(props.boxes.map((b) => [b.id, b.name])));
const nameOf = (id: string) => names.value[id] || id;

function params(): UplinkLoadParams {
  const out: UplinkLoadParams = {
    kind: kind.value || undefined,
    boxId: boxId.value || undefined,
    limit: 100,
  };
  if (props.ranges) Object.assign(out, lastDays(days.value));
  return out;
}

let seq = 0;
async function reload() {
  const mine = ++seq;
  loading.value = true;
  try {
    const page = await props.load(params());
    if (mine !== seq) return;
    list.value = page.list;
    cursor.value = page.nextCursor;
  } finally {
    if (mine === seq) loading.value = false;
  }
}
async function loadMore() {
  if (!cursor.value) return;
  loading.value = true;
  try {
    const page = await props.load({
      ...params(),
      cursorTime: cursor.value.time,
      cursorId: cursor.value.id,
    });
    list.value = [...list.value, ...page.list];
    cursor.value = page.nextCursor;
  } finally {
    loading.value = false;
  }
}

const shown = computed(() => {
  const text = seqText.value.trim();
  if (!text) return list.value;
  return list.value.filter((item) => String(uplinkFacts(item).seq ?? "").includes(text));
});
const groups = computed(() => {
  const rows: UplinkRow[] = folded.value
    ? groupRuns(shown.value)
    : shown.value.map((item) => ({
        type: "one" as const,
        key: `one-${item.id || item.time}`,
        item,
        facts: uplinkFacts(item),
      }));
  const out: { day: string; rows: UplinkRow[] }[] = [];
  for (const row of rows) {
    const time = row.type === "run" ? row.to : row.item.time;
    const d = toDate(time);
    const day = d ? `${d.getMonth() + 1} 月 ${d.getDate()} 日` : "时间未知";
    if (out.at(-1)?.day !== day) out.push({ day, rows: [] });
    out.at(-1)!.rows.push(row);
  }
  return out;
});
const span = computed(() => {
  if (!list.value.length) return "";
  return `${fullTime(list.value.at(-1)!.time).slice(5, 16)} 至 ${fullTime(list.value[0].time).slice(5, 16)}`;
});
const voltRange = computed(() => {
  const volts = list.value
    .map((item) => uplinkFacts(item).volts)
    .filter((v): v is number => v != null);
  return volts.length ? `${Math.min(...volts).toFixed(2)}–${Math.max(...volts).toFixed(2)} V` : "";
});
const eventCounts = computed(() => {
  const label: Record<string, string> = { pad: "开箱", shut: "关箱", boot: "上电", chg: "充电" };
  const out: Record<string, number> = {};
  for (const item of list.value)
    if (item.kind && label[item.kind]) out[label[item.kind]] = (out[label[item.kind]] || 0) + 1;
  return out;
});

/** 同一分钟内的一串显示到秒，否则到分。 */
function clock(time: string, other = "") {
  const a = fullTime(time),
    b = fullTime(other);
  return a.slice(11, 16) === b.slice(11, 16) ? a.slice(11, 19) : a.slice(11, 16);
}
function toggle(key: string) {
  const next = new Set(opened.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  opened.value = next;
}
function rawOf(item: BoxLogItem) {
  return item.id ? rawById.value[item.id] || "" : "";
}
async function openRaw(item: BoxLogItem) {
  if (!item.id || !props.loadRaw) return;
  if (rawById.value[item.id]) {
    const next = { ...rawById.value };
    delete next[item.id];
    rawById.value = next;
    return;
  }
  try {
    const raw = await props.loadRaw(item);
    rawById.value = { ...rawById.value, [item.id]: raw };
  } catch {
    /* 拦截器已提示 */
  }
}

onMounted(reload);
defineExpose({ reload });
</script>

<style scoped>
.uplink-log {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.summary {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 16px;
  padding: 8px 12px;
  font-size: 13px;
  color: var(--el-text-color-regular);
  background: var(--el-fill-color-lighter);
  border-radius: 6px;
}
.feed {
  min-height: 120px;
}
.day {
  position: sticky;
  top: 0;
  z-index: 1;
  padding: 8px 0 4px;
  font-size: 12px;
  font-weight: 600;
  color: var(--el-text-color-secondary);
  background: var(--el-bg-color);
}
.row {
  border-bottom: 1px solid var(--el-border-color-extra-light);
}
.run-head {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  width: 100%;
  padding: 8px 4px;
  font: inherit;
  font-size: 13px;
  color: var(--el-text-color-regular);
  text-align: left;
  cursor: pointer;
  background: none;
  border: 0;
}
.run-head:hover {
  background: var(--el-fill-color-lighter);
}
.caret {
  transition: transform 0.15s;
}
.caret.open {
  transform: rotate(90deg);
}
.clock {
  min-width: 92px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.box {
  font-weight: 600;
}
.fact {
  color: var(--el-text-color-secondary);
}
.run-body {
  padding: 0 0 6px 24px;
  background: var(--el-fill-color-lighter);
}
</style>
