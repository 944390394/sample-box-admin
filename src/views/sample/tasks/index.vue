<template>
  <div class="page-container page-flow">
    <PageHeader
      title="任务单"
      subtitle="调拨：采样箱从一个单位送到另一个单位；采样：采样机构带箱子去计划地点采样再寄回。"
    >
      <template #actions>
        <el-button
          v-if="can('task:create:transfer') || can('task:create:sample')"
          type="primary"
          :icon="Plus"
          @click="router.push('/task/create')"
        >
          创建任务单
        </el-button>
      </template>
    </PageHeader>

    <el-card shadow="never">
      <el-tabs v-model="tab" class="status-tabs" @tab-change="onTab">
        <el-tab-pane v-for="item in tabs" :key="item.key" :name="item.key">
          <template #label>
            {{ item.label }}
            <span
              v-if="item.count != null"
              class="count"
              :class="{ hot: item.key === 'mine' && item.count }"
            >
              {{ item.count }}
            </span>
          </template>
        </el-tab-pane>
      </el-tabs>

      <div class="filter-bar">
        <el-radio-group v-model="query.kind" @change="reload">
          <el-radio-button value="">全部类型</el-radio-button>
          <el-radio-button value="调拨">调拨</el-radio-button>
          <el-radio-button value="采样">采样</el-radio-button>
        </el-radio-group>
        <el-tree-select
          v-model="query.orgId"
          :data="orgOptions"
          check-strictly
          filterable
          clearable
          placeholder="涉及单位"
          style="width: 200px"
          :render-after-expand="false"
          @change="reload"
        />
        <div class="date-range">
          <el-date-picker
            v-model="dates"
            type="daterange"
            value-format="YYYY-MM-DD"
            start-placeholder="创建开始"
            end-placeholder="创建结束"
            @change="onDates"
          />
        </div>
        <el-input
          v-model="query.q"
          :prefix-icon="Search"
          placeholder="任务名称、编号、箱子名称或 IMEI"
          clearable
          style="width: 260px"
          @keyup.enter="reload"
          @clear="reload"
        >
          <template #append><el-button @click="reload">搜索</el-button></template>
        </el-input>
        <el-tag v-if="query.boxId" closable @close="clearBox">只看箱子 {{ query.boxId }}</el-tag>
        <el-button v-if="filtered" link type="primary" @click="resetAll">清除筛选</el-button>
      </div>

      <el-table
        v-loading="loading"
        :data="rows"
        class="task-table"
        :empty-text="tab === 'mine' ? '没有等你处理的任务' : '没有符合条件的任务'"
        @row-click="(row: PolicyTask) => router.push(`/task/detail/${row.id}`)"
      >
        <el-table-column label="任务" min-width="220">
          <template #default="{ row }">
            <div class="name">
              <el-tag
                size="small"
                :type="row.kind === '调拨' ? 'primary' : 'success'"
                effect="plain"
              >
                {{ row.kind }}
              </el-tag>
              <b>{{ row.name }}</b>
              <el-tooltip v-if="row.recordVideo" content="采样机构开箱时录像" placement="top">
                <el-icon class="video"><VideoCamera /></el-icon>
              </el-tooltip>
            </div>
            <div class="text-muted mono">{{ row.id }}</div>
          </template>
        </el-table-column>
        <el-table-column label="路线 / 地点" min-width="200">
          <template #default="{ row }">
            <template v-if="row.kind === '调拨'">
              {{ row.fromOrg || "—" }}
              <span class="arrow">→</span>
              {{ row.toOrg || "—" }}
            </template>
            <template v-else>
              {{ row.org || "—" }}
              <div class="text-muted">{{ row.placeAt?.address || row.place || "" }}</div>
            </template>
          </template>
        </el-table-column>
        <el-table-column label="箱数" width="64" align="center">
          <template #default="{ row }">{{ row.boxIds?.length ?? 0 }}</template>
        </el-table-column>
        <el-table-column label="进度" min-width="200">
          <template #default="{ row }">
            <div class="progress-line">
              <span class="status" :class="`tone-${taskTone(row.status)}`">
                <i />
                {{ row.status }}
              </span>
              <span class="text-muted">{{ progressText(row) }}</span>
            </div>
            <div class="steps" :class="{ ended: ended(row) }" :title="progressText(row)">
              <i
                v-for="n in stepOf(row).total"
                :key="n"
                :class="{ done: n - 1 < stepOf(row).index, now: n - 1 === stepOf(row).index }"
              />
            </div>
            <div
              v-if="row.arrival"
              class="arrival"
              :class="{ on: row.arrival.near === row.arrival.total }"
            >
              {{ row.arrival.near }}/{{ row.arrival.total }} 台已到{{ row.arrival.role }}附近
            </div>
            <div v-if="row.openOver" class="over">{{ row.openOver }} 台开箱超限</div>
          </template>
        </el-table-column>
        <el-table-column label="待我处理" width="140">
          <template #default="{ row }">
            <template v-if="row.actions?.filter((a: string) => a !== '已取消').length">
              <span
                v-for="to in row.actions.filter((a: string) => a !== '已取消')"
                :key="to"
                class="todo"
              >
                {{ TASK_ACTIONS[to] || to }}
              </span>
            </template>
            <span v-else class="text-muted">—</span>
          </template>
        </el-table-column>
        <el-table-column label="创建" width="150">
          <template #default="{ row }">
            <div>{{ row.createdBy || "—" }}</div>
            <TimeText class="text-muted" :value="row.createdAt" mode="short" />
          </template>
        </el-table-column>
      </el-table>
      <DataPager
        v-model:page="query.page"
        v-model:page-size="query.pageSize"
        :total="total"
        :sizes="[20, 50, 100]"
      />
    </el-card>
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: "SampleTasks" });

