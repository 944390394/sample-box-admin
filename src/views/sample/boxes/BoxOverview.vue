<template>
  <div class="overview">
    <div class="grid" :class="{ 'no-map': !canLocation }">
      <SectionCard
        v-if="canLocation"
        class="loc-card"
        title="当前位置"
        flush
        data-test="location-card"
      >
        <template #extra>
          <span class="legend">
            <i class="dot is-now" />
            现在
            <template v-if="pos.gpsStale">
              <i class="dot is-old" />
              最后一次 GPS
            </template>
          </span>
        </template>
        <div class="loc-head">
          <LocationLine :box="box" :period-sec="box.reportPeriodSec" />
          <el-button v-if="pos.current" link type="primary" @click="copyCoords">复制坐标</el-button>
        </div>
        <div v-if="points.length" class="map">
          <TiandituMap :points="points" :circles="circles" />
        </div>
        <el-empty v-else :image-size="56" description="还没有定位" />
      </SectionCard>

      <div class="side">
        <SectionCard v-if="canTask" title="当前任务">
          <template #extra>
            <el-button link type="primary" @click="emit('tab', 'task')">全部任务</el-button>
          </template>
          <button
            v-if="activeTask"
            type="button"
            class="task"
            @click="router.push(`/task/detail/${activeTask.id}`)"
          >
            <span class="task-line">
              <b>{{ activeTask.name }}</b>
              <el-tag size="small" :type="taskTone(activeTask.status)">
                {{ activeTask.status }}
              </el-tag>
            </span>
            <span class="text-muted">
              {{ activeTask.kind }} ·
              {{
                activeTask.kind === "调拨"
                  ? `${activeTask.fromOrg} → ${activeTask.toOrg}`
                  : activeTask.org || activeTask.place || "—"
              }}
            </span>
          </button>
          <div v-else class="empty-line">没有进行中的任务</div>
        </SectionCard>

        <SectionCard v-if="canEvent" title="最近事件" sub="30 天内">
          <template #extra>
            <el-button link type="primary" @click="emit('tab', 'event')">全部事件</el-button>
          </template>
          <ul v-if="events.length" class="events">
            <li v-for="item in events" :key="item.id || item.time">
              <el-tag size="small" :type="kindTone(item.kind)">{{ kindLabel(item.kind) }}</el-tag>
              <span class="ev-time">
                <TimeText :value="item.deviceTime || item.time" mode="full" />
              </span>
              <span class="text-muted">{{ ageText(item.deviceTime || item.time) }}</span>
            </li>
          </ul>
          <div v-else class="empty-line">最近 30 天没有开关箱、上电、充电记录</div>
        </SectionCard>
      </div>
    </div>

    <BatteryCurve v-if="canBattery" :box-id="box.id" :last-report="box.last" />
  </div>
</template>

<script setup lang="ts">
import SampleBoxAPI, { type BoxLogItem } from "@/api/sample/box";
import PolicyAPI, { type PolicyTask } from "@/api/sample/report-policy";
import LocationLine from "@/components/biz/LocationLine.vue";
import SectionCard from "@/components/biz/SectionCard.vue";
import TimeText from "@/components/biz/TimeText.vue";
import TiandituMap, {
  type TiandituCircle,
  type TiandituPoint,
} from "@/components/TiandituMap/index.vue";
import { usePerm } from "@/composables/usePerm";
import { kindLabel } from "@/utils/labels";
import { ageText, boxPositions, coordText } from "@/utils/position";
import { lastDays, shortTime } from "@/utils/time";
import { kindTone, taskTone } from "@/utils/tone";
import BatteryCurve from "./BatteryCurve.vue";
import { stepsOf } from "../tasks/status";
import { BOX_PERM, EVENT_PERMS, type SampleBox } from "../data";

/**
 * 采样箱详情 · 概览：它现在在哪、在干什么。
 * 位置卡写清来源和多久前；GPS 过时、当前用基站时，地图上把最后一次 GPS 用灰色标出来。
 * 电量、箱盖、信号这些在页头状态条里，这里不重复。
 */
const props = defineProps<{ box: SampleBox }>();
const emit = defineEmits<{ tab: [name: string] }>();
const router = useRouter();
const can = usePerm();
const canLocation = computed(() => can(BOX_PERM.location));
const canTask = computed(() => can(BOX_PERM.task));
const canEvent = computed(() => EVENT_PERMS.some((perm) => can(perm)));
const canBattery = computed(() => can(BOX_PERM.battery));

