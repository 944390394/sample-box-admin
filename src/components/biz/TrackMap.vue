<template>
  <div class="track-map">
    <div class="tools">
      <el-checkbox v-model="showGps" size="small">GPS 轨迹</el-checkbox>
      <el-checkbox v-model="showLbs" size="small">基站点（按时间连线）</el-checkbox>
      <slot name="tools" />
    </div>
    <div class="map" :style="{ height }">
      <TiandituMap
        :points="points"
        :circles="circles"
        :lines="lines"
        :dots="dots"
        :active-id="activeId"
        :focus-token="focusToken"
      />
    </div>
    <div class="legend">
      <slot name="legend" />
      <span>
        <b class="line-sample" />
        GPS 轨迹
      </span>
      <span>
        <b class="line-sample dashed" />
        按时间连接所有定位（含基站）
      </span>
      <span>
        <i class="hollow" />
        基站定位，误差可能一两公里
      </span>
      <span>
        <i class="solid" />
        最后一个定位
      </span>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { BoxTrack } from "@/api/sample/box";
import TiandituMap, {
  type TiandituCircle,
  type TiandituDot,
  type TiandituLine,
  type TiandituPoint,
} from "@/components/TiandituMap/index.vue";
import { shortTime, toDate } from "@/utils/time";

/**
 * 轨迹地图：采样箱详情和任务详情共用。
 * GPS 点连成实线；勾上基站点后，GPS 和基站点按时间连成细虚线，同一位置连续出现的合并成一个停留点。
 * 一个 GPS 点都没有、只有基站定位时，默认勾上基站点，否则地图上什么都看不到。
 * focus 是选中的箱子：其他箱子的线变淡、点隐藏。
 */
const props = withDefaults(
  defineProps<{
    tracks: BoxTrack[];
    colors: Record<string, string>;
    names?: Record<string, string>;
    points?: TiandituPoint[];
    circles?: TiandituCircle[];
    extraLines?: TiandituLine[];
    focus?: string;
    activeId?: string;
    focusToken?: number;
    height?: string;
  }>(),
  {
    names: () => ({}),
    points: () => [],
    circles: () => [],
    extraLines: () => [],
    focus: "",
    activeId: "",
    focusToken: 0,
    height: "440px",
  }
);

const showGps = ref(true);
const showLbs = ref(false);
let decided = false;
watch(
  () => props.tracks,
  (list) => {
    // 只在第一次拿到数据时决定，之后以用户勾选为准
    if (decided || !list.length) return;
    decided = true;
    if (!list.some((t) => t.gpsCount) && list.some((t) => t.lbsCount)) showLbs.value = true;
  },
  { immediate: true }
);

interface Stay {
  lng: number;
  lat: number;
  from: string;
  to: string;
  count: number;
  source: "GPS" | "基站";
  sumLng: number;
  sumLat: number;
}
/** 相邻定位离这段停留的中心不到这么远，算原地漂移，并成一个点。 */
const JITTER_M = 30;
function apart(a: { lng: number; lat: number }, b: { lng: number; lat: number }) {
  const x = (a.lng - b.lng) * 111320 * Math.cos((a.lat * Math.PI) / 180);
  const y = (a.lat - b.lat) * 110540;
  return Math.hypot(x, y);
}
/**
 * 按时间排好的定位，原地漂移的并成一段停留：
 * 相邻的点离当前停留中心不到 30 米就并进去，停留点取这些点的平均位置，记下起止时间和次数。
 */
