<template>
  <el-drawer
    :model-value="modelValue"
    :title="title"
    size="420px"
    :modal="false"
    @update:model-value="(v: boolean) => emit('update:modelValue', v)"
  >
    <template v-if="box">
      <div class="tags">
        <el-tag :type="lifeTone(box.life)">{{ lifeLabel(box.life) }}</el-tag>
        <el-tag :type="online ? 'success' : 'info'" effect="plain">
          {{ online ? "在线" : "离线" }}
        </el-tag>
        <el-tag v-if="box.alert" type="danger">{{ box.alert }}</el-tag>
      </div>
      <p class="text-muted">{{ subtitle }}</p>

      <div class="facts">
        <div v-for="fact in facts" :key="fact.label">
          <span>{{ fact.label }}</span>
          <b :class="{ warn: fact.warn }">{{ fact.value }}</b>
        </div>
      </div>

      <section class="block">
        <h4>位置</h4>
        <LocationLine :box="box" :period-sec="box.reportPeriodSec" empty-text="还没有定位" />
      </section>

      <section class="block">
        <h4>当前任务</h4>
        <div v-if="current" class="task" @click="openTask(current.id)">
          <div class="line">
            <b>{{ current.name }}</b>
            <el-tag size="small" :type="taskTone(current.status)">{{ current.status }}</el-tag>
          </div>
          <div class="text-muted">{{ routeOf(current) }}</div>
        </div>
        <p v-else class="text-muted">没有进行中的任务</p>
      </section>

      <section class="block">
        <h4>最近任务</h4>
        <ul v-if="tasks.length" class="list">
          <li v-for="task in tasks" :key="task.id" @click="openTask(task.id)">
            <span class="grow">{{ task.name }}</span>
            <el-tag size="small" :type="taskTone(task.status)">{{ task.status }}</el-tag>
          </li>
        </ul>
        <p v-else class="text-muted">还没参与过任务</p>
      </section>

      <section class="block">
        <h4>最近事件</h4>
        <ul v-if="events.length" class="list">
          <li v-for="event in events" :key="event.id || event.time">
            <el-tag size="small" :type="kindTone(event.kind)">{{ kindLabel(event.kind) }}</el-tag>
            <span class="grow"><TimeText :value="event.time" mode="short" /></span>
          </li>
        </ul>
        <p v-else class="text-muted">最近 7 天没有开关箱、上电</p>
      </section>

      <div class="ops">
        <el-button type="primary" @click="go('')">打开详情</el-button>
        <el-button v-if="canTrack" @click="go('track')">看轨迹</el-button>
        <el-button v-if="canCreate" @click="createTask">创建任务单</el-button>
      </div>
    </template>
  </el-drawer>
</template>

<script setup lang="ts">
import SampleBoxAPI, { type BoxLogItem } from "@/api/sample/box";
import PolicyAPI, { type PolicyTask } from "@/api/sample/report-policy";
import LocationLine from "@/components/biz/LocationLine.vue";
import TimeText from "@/components/biz/TimeText.vue";
import { usePerm } from "@/composables/usePerm";
import { kindLabel, lidLabel, lifeLabel } from "@/utils/labels";
import { ago, clock, lastDays } from "@/utils/time";
import { kindTone, lifeTone, taskTone } from "@/utils/tone";
import { telemetryState } from "../boxes/telemetry";
import { BOX_PERM, EVENT_PERMS, TASK_CREATE, type SampleBox } from "../data";

