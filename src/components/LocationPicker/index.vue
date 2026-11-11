<template>
  <div class="picker">
    <div class="search">
      <el-cascader
        v-model="regionPath"
        :options="regionOptions"
        :props="{ checkStrictly: true }"
        placeholder="全国"
        clearable
        filterable
        class="region"
        @change="onRegionChange"
      />
      <el-input
        v-model="keyword"
        :prefix-icon="Search"
        placeholder="搜索地名、小区、单位，回车搜索"
        clearable
        autocomplete="off"
        name="tdt-place-keyword"
        @keyup.enter="search()"
        @clear="closeHits"
      />
      <el-button :loading="searching" :disabled="!keyword.trim()" @click="search()">搜索</el-button>
      <div v-if="regions.length || hits.length" class="hits">
        <template v-if="regions.length">
          <p class="hits-tip">「{{ lastKeyword }}」在这些地区都有，先选地区：</p>
          <ul>
            <li v-for="r in regions" :key="r.code" @click="pickRegion(r)">
              <b>{{ r.name }}</b>
              <span>{{ r.count }} 个结果</span>
            </li>
          </ul>
        </template>
        <ul v-else>
          <li v-for="(hit, index) in hits" :key="index" @click="pick(hit)">
            <b>
              {{ hit.name }}
              <em v-if="hit.type">{{ hit.type }}</em>
            </b>
            <span>{{ hit.address }}</span>
          </li>
          <li v-if="hits.length < total" class="more" @click="search(page + 1)">
            还有 {{ total - hits.length }} 个，加载更多
          </li>
        </ul>
      </div>
    </div>
    <div class="map">
      <div :id="mapId" class="canvas"></div>
      <div v-if="message" class="mask">{{ message }}</div>
      <span v-else class="hint">点地图或拖动大头针定位</span>
    </div>
    <el-input
      :model-value="modelValue?.address || ''"
      type="textarea"
      :autosize="{ minRows: 1, maxRows: 3 }"
      maxlength="255"
      autocomplete="off"
      placeholder="地址，定位后自动填入，可补楼号、收发室"
      @update:model-value="setAddress"
    />
    <div class="coords">
      <span v-if="hasCoords">
        坐标 {{ modelValue!.lng!.toFixed(5) }}, {{ modelValue!.lat!.toFixed(5) }}
      </span>
      <span v-else class="muted">还没有坐标，不能自动计算距离</span>
      <span v-if="resolving" class="muted">正在反查地址…</span>
      <span class="grow"></span>
      <el-button v-if="modelValue" link type="danger" size="small" @click="clear">
        清除位置
      </el-button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { Search } from "@element-plus/icons-vue";
import GeoAPI, { toGbCode, type PlaceHit, type RegionHit } from "@/api/geo";
import {
  loadTianditu,
  onTiandituKeyError,
  readLngLat,
  readMapKeys,
  resolveChineseAddress,
  type TiandituLngLat,
  type TiandituMap,
  type TiandituOverlay,
} from "@/utils/tianditu";

export interface PickedPlace {
  address: string;
  lng: number | null;
  lat: number | null;
}

/** radiusM：在大头针周围画一个圈，表示到达判定的误差范围。 */
const props = defineProps<{ modelValue: PickedPlace | null; radiusM?: number }>();
const emit = defineEmits<{ "update:modelValue": [value: PickedPlace | null] }>();

const mapId = `picker-${Math.random().toString(36).slice(2, 8)}`;
const message = ref("正在加载天地图…");
const ready = ref(false);
const keyword = ref("");
const searching = ref(false);
const resolving = ref(false);
const hits = ref<PlaceHit[]>([]);
const regions = ref<RegionHit[]>([]);
const total = ref(0);
const page = ref(0);
const lastKeyword = ref("");

/*
 * 搜索范围：先选省、市再搜更准。省市数据只在打开地图选点时才加载；
 * 选过的范围记在本机，下次打开还是它。
 */
type RegionOption = { value: string; label: string; children?: RegionOption[] };
const REGION_KEY = "location-picker.region";
const regionOptions = shallowRef<RegionOption[]>([]);
const regionPath = ref<string[]>(readSavedRegion());
const regionCode = computed(() =>
  regionPath.value?.length ? toGbCode(regionPath.value[regionPath.value.length - 1]) : ""
);
function readSavedRegion(): string[] {
  try {
    const saved = JSON.parse(localStorage.getItem(REGION_KEY) || "[]");
    return Array.isArray(saved) ? saved.map(String) : [];
  } catch {
    return [];
  }
}
function onRegionChange() {
  try {
    localStorage.setItem(REGION_KEY, JSON.stringify(regionPath.value || []));
  } catch {
    /* 本机存不了就算了 */
  }
  if (keyword.value.trim()) void search();
}
import("element-china-area-data").then((data) => {
  // 直辖市下一级是区，其他省下一级是市；区县不再往下列，免得太长
  regionOptions.value = (data.provinceAndCityData as RegionOption[]).map((province) => ({
    value: province.value,
    label: province.label,
    children: province.children?.map((city) => ({ value: city.value, label: city.label })),
  }));
});

