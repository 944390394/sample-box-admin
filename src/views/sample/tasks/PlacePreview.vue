<template>
  <div class="place-preview" data-test="place-preview">
    <div class="map">
      <div :id="mapId" class="canvas"></div>
      <div v-if="message" class="mask">{{ message }}</div>
      <span v-else class="badge">只读预览</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import {
  loadTianditu,
  onTiandituKeyError,
  readMapKeys,
  type TiandituMap,
  type TiandituOverlay,
} from "@/utils/tianditu";

/**
 * #88 只读地图预览：公司地址/计划地点/检测站地址带出后给一个不可编辑的地图快照。
 * 与 LocationPicker 共用天地图加载器，但容器 pointer-events:none 屏蔽一切交互，
 * 大头针不可拖、不挂 click、不开放滚轮缩放——纯展示，改地址要走「自定义」或部门页。
 */
const props = defineProps<{
  lng: number | null;
  lat: number | null;
  radiusM?: number;
}>();

const mapId = `preview-${Math.random().toString(36).slice(2, 8)}`;
const message = ref("正在加载天地图…");
let map: TiandituMap | null = null;
let marker: TiandituOverlay | null = null;
let circle: unknown = null;
let stopKeyWatch: (() => void) | null = null;

function drawCircle(lng: number, lat: number, tries = 0) {
  const api = window.T;
  if (!map) return;
  if (!api?.Circle) {
    if (tries < 40) window.setTimeout(() => drawCircle(lng, lat, tries + 1), 250);
    return;
  }
  if (circle && map.removeOverLay) map.removeOverLay(circle);
  circle = null;
  if (!props.radiusM) return;
  circle = new api.Circle(new api.LngLat(lng, lat), props.radiusM, {
    color: "#2563eb",
    weight: 2,
    opacity: 0.8,
    fillColor: "#3b82f6",
    fillOpacity: 0.12,
    lineStyle: "dashed",
  });
  map.addOverLay(circle);
  const dLat = (props.radiusM * 1.2) / 111320;
  const dLng = dLat / Math.max(0.2, Math.cos((lat * Math.PI) / 180));
  map.setViewport([new api.LngLat(lng - dLng, lat - dLat), new api.LngLat(lng + dLng, lat + dLat)]);
}

function render() {
  const api = window.T;
  if (!api || !map) return;
  const { lng, lat } = props;
  if (lng == null || lat == null) {
    map.centerAndZoom(new api.LngLat(114.06, 22.55), 10);
    return;
  }
  const at = new api.LngLat(lng, lat);
  if (marker?.setLngLat) marker.setLngLat(at);
  else {
    marker = new api.Marker(at, { draggable: false });
    map.addOverLay(marker);
  }
  map.centerAndZoom(at, Math.max(map.getZoom?.() || 0, 15));
  drawCircle(lng, lat);
}

watch(() => [props.lng, props.lat, props.radiusM], render);

onMounted(async () => {
  stopKeyWatch = onTiandituKeyError((text) => (message.value = text));
  try {
    const keys = await readMapKeys();
    await loadTianditu(keys.tk, keys.sk);
    await nextTick();
    const api = window.T;
    const container = document.getElementById(mapId);
    if (!api || !container) throw new Error("天地图容器未就绪");
    map = new api.Map(container);
    map.disableScrollWheelZoom?.();
    render();
    message.value = "";
    window.setTimeout(() => map?.checkResize(), 400);
  } catch (error) {
    message.value = `${error instanceof Error ? error.message : "天地图加载失败"}，地址文字仍可见`;
  }
});

onBeforeUnmount(() => {
  stopKeyWatch?.();
  map = null;
  marker = null;
  circle = null;
});
</script>

<style scoped>
.place-preview {
  width: 100%;
}
.map {
  position: relative;
  z-index: 0;
  height: 240px;
  overflow: hidden;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 6px;
  isolation: isolate;
}
/* 只读：屏蔽一切鼠标交互，地图仅作快照展示 */
.canvas {
  width: 100%;
  height: 100%;
  pointer-events: none;
}
.badge {
  position: absolute;
  top: 10px;
  right: 10px;
  z-index: 500;
  padding: 2px 8px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  pointer-events: none;
  background: rgba(255, 255, 255, 0.9);
  border-radius: 10px;
}
.mask {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  color: var(--el-text-color-secondary);
  text-align: center;
  background: var(--el-fill-color-lighter);
}
</style>