function timeline(track: BoxTrack, withGps: boolean, withLbs: boolean) {
  const all = [
    ...(withGps ? track.gps.map((p) => ({ ...p, source: "GPS" as const })) : []),
    ...(withLbs ? track.lbs.map((p) => ({ ...p, source: "基站" as const })) : []),
  ].sort((a, b) => (toDate(a.t)?.getTime() ?? 0) - (toDate(b.t)?.getTime() ?? 0));
  const stays: Stay[] = [];
  for (const p of all) {
    const last = stays.at(-1);
    if (last && last.source === p.source && apart(last, p) <= JITTER_M) {
      last.to = p.t;
      last.count += 1;
      last.sumLng += p.lng;
      last.sumLat += p.lat;
      last.lng = last.sumLng / last.count;
      last.lat = last.sumLat / last.count;
    } else
      stays.push({
        lng: p.lng,
        lat: p.lat,
        from: p.t,
        to: p.t,
        count: 1,
        source: p.source,
        sumLng: p.lng,
        sumLat: p.lat,
      });
  }
  return stays;
}
function stayText(stay: Stay) {
  return stay.count > 1
    ? `${shortTime(stay.from)} 至 ${shortTime(stay.to)}，${stay.count} 次定位并成一点`
    : shortTime(stay.from);
}
const nameOf = (id: string) => props.names[id] || id;

const lines = computed<TiandituLine[]>(() => {
  const list: TiandituLine[] = [...props.extraLines];
  for (const track of props.tracks) {
    const dim = props.focus && props.focus !== track.boxId;
    const color = props.colors[track.boxId] || "#2563eb";
    // GPS 线连停留点，原地漂移不再画成一团乱线
    if (showGps.value)
      list.push({
        points: timeline(track, true, false),
        color,
        weight: dim ? 3 : 5,
        opacity: dim ? 0.25 : 0.85,
      });
    if (showLbs.value)
      list.push({
        points: timeline(track, true, true),
        color,
        weight: 2,
        opacity: dim ? 0.2 : 0.6,
        dashed: true,
      });
  }
  return list;
});

const dots = computed<TiandituDot[]>(() => {
  const list: TiandituDot[] = [];
  const visible = props.tracks.filter((t) => !props.focus || t.boxId === props.focus);
  // 定位点多了会拖慢地图，超过 300 个只画轨迹线和起点
  const every = visible.reduce((n, t) => n + t.gps.length, 0) <= 300;
  for (const track of visible) {
    const color = props.colors[track.boxId] || "#2563eb";
    const name = nameOf(track.boxId);
    if (showGps.value && track.gps.length) {
      const stays = timeline(track, true, false);
      const first = stays[0];
      list.push({
        lng: first.lng,
        lat: first.lat,
        color,
        size: 14,
        hollow: true,
        title: `${name} 这段时间第一个 GPS 位置 · ${stayText(first)}`,
      });
      // 停留越久点越大，最大 14
      if (every)
        for (const stay of stays.slice(1))
          list.push({
            lng: stay.lng,
            lat: stay.lat,
            color,
            size: Math.min(14, 7 + Math.floor(Math.log2(stay.count))),
            title: `${name} · ${stayText(stay)}`,
          });
    }
    if (showLbs.value) {
      for (const stay of timeline(track, false, true)) {
        list.push({
          lng: stay.lng,
          lat: stay.lat,
          color,
          size: 10,
          hollow: true,
          title: `${name} 基站定位 · ${stayText(stay)}`,
        });
      }
    }
    const shown = timeline(track, showGps.value, showLbs.value);
    const end = shown.at(-1);
    if (end && shown.length > 1)
      list.push({
        lng: end.lng,
        lat: end.lat,
        color,
        size: 12,
        title: `${name} 最后一个定位（${end.source}）· ${shortTime(end.to)}`,
      });
  }
  return list;
});
</script>

<style scoped>
.tools {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: center;
  margin-bottom: 8px;
}
.legend {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 14px;
  margin-top: 8px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.legend :deep(i) {
  display: inline-block;
  width: 10px;
  height: 10px;
  margin-right: 4px;
  vertical-align: -1px;
  border-radius: 50%;
}
.legend i.hollow {
  box-sizing: border-box;
  background: #fff;
  border: 2px solid #2563eb;
}
.legend i.solid {
  background: #2563eb;
}
.line-sample {
  display: inline-block;
  width: 18px;
  height: 4px;
  margin-right: 4px;
  vertical-align: 2px;
  background: #2563eb;
  border-radius: 2px;
}
.line-sample.dashed {
  height: 0;
  background: none;
  border-top: 2px dashed #2563eb;
}
</style>
