<template>
  <el-card shadow="never" class="map-card">
    <template #header>
      <div class="map-head">
        <div class="map-title">
          <span>位置</span>
          <small>{{ points.length }} 个地点</small>
        </div>
        <div class="map-tools">
          <span class="legend">
            <i class="dot lbs"></i>
            基站
          </span>
          <span class="legend">
            <i class="dot gps"></i>
            GPS
          </span>
          <span class="legend">
            <i class="dot both"></i>
            重合
          </span>
          <el-checkbox-group v-model="layers" size="small">
            <el-checkbox value="lbs">基站</el-checkbox>
            <el-checkbox value="gps">GPS</el-checkbox>
          </el-checkbox-group>
        </div>
      </div>
    </template>
    <div class="range-tools">
      <el-switch v-model="showRange" active-text="基站参考范围" />
      <el-select
        v-model="referenceRadius"
        size="small"
        style="width: 115px"
        aria-label="基站参考半径"
        :disabled="!showRange"
      >
        <el-option
          v-for="radius in [100, 300, 500, 1000, 3000]"
          :key="radius"
          :label="`${radius} 米`"
          :value="radius"
        />
      </el-select>
      <span>
        {{
          points.some((point) => point.id === activeId && point.referenceRadius)
            ? "虚线圈仅作范围参考，不是实测精度，也不保证设备在圈内"
            : "点击基站地点显示范围；GPS不套用基站半径"
        }}
      </span>
      <el-button v-if="activeId" link @click="activeId = ''">清除选择</el-button>
    </div>
    <div v-if="addressErrorCount" class="address-notice" role="status">
      <span>{{ addressErrorCount }} 处地址获取失败：{{ firstAddressError }}；坐标仍可查看。</span>
      <el-button link type="primary" @click="retryAddresses">重试地址</el-button>
    </div>
    <div class="map-body">
      <TiandituMap
        compact
        :points="points"
        :active-id="activeId"
        :focus-token="focusToken"
        @select="activeId = $event"
      />
      <ul v-if="rows.length" class="place-list">
        <li
          v-for="row in rows"
          :key="row.id"
          :class="{ on: row.id === activeId }"
          tabindex="0"
          role="button"
          @keydown.enter="focus(row.id)"
          @keydown.space.prevent="focus(row.id)"
          @click="focus(row.id)"
        >
          <i class="dot" :class="row.status"></i>
          <div>
            <b>
              {{ row.title }}
              <em v-if="row.emphasis" :class="{ historical }">
                {{ historical ? "最后上报" : "当前" }}
              </em>
            </b>
            <span class="where">
              {{
                row.address ||
                (addressErrors[row.id]
                  ? "地址获取失败，可重试"
                  : row.address === ""
                    ? "此坐标暂无地址"
                    : "正在获取位置…")
              }}
            </span>
            <span>{{ row.when }}</span>
          </div>
        </li>
      </ul>
      <div v-else class="place-empty">所选来源没有位置</div>
    </div>
  </el-card>
</template>

<script setup lang="ts">
import SampleBoxAPI, { type PlaceHit } from "@/api/sample/box";
import TiandituMap, { type TiandituPoint } from "@/components/TiandituMap/index.vue";
import { resolveChineseAddress } from "@/utils/tianditu";

interface Bucket {
  lng: number;
  lat: number;
  lbs: number;
  gps: number;
  latest: string;
}

const props = defineProps<{
  boxId: string;
  lbsLng?: number | null;
  lbsLat?: number | null;
  gpsLng?: number | null;
  gpsLat?: number | null;
  historical?: boolean;
}>();

const showRange = ref(true);
const referenceRadius = useStorage("sample-lbs-reference-radius", 500);
const layers = ref<Array<"lbs" | "gps">>(["lbs", "gps"]);
const hits = ref<{ lbs: PlaceHit[]; gps: PlaceHit[] }>({ lbs: [], gps: [] });
const activeId = ref("");
const focusToken = ref(0);
const addresses = ref<Record<string, string>>({});
const addressPending = new Set<string>();
const addressErrors = ref<Record<string, string>>({});
const addressRetriedAt = new Map<string, number>();
const addressErrorCount = computed(
  () => rows.value.filter((row) => addressErrors.value[row.id]).length
);
const firstAddressError = computed(
  () => rows.value.map((row) => addressErrors.value[row.id]).find(Boolean) || "请稍后重试"
);

