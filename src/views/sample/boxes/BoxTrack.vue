<template>
  <div v-loading="loading">
    <div class="filter-bar head">
      <el-radio-group v-model="mode" size="small" @change="onMode">
        <template v-if="canHistory">
          <el-radio-button value="1">24 小时</el-radio-button>
          <el-radio-button value="7">7 天</el-radio-button>
          <el-radio-button value="30">30 天</el-radio-button>
        </template>
        <el-radio-button v-if="canTask" value="task">按任务</el-radio-button>
      </el-radio-group>
      <template v-if="mode === 'task' && tasks.length">
        <el-select
          v-model="taskId"
          size="small"
          filterable
          placeholder="选择任务"
          class="task-select"
          @change="load"
        >
          <el-option v-for="t in tasks" :key="t.id" :label="t.name" :value="t.id">
            <span>{{ t.name }}</span>
            <span class="opt-meta">{{ t.status }} · {{ t.createdAt.slice(0, 10) }}</span>
          </el-option>
        </el-select>
        <router-link :to="`/task/detail/${taskId}`" class="open-task">打开任务单</router-link>
      </template>
      <span v-if="track && !empty" class="text-muted">
        <template v-if="mode === 'task' && windowText">{{ windowText }} ·</template>
        {{ track.gpsCount }} 个 GPS 点
        <template v-if="track.gpsCount">· 行程 {{ formatDistance(track.distanceM) }}</template>
        · {{ track.lbsCount }} 个基站点
        <template v-if="showEvents">· 开箱 {{ opens }} 次</template>
      </span>
      <span v-if="truncated" class="text-muted warn">点太多，只取了前两万条</span>
    </div>
    <el-empty v-if="empty" description="这台箱子还没参与过任务，或者任务都不在你的范围内" />
    <TrackMap
      v-else
      :tracks="tracks"
      :colors="{ [box.id]: '#2563eb' }"
      :names="{ [box.id]: box.name }"
      :points="points"
      :circles="circles"
      height="480px"
    >
      <template #legend>
        <span v-if="showEvents">
          <i style="background: #0f766e" />
          开箱位置
        </span>
        <template v-if="mode === 'task'">
          <span v-for="p in placeLegend" :key="p.role">
            <i :style="{ background: p.color }" />
            {{ p.role }}（圈内算到达）
          </span>
        </template>
      </template>
    </TrackMap>
  </div>
</template>

<script setup lang="ts">
import SampleBoxAPI, { type BoxEvent, type BoxTrack } from "@/api/sample/box";
import PolicyAPI, {
  formatDistance,
  type PolicyTask,
  type TaskTrackResult,
} from "@/api/sample/report-policy";
import TrackMap from "@/components/biz/TrackMap.vue";
import type { TiandituCircle, TiandituPoint } from "@/components/TiandituMap/index.vue";
import { usePerm } from "@/composables/usePerm";
import { lastDays } from "@/utils/time";
import { BOX_PERM, type SampleBox } from "../data";

/**
 * 采样箱详情 · 轨迹，两种看法：
 * - 按时间：最近 24 小时 / 7 天 / 30 天的全部行程，要「历史轨迹」权限；
 * - 按任务：选这台箱子参与过的一个任务，只看任务期间（创建到结束）的轨迹，标出寄出、收货或计划地点和到达范围。
 *   要能看任务（关联任务）和「当前位置」，不需要「历史轨迹」——任务相关的人只看得到任务里的行程。
 * 开箱位置要「事件」权限，没有时不显示开箱次数。
 */
const props = defineProps<{ box: SampleBox }>();
const can = usePerm();
const canHistory = computed(() => can(BOX_PERM.track));
const canTask = computed(() => can(BOX_PERM.task) && can(BOX_PERM.location));

const PLACE_COLORS: Record<string, { color: string; glyph: string }> = {
  寄出地址: { color: "#16a34a", glyph: "寄" },
  收货地址: { color: "#dc2626", glyph: "收" },
  计划地点: { color: "#7c3aed", glyph: "采" },
};
const ENDED = ["已完成", "已签收", "已拒收", "已取消", "已检测", "已退回"];

