<template>
  <div class="page-container page-flow">
    <PageHeader
      :title="data?.unit.name || '单位总览'"
      :subtitle="subtitle"
      back="/monitor/overview"
    >
      <template #actions>
        <el-button :icon="Refresh" :loading="loading" @click="load">刷新</el-button>
        <el-button :icon="Box" @click="router.push({ path: '/device/boxes', query: { orgId } })">
          本单位的箱子
        </el-button>
      </template>
    </PageHeader>

    <el-skeleton v-if="!data && loading" :rows="6" animated />
    <template v-else-if="data">
      <StatTiles :items="tiles" :max="7" data-test="unit-tiles" @update:model-value="openTile" />

      <!-- 检测站：在途来站、已到待检测、这一天已开箱检测 -->
      <template v-if="data.station">
        <StatTiles :items="stationTiles" :max="3" data-test="station-tiles" />
        <div class="grid">
          <SectionCard
            title="已到 · 未开箱检测"
            :sub="`${data.station.waiting.length} 台`"
            flush
            data-test="station-waiting"
          >
            <el-table
              v-if="data.station.waiting.length"
              :data="data.station.waiting"
              size="small"
              max-height="360"
              @row-click="(row: WaitingBox) => router.push(`/task/detail/${row.taskId}`)"
            >
              <el-table-column label="采样箱" min-width="110">
                <template #default="{ row }">
                  <b>{{ row.boxName }}</b>
                </template>
              </el-table-column>
              <el-table-column label="任务 · 来自" min-width="150">
                <template #default="{ row }">
                  <div>{{ row.taskName }}</div>
                  <div class="text-muted small">{{ row.from || "—" }}</div>
                </template>
              </el-table-column>
              <el-table-column label="本次开箱" width="100">
                <template #default="{ row }">
                  <span v-if="row.opensDuring == null" class="text-muted">—</span>
                  <span v-else :class="{ danger: overLimit(row as WaitingBox) }">
                    {{ row.opensDuring }} 次
                  </span>
                  <el-tag
                    v-if="overLimit(row as WaitingBox)"
                    type="danger"
                    size="small"
                    class="tag"
                  >
                    超限
                  </el-tag>
                </template>
              </el-table-column>
              <el-table-column label="签收" width="96">
                <template #default="{ row }"><TimeText :value="row.signedAt" /></template>
              </el-table-column>
            </el-table>
            <el-empty v-else :image-size="48" description="没有等着检测的箱子" />
            <p class="text-muted hint">
              开箱检测时用小程序扫箱码点「开始检测」，或在任务详情的箱子列表里点。开始检测后这台箱子的本次任务结束。
            </p>
          </SectionCard>

          <SectionCard
            :title="`${dayText}开箱检测`"
            :sub="`${data.station.done.length} 台`"
            flush
            data-test="station-done"
          >
            <el-table
              v-if="data.station.done.length"
              :data="data.station.done"
              size="small"
              max-height="360"
              @row-click="(row: DoneBox) => router.push(`/task/detail/${row.taskId}`)"
            >
              <el-table-column label="采样箱" min-width="110">
                <template #default="{ row }">
                  <b>{{ row.boxName }}</b>
                </template>
              </el-table-column>
              <el-table-column label="任务 · 来自" min-width="150">
                <template #default="{ row }">
                  <div>{{ row.taskName }}</div>
                  <div class="text-muted small">{{ row.from || "—" }}</div>
                </template>
              </el-table-column>
              <el-table-column label="本次开箱" width="86">
                <template #default="{ row }">
                  {{ row.opensDuring == null ? "—" : `${row.opensDuring} 次` }}
                </template>
              </el-table-column>
              <el-table-column label="开始检测" width="120">
                <template #default="{ row }">
                  <span :title="fullTime(row.inspectedAt)">{{ clockText(row.inspectedAt) }}</span>
                  <div class="text-muted small">{{ row.inspectedBy }}</div>
                </template>
              </el-table-column>
            </el-table>
            <el-empty v-else :image-size="48" :description="`${dayText}还没有开箱检测`" />
          </SectionCard>
        </div>
        <SectionCard
          v-if="data.station.inbound.length"
          title="正运往本站"
          :sub="`${data.station.inbound.length} 张单 · ${data.station.moving} 台箱子`"
          flush
        >
          <el-table
            :data="data.station.inbound"
            size="small"
            @row-click="(row: InboundTask) => router.push(`/task/detail/${row.id}`)"
          >
            <el-table-column label="任务" min-width="160" prop="name" />
            <el-table-column label="来自" min-width="120" prop="from" />
            <el-table-column label="状态" width="90">
              <template #default="{ row }">
                <el-tag size="small" :type="taskTone(row.status)">{{ row.status }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="箱子" width="70">
              <template #default="{ row }">{{ row.boxes }} 台</template>
            </el-table-column>
            <el-table-column label="创建" width="110">
              <template #default="{ row }"><TimeText :value="row.createdAt" /></template>
            </el-table-column>
          </el-table>
        </SectionCard>
      </template>

      <!-- 按日看任务（补充协议 1.2.8：根据日历时间筛选查看某一天的采样任务） -->
      <SectionCard
        v-if="data.tasks"
        title="按日查看任务"
        :sub="`${dayText} · ${data.tasks.length} 张单`"
        data-test="unit-day"
      >
        <div class="day-grid">
          <el-calendar v-model="calendarDate" class="mini-calendar">
            <template #date-cell="{ data: cell }">
              <div
                class="cell"
                :class="{ picked: cell.day === data.day, has: Boolean(data.calendar?.[cell.day]) }"
                :data-day="cell.day"
              >
                <span>{{ Number(cell.day.slice(8)) }}</span>
                <i v-if="data.calendar?.[cell.day]" class="dot">{{ data.calendar[cell.day] }}</i>
              </div>
            </template>
          </el-calendar>
          <div class="day-tasks">
            <el-table
              v-if="data.tasks.length"
              :data="data.tasks"
              size="small"
              max-height="420"
              @row-click="(row: DayTask) => router.push(`/task/detail/${row.id}`)"
            >
              <el-table-column label="任务" min-width="150">
                <template #default="{ row }">
                  <b>{{ row.name }}</b>
                  <div class="text-muted small mono">{{ row.id }}</div>
                </template>
              </el-table-column>
              <el-table-column label="类型" width="64" prop="kind" />
              <el-table-column label="路线" min-width="150">
                <template #default="{ row }">
                  {{
                    row.kind === "调拨"
                      ? `${row.from || "—"} → ${row.to || "—"}`
                      : `采样 · ${row.to || "—"}`
                  }}
                </template>
              </el-table-column>
              <el-table-column label="状态" width="90">
                <template #default="{ row }">
                  <el-tag size="small" :type="taskTone(row.status)">{{ row.status }}</el-tag>
                </template>
              </el-table-column>
              <el-table-column label="箱子" width="64">
                <template #default="{ row }">{{ row.boxes }} 台</template>
              </el-table-column>
              <el-table-column label="创建" width="110">
                <template #default="{ row }">
                  <span :title="fullTime(row.createdAt)">{{ shortDate(row.createdAt) }}</span>
                </template>
              </el-table-column>
            </el-table>
            <el-empty v-else :image-size="56" :description="`${dayText}没有进行中的任务`" />
          </div>
        </div>
      </SectionCard>
    </template>
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: "SampleOverviewUnit" });