function keyOf(lng: number, lat: number) {
  return `${lng.toFixed(5)},${lat.toFixed(5)}`;
}

function metersApart(leftLng: number, leftLat: number, rightLng: number, rightLat: number) {
  const x = (leftLng - rightLng) * 111320 * Math.cos((leftLat * Math.PI) / 180);
  const y = (leftLat - rightLat) * 110540;
  return Math.hypot(x, y);
}

function fallback(lng?: number | null, lat?: number | null): PlaceHit[] {
  if (lng == null || lat == null) return [];
  return [{ lng, lat, count: 1, latest: "" }];
}

const buckets = computed(() => {
  const grouped: Bucket[] = [];
  const take = (kind: "lbs" | "gps", source: PlaceHit[]) => {
    if (!layers.value.includes(kind)) return;
    for (const row of source) {
      const found = grouped.find((item) => metersApart(item.lng, item.lat, row.lng, row.lat) <= 40);
      if (!found) {
        grouped.push({
          lng: row.lng,
          lat: row.lat,
          lbs: kind === "lbs" ? row.count : 0,
          gps: kind === "gps" ? row.count : 0,
          latest: row.latest,
        });
        continue;
      }
      found[kind] += row.count;
      if (row.latest > found.latest) found.latest = row.latest;
    }
  };
  take("lbs", hits.value.lbs.length ? hits.value.lbs : fallback(props.lbsLng, props.lbsLat));
  take("gps", hits.value.gps.length ? hits.value.gps : fallback(props.gpsLng, props.gpsLat));
  return grouped.sort((left, right) => (left.latest < right.latest ? 1 : -1));
});

const newestId = computed(() =>
  buckets.value[0] ? keyOf(buckets.value[0].lng, buckets.value[0].lat) : ""
);

function titleOf(item: Bucket) {
  const names = [];
  if (item.lbs) names.push(item.lbs > 1 ? `基站 ${item.lbs} 次` : "基站");
  if (item.gps) names.push(item.gps > 1 ? `GPS ${item.gps} 次` : "GPS");
  return names.join(" · ");
}

function statusOf(item: Bucket) {
  return item.lbs && item.gps ? "both" : item.gps ? "gps" : "lbs";
}

const points = computed<TiandituPoint[]>(() =>
  buckets.value.map((item) => {
    const id = keyOf(item.lng, item.lat);
    const lines = [`${item.lng.toFixed(6)}, ${item.lat.toFixed(6)}`];
    if (item.latest) lines.push(`最近 ${item.latest}`);
    const known = Object.prototype.hasOwnProperty.call(addresses.value, id);
    return {
      id,
      lng: item.lng,
      lat: item.lat,
      title: titleOf(item),
      status: statusOf(item),
      referenceRadius:
        showRange.value && item.lbs
          ? [100, 300, 500, 1000, 3000].includes(referenceRadius.value)
            ? referenceRadius.value
            : 500
          : undefined,
      emphasis: id === newestId.value,
      address: known ? addresses.value[id] : undefined,
      lines,
    };
  })
);

const rows = computed(() =>
  points.value.map((point) => ({
    id: point.id,
    title: point.title,
    status: point.status,
    emphasis: point.emphasis,
    address: point.address,
    when:
      point.lines
        .find((line) => line.startsWith("最近 "))
        ?.replace("最近 ", "")
        .slice(5, 16) || "还没有时间",
  }))
);