import { Plus, Search, VideoCamera } from "@element-plus/icons-vue";
import type { OptionItem } from "@/api/common";
import API, { type PolicyTask, type TaskCounts } from "@/api/sample/report-policy";
import DeptAPI from "@/api/system/dept";
import DataPager from "@/components/biz/DataPager.vue";
import PageHeader from "@/components/biz/PageHeader.vue";
import TimeText from "@/components/biz/TimeText.vue";
import { usePerm } from "@/composables/usePerm";
import { useUrlQuery } from "@/composables/useUrlQuery";
import { taskTone } from "@/utils/tone";
import { TASK_ACTIONS, stepsOf } from "./status";

/**
 * 任务单列表：上面按状态分标签并带数量，「待我处理」是我现在能推进的；
 * 下面按类型、涉及单位、创建日期、关键字筛。筛选都写在地址栏里。
 */
const router = useRouter();
const can = usePerm();
const {
  state: query,
  sync,
  reset,
} = useUrlQuery({
  status: "进行中",
  mine: "",
  kind: "",
  orgId: "",
  from: "",
  to: "",
  q: "",
  boxId: "",
  page: 1,
  pageSize: 20,
});
const rows = ref<PolicyTask[]>([]);
const total = ref(0);
const counts = ref<Partial<TaskCounts>>({});
const loading = ref(false);
const orgOptions = ref<OptionItem[]>([]);
const dates = ref<string[] | null>(query.from && query.to ? [query.from, query.to] : null);
const tab = ref(query.mine === "1" ? "mine" : query.status || "全部");
const filtered = computed(() =>
  Boolean(query.kind || query.orgId || query.from || query.q || query.boxId)
);

const tabs = computed(() => [
  { key: "mine", label: "待我处理", count: counts.value.mine },
  { key: "进行中", label: "进行中", count: counts.value.进行中 },
  { key: "待寄出", label: "待寄出", count: counts.value["待寄出"] ?? 0 },
  { key: "运送中", label: "运送中", count: counts.value["运送中"] ?? 0 },
  { key: "待签收", label: "待签收", count: counts.value["待签收"] ?? 0 },
  { key: "待采样", label: "待采样", count: counts.value["待采样"] ?? 0 },
  { key: "采样中", label: "采样中", count: counts.value["采样中"] ?? 0 },
  { key: "已结束", label: "已结束", count: counts.value.已结束 },
  { key: "全部", label: "全部", count: counts.value.全部 },
]);

