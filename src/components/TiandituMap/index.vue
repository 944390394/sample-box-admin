<template>
  <div class="tianditu">
    <div :id="mapId" ref="canvasRef" class="canvas"></div>
    <div v-if="message" class="mask">{{ message }}</div>
  </div>
</template>

<script setup lang="ts">
import SettingsAPI from "@/api/system/settings";
import { loadTianditu, onTiandituKeyError } from "@/utils/tianditu";
import type { TiandituMap, TiandituOverlay } from "@/utils/tianditu";

export interface TiandituPoint {
  id: string;
  lng: number;
  lat: number;
  title: string;
  status?: string;
  lines: string[];
  /** 逆地理得到的中文地址。还没返回时不传。 */
  address?: string;
  /** 当前位置用更大的圆点标出。 */
  emphasis?: boolean;
  /** 米制参考半径，仅供用户比较范围，不代表设备精度。 */
  referenceRadius?: number;
  /** 自定义图标：pin 是带字的大头针（地址用），badge 是带字的圆标（箱子用）。不传用天地图默认大头针。 */
  marker?: { glyph: string; color: string; shape: "pin" | "badge" };
}

/** 常驻的范围圈，如到达判定半径。 */
export interface TiandituCircle {
  lng: number;
  lat: number;
  radiusM: number;
  color: string;
}
export interface TiandituLine {
  points: { lng: number; lat: number }[];
  color: string;
  weight?: number;
  opacity?: number;
  dashed?: boolean;
}
export interface TiandituDot {
  lng: number;
  lat: number;
  color: string;
  title: string;
  size?: number;
  hollow?: boolean;
}

const props = defineProps<{
  points: TiandituPoint[];
  activeId?: string;
  focusToken?: number;
  /** 用圆点代替大头针，文字放到点击后的气泡里。 */
  compact?: boolean;
  circles?: TiandituCircle[];
  /** 折线：寄收连线、GPS 轨迹。点按顺序相连。 */
  lines?: TiandituLine[];
  /** 不带文字的小圆点，如轨迹上的定位点；悬停显示 title。 */
  dots?: TiandituDot[];
}>();

const emit = defineEmits<{
  select: [id: string];
}>();

const mapId = `tianditu-${Math.random().toString(36).slice(2, 8)}`;
const message = ref("正在加载天地图…");

let map: TiandituMap | null = null;
let stopKeyWatch: (() => void) | null = null;
const markers = new Map<string, { marker: TiandituOverlay; at: unknown; win: unknown }>();
let fittedKey = "";
let pendingOpen = "";
let userFocused = false;
let focusTimer = 0;
let onZoom: (() => void) | null = null;

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
  const address = point.address ? `<div class="addr">${escapeHtml(point.address)}</div>` : "";
  const rangeNote = point.referenceRadius
    ? `<div class="meta">基站参考半径 ${point.referenceRadius} 米<br>精度未知，设备不保证位于圈内</div>`
    : "";
  const body = point.lines.map((line) => escapeHtml(line)).join("<br>");
  return `<div class="tdt-box-popup"><b>${escapeHtml(point.title)}</b>${address}<div class="meta">${body}</div>${rangeNote}</div>`;
}

function labelHtml(point: TiandituPoint) {
  const tone =
    point.status === "异常"
      ? " is-alert"
      : point.status === "gps"
        ? " is-gps"
        : point.status === "both"
          ? " is-both"
          : "";
  const style = point.marker ? ` style="background:${point.marker.color}"` : "";
  return `<span class="tdt-box-label${tone}"${style}>${escapeHtml(point.title)}</span>`;
}