import { Box, Refresh } from "@element-plus/icons-vue";
import OverviewAPI, {
  type DayTask,
  type DoneBox,
  type InboundTask,
  type UnitOverview,
  type WaitingBox,
} from "@/api/sample/overview";
import PageHeader from "@/components/biz/PageHeader.vue";
import SectionCard from "@/components/biz/SectionCard.vue";
import StatTiles, { type StatTile } from "@/components/biz/StatTiles.vue";
import TimeText from "@/components/biz/TimeText.vue";
import { lifeLabel } from "@/utils/labels";
import { fullTime, toDate } from "@/utils/time";
import { taskTone } from "@/utils/tone";

/**
 * 单位总览（补充协议 1.2.8、1.2.9）：一个分公司或检测站的箱子数量和状态，日历选一天看当天进行过的任务。
 * 检测站另有：运往本站途中、已到未开箱检测、当天已开箱检测。30 秒刷新。
 */
const route = useRoute();
const router = useRouter();
const orgId = computed(() => String(route.params.orgId || ""));
const data = ref<UnitOverview | null>(null);
const loading = ref(false);

function pad(n: number) {
  return String(n).padStart(2, "0");
}
function localDay(d: Date) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
const day = ref(
  typeof route.query.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(route.query.day)
    ? route.query.day
    : localDay(new Date())
);
const calendarDate = ref(new Date(`${day.value}T00:00:00`));

const dayText = computed(() =>
  day.value === localDay(new Date())
    ? "今天"
    : `${Number(day.value.slice(5, 7))} 月 ${Number(day.value.slice(8))} 日`
);
const subtitle = computed(() => {
  const u = data.value?.unit;
  if (!u) return "";
  const kind = u.type === "采样机构" ? "检测站（采样机构）" : u.hq ? "总部" : "分公司";
  return `${kind}${u.path !== u.name ? ` · ${u.path}` : ""} · 箱子数量、状态和每天的任务`;
});