let seq = 0;
async function load() {
  const mine = ++seq;
  loading.value = true;
  try {
    const result = await API.tasks({
      page: query.page,
      pageSize: query.pageSize,
      mine: query.mine === "1" ? "1" : undefined,
      status: query.mine === "1" || query.status === "全部" ? undefined : query.status || undefined,
      kind: query.kind || undefined,
      orgId: query.orgId || undefined,
      from: query.from || undefined,
      to: query.to || undefined,
      q: query.q.trim() || undefined,
      boxId: query.boxId || undefined,
    });
    if (mine !== seq) return;
    rows.value = result.list;
    total.value = result.total;
    counts.value = result.counts || {};
  } finally {
    if (mine === seq) loading.value = false;
  }
}
function reload() {
  query.page = 1;
  sync();
  void load();
}
function onTab(name: string | number) {
  const key = String(name);
  query.mine = key === "mine" ? "1" : "";
  query.status = key === "mine" ? "" : key;
  reload();
}
function onDates(value: string[] | null) {
  query.from = value?.[0] || "";
  query.to = value?.[1] || "";
  reload();
}
function clearBox() {
  query.boxId = "";
  reload();
}
function resetAll() {
  reset();
  dates.value = null;
  tab.value = "进行中";
  void load();
}
watch(
  () => [query.page, query.pageSize],
  () => {
    sync();
    void load();
  }
);

// 表格行在模板里是 DefaultRow，按普通对象收
type TaskRow = Record<string, unknown> & { kind?: string; status?: string };
const ended = (row: TaskRow) => ["已取消", "已拒收"].includes(String(row.status));
function stepOf(row: TaskRow) {
  const steps = stepsOf(row);
  const index = steps.indexOf(String(row.status));
  return {
    index:
      index < 0
        ? ["已完成", "已签收"].includes(String(row.status))
          ? steps.length - 1
          : -1
        : index,
    total: steps.length,
  };
}
function progressText(row: TaskRow) {
  if (ended(row)) return "已结束";
  const { index, total } = stepOf(row);
  return index >= 0 ? `第 ${index + 1}/${total} 步` : "";
}

onMounted(async () => {
  void load();
  try {
    orgOptions.value = await DeptAPI.getOptions();
  } catch {
    orgOptions.value = [];
  }
});
onActivated(() => void load());
</script>

<style scoped>
.status-tabs :deep(.el-tabs__header) {
  margin-bottom: 12px;
}
.count {
  padding: 0 6px;
  margin-left: 4px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  background: var(--el-fill-color);
  border-radius: 10px;
}
.count.hot {
  color: #fff;
  background: var(--el-color-danger);
}
.filter-bar {
  margin-bottom: 12px;
}
.date-range {
  width: 250px;
}
.date-range :deep(.el-date-editor) {
  width: 100%;
}
.task-table :deep(.el-table__row) {
  cursor: pointer;
}
.name {
  display: flex;
  gap: 6px;
  align-items: center;
}
.video {
  color: var(--el-color-success);
}
.arrow {
  color: var(--el-color-primary);
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
}
.progress-line {
  display: flex;
  gap: 8px;
  align-items: center;
}
.status {
  display: inline-flex;
  gap: 5px;
  align-items: center;
  font-weight: 600;
}
.status i {
  width: 7px;
  height: 7px;
  background: currentcolor;
  border-radius: 50%;
}
.tone-primary {
  color: var(--el-color-primary);
}
.tone-success {
  color: var(--status-ok);
}
.tone-warning {
  color: var(--status-warn);
}
.tone-danger {
  color: var(--status-danger);
}
.tone-info {
  color: var(--status-stale);
}
/* 每一步一格：做完的实心，当前这步主色，还没到的灰色 */
.steps {
  display: flex;
  gap: 3px;
  max-width: 180px;
  margin-top: 6px;
}
.steps i {
  flex: 1;
  height: 4px;
  background: var(--el-fill-color-dark, #e5e6eb);
  border-radius: 2px;
}
.steps i.done {
  background: var(--el-color-primary-light-5);
}
.steps i.now {
  background: var(--el-color-primary);
}
.steps.ended i {
  background: var(--el-border-color);
}
.todo {
  display: inline-block;
  padding: 1px 8px;
  margin: 0 4px 4px 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--status-warn);
  background: var(--status-warn-bg);
  border-radius: 10px;
}
.arrival {
  margin-top: 4px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.arrival.on {
  color: var(--el-color-success);
}
.over {
  margin-top: 4px;
  font-size: 12px;
  color: var(--el-color-danger);
}
</style>
