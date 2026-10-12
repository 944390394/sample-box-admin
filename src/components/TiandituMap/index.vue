<template>
  <div class="tianditu">
    <div :id="mapId" class="canvas"></div>
    <div v-if="message" class="mask">{{ message }}</div>
  </div>
</template>

<script setup lang="ts">
import { loadTianditu, onTiandituKeyError } from "@/utils/tianditu";
import type { TiandituMap, TiandituOverlay } from "@/utils/tianditu";

export interface TiandituPoint {
  id: string;
  lng: number;
  lat: number;
  title: string;
  status?: string;
  lines: string[];
}

const props = defineProps<{
  points: TiandituPoint[];
  activeId?: string;
  focusToken?: number;
}>();

const emit = defineEmits<{
  select: [id: string];
}>();

const mapId = `tianditu-${Math.random().toString(36).slice(2, 8)}`;
const message = ref("正在加载天地图…");

let map: TiandituMap | null = null;
let stopKeyWatch: (() => void) | null = null;
const markers = new Map<string, { marker: TiandituOverlay; at: unknown; win: unknown }>();

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => {
    const named: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return named[char];
  });
}

function popup(point: TiandituPoint) {
  const body = point.lines.map((line) => escapeHtml(line)).join("<br>");
  return `<div class="tdt-box-popup"><b>${escapeHtml(point.title)}</b><br>${body}</div>`;
}

function labelHtml(point: TiandituPoint) {
  const tone = point.status === "异常" ? " is-alert" : "";
  return `<span class="tdt-box-label${tone}">${escapeHtml(point.title)}</span>`;
}

function draw() {
  const api = window.T;
  if (!map || !api) return;
  map.clearOverLays();
  markers.clear();
  const spots: unknown[] = [];
  for (const point of props.points) {
    const at = new api.LngLat(point.lng, point.lat);
    const marker = new api.Marker(at, { title: point.title });
    const win = new api.InfoWindow(popup(point), { autoPan: true, closeButton: true });
    marker.addEventListener("click", () => {
      marker.openInfoWindow(win);
      emit("select", point.id);
    });
    map.addOverLay(marker);
    if (api.Label) {
      map.addOverLay(
        new api.Label({
          text: labelHtml(point),
          position: at,
          offset: new api.Point(10, -8),
        })
      );
    }
    markers.set(point.id, { marker, at, win });
    spots.push(at);
  }
  if (props.focusToken && props.activeId && markers.has(props.activeId)) {
    show(props.activeId);
    return;
  }
  if (spots.length === 1) map.centerAndZoom(spots[0], 12);
  else if (spots.length > 1) map.setViewport(spots);
}

function show(id: string) {
  const item = markers.get(id);
  if (!item || !map) return;
  map.centerAndZoom(item.at, 13);
  item.marker.openInfoWindow(item.win);
}

watch(
  () => props.focusToken,
  (token) => {
    if (token && props.activeId) show(props.activeId);
  }
);

watch(
  () => props.points,
  () => draw(),
  { deep: true }
);

useResizeObserver(
  () => document.getElementById(mapId),
  () => map?.checkResize()
);

onMounted(async () => {
  stopKeyWatch = onTiandituKeyError((text) => {
    message.value = text;
  });
  try {
    await loadTianditu(
      import.meta.env.VITE_TIANDITU_TK ?? "",
      import.meta.env.VITE_TIANDITU_SK ?? ""
    );
    await nextTick();
    const api = window.T;
    const container = document.getElementById(mapId);
    if (!api || !container) throw new Error("天地图容器未就绪");
    map = new api.Map(container);
    map.centerAndZoom(new api.LngLat(113.8, 23.2), 6);
    map.enableScrollWheelZoom();
    map.addControl(new api.Control.Zoom());
    map.addControl(new api.Control.Scale());
    if (window.TMAP_NORMAL_MAP) map.addControl(new api.Control.MapType());
    message.value = "";
    draw();
    map.checkResize();
  } catch (error) {
    message.value = error instanceof Error ? error.message : "天地图加载失败";
  }
});

onActivated(() => {
  nextTick(() => map?.checkResize());
});

onBeforeUnmount(() => {
  stopKeyWatch?.();
  map?.clearOverLays();
  map = null;
});
</script>

<style scoped>
.tianditu {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 360px;
  background: #e7eef2;
}
.canvas {
  width: 100%;
  height: 100%;
}
.mask {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  color: var(--el-text-color-regular);
  text-align: center;
  background: rgb(255 255 255 / 88%);
}
</style>

<style>
.tdt-box-label {
  display: inline-block;
  padding: 2px 6px;
  font-size: 12px;
  line-height: 1.4;
  color: #fff;
  white-space: nowrap;
  background: #0f766e;
  border-radius: 999px;
}
.tdt-box-label.is-alert {
  background: #b45309;
}
.tdt-box-popup {
  min-width: 180px;
  font-size: 13px;
  line-height: 1.6;
  color: #1f2933;
}
</style>