/** 实时地图点一台箱子，右侧抽屉看它的状态、位置、当前和最近的任务、最近事件。 */
const props = defineProps<{ modelValue: boolean; box: SampleBox | null }>();
const emit = defineEmits<{ "update:modelValue": [open: boolean] }>();
const router = useRouter();
const can = usePerm();
const tasks = ref<PolicyTask[]>([]);
const events = ref<BoxLogItem[]>([]);
const title = computed(() => props.box?.name || props.box?.id || "采样箱");
const online = computed(() =>
  props.box ? telemetryState(props.box.last, props.box.reportPeriodSec, clock.value).online : false
);
const current = computed(
  () =>
    tasks.value.find(
      (t) => !["已完成", "已签收", "已拒收", "已取消", "已检测", "已退回"].includes(t.status)
    ) || null
);
const canCreate = computed(
  () => props.box?.life === "未使用" && TASK_CREATE.some((perm) => can(perm))
);
/** 详情「轨迹」标签：历史轨迹，或者能看任务和当前位置（按任务看）。 */
const canTrack = computed(
  () =>
    can(BOX_PERM.detail) && (can(BOX_PERM.track) || (can(BOX_PERM.task) && can(BOX_PERM.location)))
);
const subtitle = computed(() => {
  const b = props.box;
  if (!b) return "";
  const keeper = b.owner && b.owner !== "—" ? `${b.owner} 保管` : "无保管人";
  return `IMEI ${b.id} · ${b.org || "总公司"} · ${keeper}`;
});
const facts = computed(() => {
  const b = props.box;
  if (!b) return [];
  const battery = b.batteryUsable != null ? `${b.batteryUsable}%` : b.battery || "—";
  const signal =
    b.csq == null || b.csq === 99 || b.csq <= 0
      ? "无信号"
      : b.csq >= 20
        ? "强"
        : b.csq >= 10
          ? "中"
          : "弱";
  return [
    { label: "电量", value: battery, warn: b.batteryUsable != null && b.batteryUsable < 20 },
    { label: "箱盖", value: lidLabel(b.lid), warn: b.lid === 1 },
    { label: "信号", value: signal, warn: false },
    { label: "最近上报", value: b.last ? ago(b.last) : "从未上报", warn: !online.value },
  ];
});

function routeOf(task: PolicyTask) {
  return task.kind === "调拨"
    ? `调拨 · ${task.fromOrg || "—"} → ${task.toOrg || "—"}`
    : `采样 · ${task.org || task.place || "—"}`;
}
function openTask(id: string) {
  void router.push(`/task/detail/${id}`);
}
function go(tab: string) {
  if (!props.box) return;
  void router.push({ path: `/device/boxes/${props.box.id}`, query: tab ? { tab } : {} });
}
function createTask() {
  if (props.box) void router.push({ path: "/task/create", query: { boxIds: props.box.id } });
}

async function load() {
  const b = props.box;
  if (!b || !props.modelValue) return;
  tasks.value = [];
  events.value = [];
  if (can(BOX_PERM.task)) {
    try {
      tasks.value = (await PolicyAPI.tasks({ boxId: b.id, pageSize: 5 })).list;
    } catch {
      tasks.value = [];
    }
  }
  if (EVENT_PERMS.some((perm) => can(perm))) {
    try {
      events.value = (
        await SampleBoxAPI.logs(b.id, { ...lastDays(7), kind: "boot,pad,shut,chg", limit: 5 })
      ).list;
    } catch {
      events.value = [];
    }
  }
}
watch(() => [props.box?.id, props.modelValue], load, { immediate: true });
</script>

<style scoped>
.tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.facts {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  margin: 12px 0;
}
.facts div {
  display: flex;
  flex-direction: column;
  padding: 8px 10px;
  background: var(--el-fill-color-lighter);
  border-radius: 6px;
}
.facts span {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.facts b {
  font-size: 16px;
}
.facts b.warn {
  color: var(--el-color-danger);
}
.block {
  margin-top: 14px;
}
.block h4 {
  margin: 0 0 6px;
  font-size: 14px;
}
.block p {
  margin: 0;
  font-size: 13px;
  line-height: 1.6;
}
.task {
  padding: 8px;
  cursor: pointer;
  background: var(--el-fill-color-lighter);
  border-radius: 6px;
}
.line {
  display: flex;
  gap: 8px;
  align-items: center;
  justify-content: space-between;
}
.list {
  padding: 0;
  margin: 0;
  list-style: none;
}
.list li {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 6px 4px;
  font-size: 13px;
  cursor: pointer;
  border-bottom: 1px solid var(--el-border-color-extra-light);
}
.grow {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ops {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 18px;
}
</style>
