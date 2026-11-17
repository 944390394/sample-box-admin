<template>
  <div class="timeline">
    <el-radio-group v-model="filter" size="small" class="filter">
      <el-radio-button value="">全部 {{ items.length }}</el-radio-button>
      <el-radio-button value="flow">流转 {{ count.flow }}</el-radio-button>
      <el-radio-button value="lid">开关箱 {{ count.lid }}</el-radio-button>
      <el-radio-button value="place">进出 {{ count.place }}</el-radio-button>
      <el-radio-button value="link">信号 {{ count.link }}</el-radio-button>
    </el-radio-group>

    <div v-if="shown.length" class="list">
      <template v-for="group in groups" :key="group.day">
        <div class="day">{{ group.day }}</div>
        <div
          v-for="item in group.items"
          :key="item.key"
          class="item"
          :class="[`is-${item.type}`, { clickable: !!item.boxId }]"
          @click="item.boxId && emit('focus', item.boxId)"
        >
          <span class="icon">
            <el-icon><component :is="item.icon" /></el-icon>
          </span>
          <div class="body">
            <div class="line">
              <b>{{ item.title }}</b>
              <span v-if="item.by" class="by">{{ item.by }}</span>
              <span class="time" :title="fullTime(item.time)">{{ hourMinute(item.time) }}</span>
            </div>
            <p v-if="item.note" class="note">{{ item.note }}</p>
            <p v-if="item.extra" class="muted">{{ item.extra }}</p>
            <span
              v-if="recordVideo && item.video"
              class="video-slot"
              :class="{ ready: !!item.video.url }"
              @click.stop="openVideo(item.video.id)"
            >
              <el-icon><VideoCamera /></el-icon>
              {{ item.video.url ? "查看开箱录像" : `开箱录像：${item.video.status || "已请求"}` }}
            </span>
          </div>
        </div>
      </template>
    </div>
    <el-empty
      v-else
      :image-size="56"
      :description="items.length ? '没有这类记录' : '这张任务单创建于流转记录上线之前'"
    />
  </div>
</template>

<script setup lang="ts">
import {
  Box,
  Connection,
  Location,
  Lock,
  Promotion,
  SwitchButton,
  Unlock,
  Van,
  VideoCamera,
  Warning,
} from "@element-plus/icons-vue";
import {
  formatDistance,
  type TaskEvent,
  type TaskLog,
  type TaskVideo,
} from "@/api/sample/report-policy";
import type { Component } from "vue";
import { fullTime, toDate } from "@/utils/time";

/**
 * 任务动态：流转记录、开关箱和上电、进出任务地点、失联和信号不好，合在一条时间线里，新的在上，按天分组。
 * 点箱子相关的一条在地图上定位那台箱子。要求录像的任务，开箱下面带录像状态。
 */
const props = defineProps<{
  logs: TaskLog[];
  events: TaskEvent[];
  videos: TaskVideo[];
  names?: Record<string, string>;
  recordVideo?: boolean;
}>();
const emit = defineEmits<{ focus: [boxId: string]; video: [id: string] }>();

type Kind = "flow" | "lid" | "place" | "link";
interface Item {
  key: string;
  type: Kind;
  time: string;
  title: string;
  by?: string;
  note?: string;
  extra?: string;
  boxId?: string;
  icon: Component;
  video?: TaskVideo;
}

const filter = ref<"" | Kind>("");
const nameOf = (id: string) => props.names?.[id] || id;

/** 同一台箱子开箱前后 10 分钟内的录像算这次开箱的。 */
function videoFor(boxId: string, time: string) {
  const at = toDate(time)?.getTime() ?? 0;
  return props.videos.find(
    (v) =>
      v.boxId === boxId &&
      Math.abs((toDate(v.openedAt || v.recordedAt)?.getTime() ?? 0) - at) <= 600000
  );
}
function openVideo(id: string) {
  emit("video", id);
}

/** 设备和推出来的事件怎么说。 */
function describe(event: TaskEvent): Pick<Item, "type" | "title" | "extra" | "icon"> {
  const name = nameOf(event.boxId);
  if (event.kind === "pad") return { type: "lid", title: `${name} 被打开`, icon: Unlock };
  if (event.kind === "shut") return { type: "lid", title: `${name} 已关上`, icon: Lock };
  if (event.kind === "boot")
    return {
      type: "link",
      title: `${name} 重新上电`,
      extra: "设备重启或换了电池",
      icon: SwitchButton,
    };
  if (event.kind === "leave")
    return { type: "place", title: `${name} ${event.label}`, extra: event.text, icon: Van };
  if (event.kind === "arrive")
    return { type: "place", title: `${name} ${event.label}`, extra: event.text, icon: Location };
  // 信号不好（补全了）、数据不全（只补回一部分）、连接不稳定（多次短失联合成一条）都用服务端给的说法
  if (event.kind === "weak" || event.kind === "partial")
    return { type: "link", title: `${name} ${event.label}`, extra: event.text, icon: Connection };
  if (event.kind === "lost")
    return { type: "link", title: `${name} 失联中`, extra: event.text, icon: Warning };
  return {
    type: "link",
    title: `${name} ${event.label || "连接中断"}`,
    extra: event.text,
    icon: Warning,
  };
}