function resolveAddresses(list: Bucket[], retry = false) {
  for (const item of list) {
    const id = keyOf(item.lng, item.lat);
    if (addressPending.has(id) || Object.prototype.hasOwnProperty.call(addresses.value, id))
      continue;
    if (!retry && Date.now() - (addressRetriedAt.get(id) || 0) < 60000) continue;
    addressRetriedAt.set(id, Date.now());
    addressPending.add(id);
    delete addressErrors.value[id];
    void resolveChineseAddress(item.lng, item.lat)
      .then((result) => {
        if (result.status === "error") {
          addressErrors.value[id] = result.message || "地址解析失败";
        } else {
          addresses.value = { ...addresses.value, [id]: result.address };
        }
      })
      .catch(() => {
        addressErrors.value[id] = "地址解析失败，请重试";
      })
      .finally(() => addressPending.delete(id));
  }
}
function retryAddresses() {
  resolveAddresses(buckets.value, true);
}
watch(buckets, (list) => resolveAddresses(list), { immediate: true });

watch([showRange, referenceRadius], () => {
  if (activeId.value) focusToken.value += 1;
});
watch(points, (list) => {
  if (!list.some((p) => p.id === activeId.value)) activeId.value = "";
});

function focus(id: string) {
  activeId.value = id;
  focusToken.value += 1;
}

async function load() {
  const id = props.boxId;
  if (!id) return;
  try {
    const page = await SampleBoxAPI.places(id);
    if (id !== props.boxId) return;
    hits.value = {
      lbs: Array.isArray(page.lbs) ? page.lbs : [],
      gps: Array.isArray(page.gps) ? page.gps : [],
    };
  } catch {
    hits.value = { lbs: [], gps: [] };
  }
}

watch(
  () =>
    `${props.boxId}|${props.lbsLng ?? ""}|${props.lbsLat ?? ""}|${props.gpsLng ?? ""}|${props.gpsLat ?? ""}`,
  () => {
    void load();
  },
  { immediate: true }
);

let timer = 0;
onMounted(() => {
  timer = window.setInterval(() => {
    void load();
  }, 30000);
});
onUnmounted(() => {
  window.clearInterval(timer);
});
</script>

<style scoped>
.address-notice {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
  padding: 8px 16px;
  font-size: 12px;
  color: var(--el-color-warning-dark-2);
  background: var(--el-color-warning-light-9);
}
.range-tools {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: center;
  padding: 10px 16px;
  border-bottom: 1px solid var(--el-border-color-lighter);
}
.range-tools span {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.map-card {
  flex-shrink: 0;
  margin-top: 12px;
}
.map-card :deep(.el-card__body) {
  min-height: 460px;
  padding: 0;
}
.map-head,
.map-title,
.map-tools {
  display: flex;
  gap: 12px;
  align-items: center;
}
.map-head {
  flex-wrap: wrap;
  justify-content: space-between;
}
.map-tools {
  flex-wrap: wrap;
}
.map-title small,
.legend {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.map-body {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 260px;
  height: 430px;
}
.place-list,
.place-empty {
  min-height: 0;
  margin: 0;
  overflow: auto;
  border-left: 1px solid var(--el-border-color-lighter);
}
.place-list {
  padding: 0;
  list-style: none;
}
.place-list li {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  padding: 10px 12px;
  cursor: pointer;
  border-bottom: 1px solid var(--el-border-color-lighter);
}
.place-list li.on {
  background: var(--el-color-primary-light-9);
}
.place-list b {
  display: block;
  font-weight: 500;
}
.place-list em {
  margin-left: 6px;
  font-size: 12px;
  font-style: normal;
  color: var(--el-color-primary);
}
.place-list span {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.place-list em.historical {
  color: var(--el-text-color-secondary);
}
.place-list .where {
  display: block;
  margin: 2px 0;
  line-height: 1.4;
  color: var(--el-text-color-regular);
}
.place-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  color: var(--el-text-color-secondary);
}
.dot {
  display: inline-block;
  flex-shrink: 0;
  width: 8px;
  height: 8px;
  margin-top: 6px;
  background: #0f766e;
  border-radius: 50%;
}
.legend .dot {
  margin: 0 4px 0 0;
  vertical-align: middle;
}
.dot.gps {
  background: #1d4ed8;
}
.dot.both {
  background: #6d28d9;
}
@media (max-width: 900px) {
  .map-body {
    grid-template-rows: 1fr 180px;
    grid-template-columns: 1fr;
  }
  .place-list,
  .place-empty {
    border-top: 1px solid var(--el-border-color-lighter);
    border-left: 0;
  }
}
</style>