function closeHits() {
  hits.value = [];
  regions.value = [];
}
const hasCoords = computed(() => props.modelValue?.lng != null && props.modelValue?.lat != null);

let map: TiandituMap | null = null;
let marker: TiandituOverlay | null = null;
let circle: unknown = null;
let stopKeyWatch: (() => void) | null = null;
let resolveSeq = 0;

function setAddress(address: string) {
  emit("update:modelValue", {
    address,
    lng: props.modelValue?.lng ?? null,
    lat: props.modelValue?.lat ?? null,
  });
}

function clear() {
  if (marker && map?.removeOverLay) map.removeOverLay(marker);
  if (circle && map?.removeOverLay) map.removeOverLay(circle);
  marker = null;
  circle = null;
  emit("update:modelValue", null);
}

/** 放大头针；只有坐标变了才动地图中心。 */
function placeMarker(lng: number, lat: number, center = true) {
  const api = window.T;
  if (!api || !map) return;
  const at = new api.LngLat(lng, lat);
  if (marker?.setLngLat) marker.setLngLat(at);
  else {
    marker = new api.Marker(at, { draggable: true });
    marker.addEventListener("dragend", (event) => {
      const point = readLngLat(event?.lnglat);
      if (point) moveTo(point.lng, point.lat, false);
    });
    map.addOverLay(marker);
  }
  if (center) map.centerAndZoom(at, Math.max(map.getZoom?.() || 0, 15));
  drawCircle(lng, lat, center);
}

/** 误差范围的圈；fit 为真时缩放到能看见整个圈。 */
function drawCircle(lng?: number | null, lat?: number | null, fit = false, tries = 0) {
  const api = window.T;
  if (!map) return;
  // Circle 随 service.js 异步加载，地图出来时可能还没有，稍等再画
  if (!api?.Circle) {
    if (tries < 40)
      window.setTimeout(
        () => drawCircle(props.modelValue?.lng, props.modelValue?.lat, fit, tries + 1),
        250
      );
    return;
  }
  if (circle && map.removeOverLay) map.removeOverLay(circle);
  circle = null;
  if (lng == null || lat == null || !props.radiusM) return;
  circle = new api.Circle(new api.LngLat(lng, lat), props.radiusM, {
    color: "#2563eb",
    weight: 2,
    opacity: 0.8,
    fillColor: "#3b82f6",
    fillOpacity: 0.12,
    lineStyle: "dashed",
  });
  map.addOverLay(circle);
  if (fit) {
    const dLat = (props.radiusM * 1.2) / 111320;
    const dLng = dLat / Math.max(0.2, Math.cos((lat * Math.PI) / 180));
    map.setViewport([
      new api.LngLat(lng - dLng, lat - dLat),
      new api.LngLat(lng + dLng, lat + dLat),
    ]);
  }
}
watch(
  () => props.radiusM,
  () => drawCircle(props.modelValue?.lng, props.modelValue?.lat, true)
);

/** 选定新坐标后反查地址；用户手改过的地址也会被新的反查结果覆盖，坐标和文字保持一致。 */
async function moveTo(lng: number, lat: number, center = true, address?: string) {
  placeMarker(lng, lat, center);
  emit("update:modelValue", { address: address ?? props.modelValue?.address ?? "", lng, lat });
  if (address) return;
  const seq = ++resolveSeq;
  resolving.value = true;
  try {
    const result = await resolveChineseAddress(lng, lat);
    if (seq !== resolveSeq) return;
    // 反查结果常带「…西南约69米」这种相对方位，当地址用时去掉
    if (result.status === "resolved")
      emit("update:modelValue", {
        address: result.address.replace(/[东南西北]{1,2}(方向)?约?\d+(\.\d+)?米$/, ""),
        lng,
        lat,
      });
    else if (result.status === "error")
      ElMessage.warning(result.message || "地址反查失败，可以手动填写");
  } finally {
    if (seq === resolveSeq) resolving.value = false;
  }
}

/** 全国搜到多个省、或某省搜到多个市时，选一个地区再搜。 */
function pickRegion(region: RegionHit) {
  const code = region.code.slice(3);
  const province = code.slice(0, 2);
  const city = code.slice(0, 4);
  regionPath.value = code.slice(2) === "0000" ? [province] : [province, city];
  if (map && window.T && region.lng != null && region.lat != null) {
    map.centerAndZoom(
      new window.T.LngLat(region.lng, region.lat),
      code.slice(2) === "0000" ? 7 : 11
    );
  }
  onRegionChange();
}