/** 自定义图标和对应的文字标签偏移（标签贴在图标右上方）。 */
function markerIcon(marker: NonNullable<TiandituPoint["marker"]>) {
  const glyph = escapeHtml(marker.glyph);
  if (marker.shape === "pin") {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="42" viewBox="0 0 32 42"><path d="M16 41C16 41 2 25.5 2 15.5a14 14 0 0 1 28 0C30 25.5 16 41 16 41z" fill="${marker.color}" stroke="#fff" stroke-width="2"/><circle cx="16" cy="15.5" r="9.5" fill="#fff"/><text x="16" y="20" text-anchor="middle" font-size="12" font-weight="700" font-family="sans-serif" fill="${marker.color}">${glyph}</text></svg>`;
    return { icon: iconFromSvg(svg, 32, 42, 16, 41), offset: [16, -40] as const };
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26"><rect x="2" y="2" width="22" height="22" rx="6" fill="${marker.color}" stroke="#fff" stroke-width="2"/><text x="13" y="17.5" text-anchor="middle" font-size="12" font-weight="700" font-family="sans-serif" fill="#fff">${glyph}</text></svg>`;
  return { icon: iconFromSvg(svg, 26, 26, 13, 13), offset: [14, -12] as const };
}

function dotColor(status?: string) {
  if (status === "异常") return "#b45309";
  if (status === "gps") return "#1d4ed8";
  if (status === "both") return "#6d28d9";
  return "#0f766e";
}

function iconFromSvg(
  svg: string,
  width: number,
  height = width,
  anchorX = width / 2,
  anchorY = height / 2
) {
  const api = window.T;
  if (!api?.Icon) return undefined;
  return new api.Icon({
    iconUrl: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`,
    iconSize: new api.Point(width, height),
    iconAnchor: new api.Point(anchorX, anchorY),
  });
}

/** 圆在经纬度上的外接四角，适配视野时一起算进去，圈不会被裁掉。 */
function circleCorners(circle: TiandituCircle) {
  const dLat = circle.radiusM / 110540;
  const dLng = circle.radiusM / (111320 * Math.cos((circle.lat * Math.PI) / 180));
  return [
    { lng: circle.lng - dLng, lat: circle.lat - dLat },
    { lng: circle.lng + dLng, lat: circle.lat + dLat },
  ];
}

let overlayRetry = 0;
/** Circle、Polyline 由天地图附加脚本提供，可能比主脚本晚到，没到就稍后重画。 */
function paintShapes() {
  const api = window.T;
  if (!map || !api) return;
  let missing = false;
  for (const circle of props.circles || []) {
    if (!api.Circle) {
      missing = true;
      break;
    }
    map.addOverLay(
      new api.Circle(new api.LngLat(circle.lng, circle.lat), circle.radiusM, {
        color: circle.color,
        weight: 2,
        opacity: 0.85,
        fillColor: circle.color,
        fillOpacity: 0.08,
        lineStyle: "dashed",
      })
    );
  }
  for (const line of props.lines || []) {
    if (line.points.length < 2) continue;
    if (!api.Polyline) {
      missing = true;
      break;
    }
    map.addOverLay(
      new api.Polyline(
        line.points.map((p) => new api.LngLat(p.lng, p.lat)),
        {
          color: line.color,
          weight: line.weight ?? 3,
          opacity: line.opacity ?? 0.8,
          lineStyle: line.dashed ? "dashed" : "solid",
        }
      )
    );
  }
  for (const dot of props.dots || []) {
    const size = dot.size ?? 10;
    const r = size / 2 - 1.5;
    const fill = dot.hollow ? "#fff" : dot.color;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="${fill}" stroke="${dot.hollow ? dot.color : "#fff"}" stroke-width="1.5"/></svg>`;
    let icon: unknown;
    try {
      icon = iconFromSvg(svg, size);
    } catch {
      icon = undefined;
    }
    if (icon)
      map.addOverLay(new api.Marker(new api.LngLat(dot.lng, dot.lat), { title: dot.title, icon }));
  }
  if (missing && overlayRetry < 10) {
    overlayRetry += 1;
    window.setTimeout(paint, 500);
  }
}

function dotIcon(point: TiandituPoint) {
  const size = point.emphasis ? 28 : 18;
  const radius = point.emphasis ? 9 : 6;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${radius}" fill="${dotColor(point.status)}" stroke="#fff" stroke-width="${point.emphasis ? 3 : 2}"/></svg>`;
  return iconFromSvg(svg, size);
}

function clusterIcon(count: number, color: string) {
  const label = count > 99 ? "99+" : String(count);
  const size = 40;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><circle cx="20" cy="20" r="16" fill="${color}" stroke="#fff" stroke-width="3"/><text x="20" y="25" text-anchor="middle" font-size="13" font-family="sans-serif" fill="#fff">${label}</text></svg>`;
  return iconFromSvg(svg, size);
}

/** 按当前缩放把屏幕上靠得很近的点收成一组。 */
function clusterAtZoom(points: TiandituPoint[], zoom: number) {
  const radius = 48;
  const scale = 256 * 2 ** zoom;
  const pixel = (lng: number, lat: number) => {
    const sin = Math.sin((lat * Math.PI) / 180);
    return {
      x: ((lng + 180) / 360) * scale,
      y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * scale,
    };
  };
  const parent = points.map((_, index) => index);
  const find = (index: number): number => {
    let cursor = index;
    while (parent[cursor] !== cursor) {
      parent[cursor] = parent[parent[cursor]];
      cursor = parent[cursor];
    }
    return cursor;
  };
  const pixels = points.map((point) => pixel(point.lng, point.lat));
  for (let left = 0; left < points.length; left += 1) {
    for (let right = left + 1; right < points.length; right += 1) {
      const dx = pixels[left].x - pixels[right].x;
      const dy = pixels[left].y - pixels[right].y;
      if (dx * dx + dy * dy <= radius * radius) parent[find(left)] = find(right);
    }
  }
  const groups = new Map<number, TiandituPoint[]>();
  points.forEach((point, index) => {
    const root = find(index);
    const list = groups.get(root) || [];
    list.push(point);
    groups.set(root, list);
  });
  const active = props.activeId;
  if (!active) return [...groups.values()];
  return [...groups.values()].flatMap((group) => {
    if (group.length < 2 || !group.some((point) => point.id === active)) return [group];
    const picked = group.filter((point) => point.id === active);
    const rest = group.filter((point) => point.id !== active);
    return rest.length ? [picked, rest] : [picked];
  });
}

function apartMeters(leftLng: number, leftLat: number, rightLng: number, rightLat: number) {
  const x = (leftLng - rightLng) * 111320 * Math.cos((leftLat * Math.PI) / 180);
  const y = (leftLat - rightLat) * 110540;
  return Math.hypot(x, y);
}

function fit(markersToFit: TiandituPoint[]) {
  const api = window.T;
  if (!map || !api) return;
  // 没有标注点、只有轨迹线时也要适配到轨迹
  const points = [
    ...markersToFit,
    ...(props.circles || []).flatMap(circleCorners),
    ...(props.lines || []).flatMap((line) => line.points),
  ];
  if (!points.length) return;
  if (points.length === 1) {
    map.centerAndZoom(new api.LngLat(points[0].lng, points[0].lat), props.compact ? 16 : 12);
    return;
  }
  let minLng = points[0].lng;
  let maxLng = points[0].lng;
  let minLat = points[0].lat;
  let maxLat = points[0].lat;
  for (const point of points) {
    minLng = Math.min(minLng, point.lng);
    maxLng = Math.max(maxLng, point.lng);
    minLat = Math.min(minLat, point.lat);
    maxLat = Math.max(maxLat, point.lat);
  }
  const span = apartMeters(minLng, minLat, maxLng, maxLat);
  const zoom = span < 300 ? 17 : span < 800 ? 16 : span < 1600 ? 15 : span < 4000 ? 14 : 0;
  if (props.compact && zoom) {
    map.centerAndZoom(new api.LngLat((minLng + maxLng) / 2, (minLat + maxLat) / 2), zoom);
    return;
  }
  map.setViewport(points.map((point) => new api.LngLat(point.lng, point.lat)));
}

function addMarker(at: unknown, title: string, icon: unknown, onClick: () => void) {
  const api = window.T;
  if (!map || !api) return null;
  const marker = new api.Marker(at, icon ? { title, icon } : { title });
  marker.addEventListener("click", onClick);
  map.addOverLay(marker);
  return marker;
}

function paint() {
  const api = window.T;
  if (!map || !api) return;
  map.clearOverLays();
  markers.clear();
  const selected = props.points.find((point) => point.id === props.activeId);
  if (selected?.referenceRadius && api.Circle) {
    map.addOverLay(
      new api.Circle(new api.LngLat(selected.lng, selected.lat), selected.referenceRadius, {
        color: "#0f766e",
        weight: 2,
        opacity: 0.8,
        fillColor: "#14b8a6",
        fillOpacity: 0.12,
        lineStyle: "dashed",
      })
    );
  }
  paintShapes();
  const zoom = map.getZoom?.();
  const groups =
    props.compact && typeof zoom === "number"
      ? clusterAtZoom(props.points, zoom)
      : props.points.map((point) => [point]);
  for (const group of groups) {
    if (group.length === 1) {
      const point = group[0];
      const at = new api.LngLat(point.lng, point.lat);
      let icon: unknown;
      let labelOffset: readonly [number, number] = [10, -8];
      try {
        if (props.compact) icon = dotIcon(point);
        else if (point.marker) {
          const custom = markerIcon(point.marker);
          icon = custom.icon;
          if (icon) labelOffset = custom.offset;
        }
      } catch {
        icon = undefined;
      }
      const win = new api.InfoWindow(popup(point), { autoPan: true, closeButton: true });
      const marker = addMarker(at, point.title, icon, () => {
        userFocused = true;
        pendingOpen = point.id;
        emit("select", point.id);
        marker?.openInfoWindow(win);
      });
      if (!marker) continue;
      if (!props.compact && api.Label) {
        map.addOverLay(
          new api.Label({
            text: labelHtml(point),
            position: at,
            offset: new api.Point(labelOffset[0], labelOffset[1]),
          })
        );
      }
      markers.set(point.id, { marker, at, win });
      continue;
    }
    const lng = group.reduce((sum, point) => sum + point.lng, 0) / group.length;
    const lat = group.reduce((sum, point) => sum + point.lat, 0) / group.length;
    const at = new api.LngLat(lng, lat);
    const mixed = new Set(group.map((point) => point.status || "lbs")).size > 1;
    let icon: unknown;
    try {
      icon = clusterIcon(group.length, mixed ? "#6d28d9" : dotColor(group[0].status));
    } catch {
      icon = undefined;
    }
    addMarker(at, `${group.length} 个地点`, icon, () => {
      const next = Math.min((map?.getZoom?.() || 12) + 2, 18);
      map?.centerAndZoom(at, next);
    });
  }
  if (!pendingOpen && props.activeId) pendingOpen = props.activeId;
  if (pendingOpen && markers.has(pendingOpen)) {
    const item = markers.get(pendingOpen);
    item?.marker.openInfoWindow(item.win);
    pendingOpen = "";
  }
}

function draw() {
  paint();
  const lineCount = (props.lines || []).reduce((n, line) => n + line.points.length, 0);
  const key = `${props.points.map((point) => point.id).join("|")}#${lineCount}`;
  if (userFocused) {
    fittedKey = key;
    return;
  }
  if (key !== fittedKey) {
    fit(props.points);
    fittedKey = key;
  }
}

function show(id: string) {
  const api = window.T;
  const point = props.points.find((item) => item.id === id);
  if (!point || !map || !api) return;
  pendingOpen = id;
  userFocused = true;
  const at = new api.LngLat(point.lng, point.lat);
  // 范围较大时适当拉远，保持圈与中心点可见；圆半径始终以米计。
  const radius = point.referenceRadius || 0;
  const zoom =
    radius >= 3000 ? 12 : radius >= 1000 ? 14 : radius >= 300 ? 15 : props.compact ? 17 : 13;
  const jump = () => {
    map?.centerAndZoom(at, zoom);
    map?.panTo?.(at);
  };
  jump();
  window.clearTimeout(focusTimer);
  // 缩放没变化时不会触发 zoomend，聚合点也不会立刻拆开。稍后再定位一次并打开气泡。
  focusTimer = window.setTimeout(() => {
    if (!map || pendingOpen !== id) return;
    jump();
    paint();
    const item = markers.get(id);
    if (!item) return;
    item.marker.openInfoWindow(item.win);
    pendingOpen = "";
    jump();
  }, 80);
}

watch(
  () => props.activeId,
  () => {
    pendingOpen = props.activeId || "";
    paint();
  }
);

watch(
  () => props.focusToken,
  (token) => {
    if (token && props.activeId) show(props.activeId);
  }
);

watch(
  () => [props.points, props.circles, props.lines, props.dots],
  () => draw(),
  { deep: true }
);

// 用模板引用观察容器：放在标签页里的地图第一次适配时容器可能还没尺寸，撑开后按新尺寸重新适配
const canvasRef = ref<HTMLElement>();
let resizeFrame = 0;
useResizeObserver(canvasRef, (entries) => {
  const box = entries[0]?.contentRect;
  if (!box || !box.width || !box.height) return;
  cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(() => {
    map?.checkResize();
    if (!userFocused) fit(props.points);
  });
});

async function mapKeys() {
  try {
    const settings = await SettingsAPI.get();
    if (settings.map?.tk) return settings.map;
  } catch {
    /* 设置接口不可用时退回构建时的环境变量。 */
  }
  return {
    tk: import.meta.env.VITE_TIANDITU_TK ?? "",
    sk: import.meta.env.VITE_TIANDITU_SK ?? "",
  };
}

onMounted(async () => {
  stopKeyWatch = onTiandituKeyError((text) => {
    message.value = text;
  });
  try {
    const keys = await mapKeys();
    await loadTianditu(keys.tk, keys.sk);
    await nextTick();
    const api = window.T;
    const container = document.getElementById(mapId);
    if (!api || !container) throw new Error("天地图容器未就绪");
    map = new api.Map(container);
    map.centerAndZoom(new api.LngLat(113.8, 23.2), 6);
    // 鼠标在地图上时滚轮只缩放地图，不让整页跟着滚
    map.enableScrollWheelZoom();
    container.addEventListener("wheel", (event) => event.preventDefault(), { passive: false });
    map.addControl(new api.Control.Zoom());
    map.addControl(new api.Control.Scale());
    if (window.TMAP_NORMAL_MAP) map.addControl(new api.Control.MapType());
    message.value = "";
    onZoom = () => paint();
    map.addEventListener?.("zoomend", onZoom);
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
  window.clearTimeout(focusTimer);
  if (onZoom) map?.removeEventListener?.("zoomend", onZoom);
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
.tdt-box-label.is-gps {
  background: #1d4ed8;
}
.tdt-box-label.is-both {
  background: #6d28d9;
}
.tdt-box-popup {
  min-width: 200px;
  max-width: 280px;
  font-size: 13px;
  line-height: 1.6;
  color: #1f2933;
}
.tdt-box-popup .addr {
  margin: 4px 0;
  font-size: 14px;
  font-weight: 600;
  line-height: 1.45;
}
.tdt-box-popup .meta {
  font-size: 12px;
  color: #66737f;
}
</style>