const tiles = computed<StatTile[]>(() => {
  const s = data.value?.stats;
  if (!s) return [];
  return [
    { key: "total", label: "箱子总数", value: s.total, clickable: false },
    { key: "life:在途", label: lifeLabel("在途"), value: s.counts["在途"] ?? 0, tone: "primary" },
    { key: "life:未使用", label: "在仓库", value: s.counts["未使用"] ?? 0, tone: "success" },
    {
      key: "life:待激活",
      label: lifeLabel("待激活"),
      value: s.counts["待激活"] ?? 0,
      tone: s.counts["待激活"] ? "warning" : "default",
    },
    {
      key: "flag:offline",
      label: "离线",
      value: s.flags.offline ?? 0,
      tone: s.flags.offline ? "warning" : "default",
    },
    {
      key: "flag:low",
      label: "低电量",
      value: s.flags.low ?? 0,
      tone: s.flags.low ? "danger" : "default",
    },
    {
      key: "flag:alert",
      label: "告警",
      value: s.flags.alert ?? 0,
      tone: s.flags.alert ? "danger" : "default",
    },
  ];
});
const stationTiles = computed<StatTile[]>(() => {
  const st = data.value?.station;
  if (!st) return [];
  return [
    {
      key: "moving",
      label: "运往本站途中",
      value: st.moving,
      tone: "primary",
      clickable: false,
      hint: "已寄出、还没签收",
    },
    {
      key: "arrived",
      label: "已到 · 未开箱检测",
      value: st.arrived,
      tone: st.arrived ? "warning" : "default",
      clickable: false,
      hint: "已签收，等扫码开始检测",
    },
    {
      key: "inspected",
      label: `${dayText.value}已开箱检测`,
      value: st.inspected,
      tone: "success",
      clickable: false,
    },
  ];
});
function openTile(key: string) {
  if (key) void router.push({ path: "/device/boxes", query: { orgId: orgId.value, tile: key } });
}
function overLimit(row: WaitingBox) {
  return row.maxOpens != null && row.opensDuring != null && row.opensDuring > row.maxOpens;
}
function clockText(time: string) {
  const d = toDate(time);
  return d ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : "—";
}
function shortDate(time: string) {
  const d = toDate(time);
  return d
    ? `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
    : "—";
}

async function load() {
  if (!orgId.value) return;
  loading.value = true;
  try {
    const id = orgId.value;
    const result = await OverviewAPI.unit(id, {
      day: day.value,
      month: localDay(calendarDate.value).slice(0, 7),
    });
    if (id === orgId.value) data.value = result;
  } finally {
    loading.value = false;
  }
}
// 日历点一天、或翻月：选中那天，带上月份重新取
watch(calendarDate, (date) => {
  const next = localDay(date);
  if (next > localDay(new Date())) return;
  day.value = next;
  void router.replace({ query: { ...route.query, day: next } });
  void load();
});
watch(orgId, () => void load());

let poll = 0;
onMounted(() => {
  void load();
  poll = window.setInterval(() => void load(), 30000);
});
onActivated(() => {
  if (data.value) void load();
});
onBeforeUnmount(() => window.clearInterval(poll));
</script>

<style scoped>
.grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--page-gap);
}
.hint {
  padding: 10px 16px 12px;
  margin: 0;
  font-size: 12px;
}
.small {
  font-size: 12px;
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.danger {
  font-weight: 600;
  color: var(--el-color-danger);
}
.tag {
  margin-left: 4px;
}
.day-grid {
  display: grid;
  grid-template-columns: 340px minmax(0, 1fr);
  gap: 16px;
  align-items: start;
}
.day-tasks {
  min-width: 0;
}
/* 小日历：格子压矮，有任务的日子带个数，选中的一天高亮 */
.mini-calendar :deep(.el-calendar__header) {
  padding: 4px 0 8px;
  border-bottom: 0;
}
.mini-calendar :deep(.el-calendar__body) {
  padding: 0;
}
.mini-calendar :deep(.el-calendar-table thead th) {
  padding: 4px 0;
  font-size: 12px;
}
.mini-calendar :deep(.el-calendar-table .el-calendar-day) {
  height: 40px;
  padding: 2px;
}
.mini-calendar :deep(.el-calendar-table td.is-selected) {
  background: none;
}
.cell {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  border-radius: 6px;
}
.cell.has {
  font-weight: 600;
}
.cell.picked {
  color: #fff;
  background: var(--el-color-primary);
}
.dot {
  font-size: 10px;
  font-style: normal;
  font-weight: 500;
  line-height: 1;
  color: var(--el-color-primary);
}
.cell.picked .dot {
  color: #fff;
}
@media (max-width: 1000px) {
  .grid,
  .day-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