const items = computed<Item[]>(() => {
  const list: Item[] = props.logs.map((log, index) => ({
    key: `log-${index}`,
    type: "flow",
    time: log.time,
    title: log.action,
    by: log.by,
    note: log.note,
    icon: log.action === "创建" ? Box : Promotion,
    extra: log.detail
      ? `当时距${log.detail.target.role}：${log.detail.boxes.map((b) => `${nameOf(b.id)} ${formatDistance(b.distanceM)}${b.source ? `（${b.source}）` : ""}`).join("，")}`
      : "",
  }));
  props.events.forEach((event, index) => {
    list.push({
      key: `ev-${index}`,
      time: event.time,
      boxId: event.boxId,
      ...describe(event),
      video: event.kind === "pad" ? videoFor(event.boxId, event.time) : undefined,
    });
  });
  return list.sort((a, b) => (toDate(b.time)?.getTime() ?? 0) - (toDate(a.time)?.getTime() ?? 0));
});
const count = computed(() => {
  const n = (kind: Kind) => items.value.filter((i) => i.type === kind).length;
  return { flow: n("flow"), lid: n("lid"), place: n("place"), link: n("link") };
});
const shown = computed(() =>
  filter.value ? items.value.filter((i) => i.type === filter.value) : items.value
);
const groups = computed(() => {
  const result: { day: string; items: Item[] }[] = [];
  for (const item of shown.value) {
    const d = toDate(item.time);
    const day = d ? `${d.getMonth() + 1} 月 ${d.getDate()} 日` : "时间未知";
    if (result.at(-1)?.day !== day) result.push({ day, items: [] });
    result.at(-1)!.items.push(item);
  }
  return result;
});
function hourMinute(time: string) {
  return fullTime(time).slice(11, 16);
}
</script>

<style scoped>
.timeline {
  display: flex;
  flex-direction: column;
  gap: 10px;
  height: 100%;
  min-height: 0;
}
.filter {
  flex-shrink: 0;
}
.list {
  flex: 1;
  min-height: 0;
  padding-right: 4px;
  overflow: auto;
}
.day {
  position: sticky;
  top: 0;
  z-index: 1;
  padding: 6px 0 4px;
  font-size: 12px;
  font-weight: 600;
  color: var(--el-text-color-secondary);
  background: var(--el-bg-color);
}
.item {
  position: relative;
  display: flex;
  gap: 10px;
  padding: 6px 6px 10px 0;
  border-radius: 6px;
}
.item:not(:last-child)::before {
  position: absolute;
  top: 30px;
  bottom: -2px;
  left: 13px;
  width: 2px;
  content: "";
  background: var(--el-border-color-lighter);
}
.item.clickable {
  cursor: pointer;
}
.item.clickable:hover {
  background: var(--el-fill-color-lighter);
}
.icon {
  position: relative;
  z-index: 1;
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  font-size: 14px;
  color: #fff;
  border-radius: 50%;
}
.is-flow .icon {
  background: var(--el-color-primary);
}
.is-lid .icon {
  background: var(--el-color-warning);
}
.is-place .icon {
  background: var(--el-color-success);
}
.is-link .icon {
  background: var(--el-color-info);
}
.body {
  flex: 1;
  min-width: 0;
}
.line {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: baseline;
  line-height: 28px;
}
.by {
  font-size: 13px;
  color: var(--el-text-color-regular);
}
.time {
  margin-left: auto;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: var(--el-text-color-secondary);
}
.note {
  padding: 4px 8px;
  margin: 2px 0 0;
  font-size: 13px;
  background: var(--el-fill-color-lighter);
  border-radius: 4px;
}
.muted {
  margin: 4px 0 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--el-text-color-secondary);
}
.video-slot {
  display: inline-flex;
  gap: 4px;
  align-items: center;
  padding: 2px 8px;
  margin-top: 4px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  cursor: pointer;
  border: 1px dashed var(--el-border-color);
  border-radius: 4px;
}
.video-slot.ready {
  color: var(--el-color-primary);
  border-color: var(--el-color-primary-light-5);
  border-style: solid;
}
</style>