function pick(hit: PlaceHit) {
  closeHits();
  const text =
    hit.address && !hit.address.includes(hit.name)
      ? `${hit.address}${hit.name}`
      : hit.address || hit.name;
  void moveTo(hit.lng, hit.lat, true, text);
}

/** 交给服务器按选定的省市搜；next 是翻页。 */
async function search(next = 0) {
  const text = keyword.value.trim();
  if (!text) return;
  searching.value = true;
  try {
    const result = await GeoAPI.search(text, regionCode.value, next);
    lastKeyword.value = text;
    page.value = next;
    total.value = result.total;
    if (result.kind === "regions") {
      regions.value = result.items;
      hits.value = [];
    } else {
      regions.value = [];
      hits.value = next ? [...hits.value, ...result.items] : result.items;
    }
    if (!regions.value.length && !hits.value.length)
      ElMessage.info(
        regionCode.value
          ? "这个地区没找到，换个关键词或地区，也可以直接在地图上点选"
          : "没有找到，换个关键词，或先选省市再搜"
      );
  } catch {
    // 错误提示由请求拦截器弹出
  } finally {
    searching.value = false;
  }
}

function onClick(event?: { lnglat?: TiandituLngLat }) {
  const point = readLngLat(event?.lnglat);
  if (point) void moveTo(point.lng, point.lat, false);
}

// 外部换了一个地址（比如切换单位）时同步大头针
watch(
  () => [props.modelValue?.lng, props.modelValue?.lat],
  ([lng, lat]) => {
    if (!map || lng == null || lat == null) return;
    placeMarker(lng, lat);
  }
);

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
    map.enableScrollWheelZoom();
    map.addControl(new api.Control.Zoom());
    map.addEventListener?.("click", onClick);
    const { lng, lat } = props.modelValue || {};
    if (lng != null && lat != null) placeMarker(lng, lat);
    else map.centerAndZoom(new api.LngLat(114.06, 22.55), 10);
    message.value = "";
    ready.value = true;
    // 放在弹窗里时，弹窗动画结束前容器尺寸还不对
    window.setTimeout(() => map?.checkResize(), 400);
  } catch (error) {
    message.value = `${error instanceof Error ? error.message : "天地图加载失败"}，仍可只填写地址文字`;
  }
});

onBeforeUnmount(() => {
  stopKeyWatch?.();
  map?.removeEventListener?.("click", onClick);
  map = null;
  marker = null;
  circle = null;
});
</script>

<style scoped>
.picker {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
}
.search {
  position: relative;
  z-index: 1;
  display: flex;
  gap: 8px;
}
.region {
  flex: 0 0 180px;
}
.search > .el-input {
  flex: 1;
  min-width: 160px;
}
@media (max-width: 640px) {
  .search {
    flex-wrap: wrap;
  }
  .region {
    flex-basis: 100%;
  }
}
/* 浏览器把搜索框当成地址栏自动填充时会涂成浅蓝，这里盖回正常底色 */
.search :deep(input:-webkit-autofill),
.search :deep(input:-webkit-autofill:hover),
.search :deep(input:-webkit-autofill:focus) {
  -webkit-text-fill-color: var(--el-text-color-regular);
  box-shadow: 0 0 0 1000px var(--el-fill-color-blank) inset;
  transition: background-color 99999s;
}
.hits {
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
  left: 0;
  z-index: 2000;
  max-height: 240px;
  padding: 4px 0;
  margin: 0;
  overflow: auto;
  list-style: none;
  background: var(--el-bg-color-overlay);
  border: 1px solid var(--el-border-color-light);
  border-radius: 6px;
  box-shadow: var(--el-box-shadow-light);
}
.hits ul {
  padding: 0;
  margin: 0;
  list-style: none;
}
.hits-tip {
  margin: 4px 12px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.hits em {
  margin-left: 6px;
  font-size: 12px;
  font-style: normal;
  font-weight: normal;
  color: var(--el-text-color-placeholder);
}
.hits .more {
  font-size: 12px;
  color: var(--el-color-primary);
}
.hits li {
  display: flex;
  flex-direction: column;
  padding: 6px 12px;
  line-height: 1.4;
  cursor: pointer;
}
.hits li:hover {
  background: var(--el-fill-color-light);
}
.hits span {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
/* 天地图内部图层 z-index 有几百，单独成一层，免得盖住上面的搜索结果 */
.map {
  position: relative;
  z-index: 0;
  height: 300px;
  overflow: hidden;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 6px;
  isolation: isolate;
}
.canvas {
  width: 100%;
  height: 100%;
}
.hint {
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
.coords {
  display: flex;
  gap: 12px;
  align-items: center;
  margin: -2px 0 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--el-text-color-secondary);
}
.grow {
  flex: 1;
}
.muted {
  color: var(--el-text-color-placeholder);
}
</style>