const mode = ref<string>(canHistory.value ? "1" : "task");
const loading = ref(false);
const tracks = ref<BoxTrack[]>([]);
const events = ref<BoxEvent[]>([]);
const truncated = ref(false);
const showEvents = ref(true);
const tasks = ref<PolicyTask[]>([]);
const tasksLoaded = ref(false);
const taskId = ref("");
const taskResult = ref<TaskTrackResult | null>(null);

const track = computed(() => tracks.value[0] || null);
const opens = computed(() => events.value.filter((e) => e.kind === "pad").length);
const empty = computed(() => mode.value === "task" && tasksLoaded.value && !tasks.value.length);
const places = computed(() => (mode.value === "task" ? taskResult.value?.places || [] : []));
const placeLegend = computed(() =>
  places.value.map((p) => ({ role: p.role, color: PLACE_COLORS[p.role]?.color || "#64748b" }))
);
const windowText = computed(() => {
  const r = taskResult.value;
  if (!r) return "";
  const live = !ENDED.includes(r.task.status);
  return `${r.window.from.slice(5, 16)} 至 ${live ? "现在" : r.window.to.slice(5, 16)}`;
});

/** 开箱事件标在最近的一个定位上（GPS 优先）；按任务看时再加上任务地点。 */
const points = computed<TiandituPoint[]>(() => {
  const list: TiandituPoint[] = places.value.map((p, i) => {
    const look = PLACE_COLORS[p.role] || { color: "#64748b", glyph: "点" };
    return {
      id: `place-${i}`,
      lng: p.lng,
      lat: p.lat,
      title: p.role,
      lines: [`${formatDistance(p.radiusM)}内算到达`],
      marker: { glyph: look.glyph, color: look.color, shape: "pin" as const },
    };
  });
  const t = track.value;
  if (!t || !showEvents.value) return list;
  const all = [...t.gps, ...t.lbs].sort((a, b) => (a.t < b.t ? -1 : 1));
  events.value
    .filter((e) => e.kind === "pad")
    .forEach((e, i) => {
      const near = all.filter((p) => p.t <= e.time).at(-1) || all[0];
      if (near)
        list.push({
          id: `open-${i}`,
          lng: near.lng,
          lat: near.lat,
          title: `开箱 ${e.time.slice(5, 16)}`,
          lines: [e.text],
          marker: { glyph: "开", color: "#0f766e", shape: "badge" as const },
        });
    });
  return list;
});
const circles = computed<TiandituCircle[]>(() =>
  places.value.map((p) => ({
    lng: p.lng,
    lat: p.lat,
    radiusM: p.radiusM,
    color: PLACE_COLORS[p.role]?.color || "#64748b",
  }))
);

/** 这台箱子参与过的任务，新的在前；默认选还没结束的那个，没有就选最近的。 */
async function loadTasks() {
  if (tasksLoaded.value) return;
  const result = await PolicyAPI.tasks({ boxId: props.box.id, pageSize: 100 });
  tasks.value = result.list;
  tasksLoaded.value = true;
  taskId.value = (result.list.find((t) => !ENDED.includes(t.status)) || result.list[0])?.id || "";
}

async function load() {
  loading.value = true;
  try {
    if (mode.value === "task") {
      await loadTasks();
      if (!taskId.value) {
        tracks.value = [];
        events.value = [];
        taskResult.value = null;
        return;
      }
      const result = await PolicyAPI.taskTrack(taskId.value, props.box.id);
      taskResult.value = result;
      tracks.value = result.tracks;
      events.value = result.events;
      truncated.value = Boolean(result.truncated);
      showEvents.value = true;
    } else {
      const result = await SampleBoxAPI.track(props.box.id, lastDays(Number(mode.value)));
      taskResult.value = null;
      tracks.value = result.tracks;
      events.value = result.events;
      truncated.value = Boolean(result.truncated);
      showEvents.value = result.allow ? result.allow.events : true;
    }
  } finally {
    loading.value = false;
  }
}
function onMode() {
  load();
}
onMounted(load);
</script>

<style scoped>
.head {
  margin-bottom: 10px;
}
.task-select {
  width: 280px;
  max-width: 100%;
}
.opt-meta {
  float: right;
  margin-left: 12px;
  font-size: 12px;
  color: var(--el-text-color-placeholder);
}
.open-task {
  font-size: 13px;
  color: var(--el-color-primary);
  text-decoration: none;
}
.warn {
  color: var(--el-color-warning-dark-2);
}
</style>