const pos = computed(() => boxPositions(props.box));
const points = computed<TiandituPoint[]>(() => {
  const { current, gps, gpsStale } = pos.value;
  if (!current) return [];
  const list: TiandituPoint[] = [];
  if (gpsStale && gps) {
    list.push({
      id: `${props.box.id}-gps`,
      lng: gps.lng,
      lat: gps.lat,
      title: "最后一次 GPS",
      address: gps.address || undefined,
      lines: [`${ageText(gps.at)}（${shortTime(gps.at)}）`, "之后没定到卫星"],
      marker: { glyph: "旧", color: "#86909c", shape: "badge" },
    });
  }
  list.push({
    id: props.box.id,
    lng: current.lng,
    lat: current.lat,
    title: props.box.name || props.box.id,
    status: current.source === "GPS" ? "gps" : undefined,
    emphasis: true,
    address: current.address || undefined,
    lines: [
      `${current.source}${current.at ? ` · ${ageText(current.at)}` : ""}`,
      current.source === "基站" ? "基站定位误差可能有一两公里" : "",
    ].filter(Boolean),
    referenceRadius: current.source === "基站" ? 1000 : undefined,
  });
  return list;
});
const circles = computed<TiandituCircle[]>(() => []);

async function copyCoords() {
  const c = pos.value.current;
  if (!c) return;
  try {
    await navigator.clipboard.writeText(coordText(c.lng, c.lat));
    ElMessage.success("已复制坐标");
  } catch {
    ElMessage.warning("复制失败，请手动选择");
  }
}

const activeTask = ref<PolicyTask | null>(null);
const events = ref<BoxLogItem[]>([]);
async function load() {
  if (canTask.value) {
    try {
      // 同一台箱子可能还挂着没开始的单（比如待寄出），优先显示已经开始、正占用箱子的那张
      const page = await PolicyAPI.tasks({ boxId: props.box.id, status: "进行中", pageSize: 10 });
      activeTask.value =
        page.list.find((task) => stepsOf(task).indexOf(task.status) > 0) || page.list[0] || null;
    } catch {
      activeTask.value = null;
    }
  }
  if (canEvent.value) {
    try {
      const page = await SampleBoxAPI.logs(props.box.id, {
        ...lastDays(30),
        kind: "boot,pad,shut,chg",
        limit: 5,
      });
      events.value = page.list;
    } catch {
      events.value = [];
    }
  }
}
onMounted(load);
watch(() => props.box.last, load);
</script>

<style scoped>
.overview {
  display: flex;
  flex-direction: column;
  gap: var(--page-gap);
}
.grid {
  display: grid;
  grid-template-columns: minmax(0, 2fr) minmax(280px, 1fr);
  gap: var(--page-gap);
}
.grid.no-map {
  grid-template-columns: minmax(0, 1fr);
}
.side {
  display: flex;
  flex-direction: column;
  gap: var(--page-gap);
  min-width: 0;
}
.loc-head {
  display: flex;
  gap: 12px;
  align-items: flex-start;
  justify-content: space-between;
  padding: 12px 16px;
  font-size: 13px;
}
.map {
  height: 340px;
  border-top: 1px solid var(--card-divider);
}
.legend {
  display: inline-flex;
  gap: 6px;
  align-items: center;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.dot {
  width: 8px;
  height: 8px;
  margin-left: 6px;
  border-radius: 50%;
}
.dot.is-now {
  background: var(--loc-gps);
}
.dot.is-old {
  background: var(--status-stale);
}
.task {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 100%;
  padding: 10px 12px;
  margin: -4px 0;
  font: inherit;
  text-align: left;
  cursor: pointer;
  background: var(--el-fill-color-lighter);
  border: 1px solid transparent;
  border-radius: 8px;
}
.task:hover {
  border-color: var(--el-color-primary-light-5);
}
.task-line {
  display: flex;
  gap: 8px;
  align-items: center;
}
.empty-line {
  font-size: 13px;
  color: var(--el-text-color-placeholder);
}
.events {
  padding: 0;
  margin: -6px 0;
  list-style: none;
}
.events li {
  display: flex;
  gap: 10px;
  align-items: center;
  padding: 7px 0;
  font-size: 13px;
  border-bottom: 1px solid var(--card-divider);
}
.events li:last-child {
  border-bottom: 0;
}
.ev-time {
  flex: 1;
}
@media (max-width: 1100px) {
  .grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
@media (max-width: 640px) {
  .map {
    height: 260px;
  }
  .loc-head {
    flex-direction: column;
    gap: 4px;
  }
}
</style>
