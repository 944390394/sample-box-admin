<template>
  <div class="page-container page-flow">
    <PageHeader
      title="送检单"
      subtitle="把采样箱送到检测站开箱检测：待寄出 → 运送中 → 待签收 → 待检测 → 已检测；拒收/退回是独立分支。"
    >
      <template #actions>
        <el-button
          v-if="can('task:create:inspect')"
          type="primary"
          :icon="Plus"
          @click="router.push('/task/create?type=送检')"
        >
          创建送检单
        </el-button>
      </template>
    </PageHeader>

    <StatTiles :items="tiles" :max="6" @update:model-value="onTile" />

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
          placeholder="单名 / 单号 / 箱码 / 箱名"
          clearable
          style="width: 240px"
          @keyup.enter="reload"
          @clear="reload"
        >
          <template #append><el-button @click="reload">搜索</el-button></template>
        </el-input>
        <el-button v-if="filtered" link type="primary" @click="resetAll">清除筛选</el-button>
      </div>

      <el-table
        v-loading="loading"
        :data="rows"
        class="task-table"
        :empty-text="tab === 'mine' ? '没有等你处理的送检单' : '没有符合条件的送检单'"
        @row-click="(row: PolicyTask) => router.push(`/task/detail/${row.id}`)"
      >
        <el-table-column label="送检单" min-width="240">
          <template #default="{ row }">
            <div class="name">
              <el-tag
                size="small"
                :type="inspectDir(row.status) === '退回' ? 'warning' : 'info'"
                effect="plain"
              >
                {{ inspectDir(row.status) }}
              </el-tag>
              <b>{{ row.name }}</b>
            </div>
            <div class="text-muted mono">{{ row.id }}</div>
          </template>
        </el-table-column>
        <el-table-column label="寄出 → 检测站" min-width="200">
          <template #default="{ row }">
            {{ row.fromOrg || "—" }}
            <span class="arrow">→</span>
            {{ row.toOrg || "—" }}
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

    <el-card shadow="never" class="block flow-card" header="送检流程与分支">
      <div class="flow">
        <div class="flow-line">
          <b>送检</b>
          <span v-for="(s, i) in INSPECT_FLOW" :key="s" class="step">
            {{ s }}
            <i v-if="i < INSPECT_FLOW.length - 1" class="sep">→</i>
          </span>
          <em class="text-muted">（终）</em>
        </div>
        <div class="flow-line">
          <b>拒收退回</b>
          <span v-for="(s, i) in INSPECT_RETURN_FLOW" :key="s" class="step">
            {{ s }}
            <i v-if="i < INSPECT_RETURN_FLOW.length - 1" class="sep">→</i>
          </span>
          <em class="text-muted">（终）</em>
        </div>
      </div>
      <p class="text-muted notes">
        分支注记：拒收不退回 → 已拒收（终）；拒收需填原因；退回途中不能取消；开箱检测前先核验告警。
        「已签收」不是持久状态——待签收上签收后直接落「待检测」。
      </p>
    </el-card>
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: "SampleInspections" });

import { Plus, Search } from "@element-plus/icons-vue";
import API, { type PolicyTask, type TaskCounts } from "@/api/sample/report-policy";
import { INSPECT_FLOW, INSPECT_RETURN_FLOW } from "../../../../shared/taskFlow.js";
import DeptAPI from "@/api/system/dept";
import type { OptionItem } from "@/api/common";
import PageHeader from "@/components/biz/PageHeader.vue";
import StatTiles, { type StatTile } from "@/components/biz/StatTiles.vue";
import TimeText from "@/components/biz/TimeText.vue";
import DataPager from "@/components/biz/DataPager.vue";
import { usePerm } from "@/composables/usePerm";
import { useUrlQuery } from "@/composables/useUrlQuery";
import { taskTone } from "@/utils/tone";
import { TASK_ACTIONS, isEnded, stepsOf } from "../tasks/status";
import { INSPECT_STATUS, inspectDir } from "../doc-flow";

/**
 * 送检单列表：kind=送检 的 tasks 读模型（服务端开关开时 kind 白名单含送检）。
 * 9 个持久状态各一个页签（已签收不是状态）+ 待我处理/进行中/全部；详情动作矩阵复用任务详情页。
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
  orgId: "",
  from: "",
  to: "",
  q: "",
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
const filtered = computed(() => Boolean(query.orgId || query.from || query.q));

const tabs = computed(() => [
  { key: "mine", label: "待我处理", count: counts.value.mine },
  { key: "进行中", label: "进行中", count: counts.value.进行中 },
  ...INSPECT_STATUS.map((s) => ({ key: s, label: s, count: counts.value[s] ?? 0 })),
  { key: "全部", label: "全部", count: counts.value.全部 },
]);
const tiles = computed<StatTile[]>(() => [
  {
    key: "全部",
    label: "全部送检",
    value: counts.value.全部 ?? 0,
    tone: "primary",
    hint: `总数 ${counts.value.全部 ?? 0} · 筛选后 ${counts.value.全部 ?? 0}`,
  },
  {
    key: "待检测",
    label: "待检测",
    value: counts.value["待检测"] ?? 0,
    tone: "warning",
    hint: `总数 ${counts.value["待检测"] ?? 0} · 筛选后 ${counts.value["待检测"] ?? 0}`,
  },
  {
    key: "运送中",
    label: "在途·运送中",
    value: counts.value["运送中"] ?? 0,
    tone: "primary",
    hint: `总数 ${counts.value["运送中"] ?? 0} · 筛选后 ${counts.value["运送中"] ?? 0}`,
  },
  {
    key: "待签收",
    label: "待签收",
    value: counts.value["待签收"] ?? 0,
    tone: "warning",
    hint: `总数 ${counts.value["待签收"] ?? 0} · 筛选后 ${counts.value["待签收"] ?? 0}`,
  },
  {
    key: "退回中",
    label: "退回中",
    value: counts.value["退回中"] ?? 0,
    tone: "warning",
    hint: `总数 ${counts.value["退回中"] ?? 0} · 筛选后 ${counts.value["退回中"] ?? 0}`,
  },
  {
    key: "已结束",
    label: "终态",
    value: counts.value.已结束 ?? 0,
    tone: "info",
    hint: `总数 ${counts.value.已结束 ?? 0} · 筛选后 ${counts.value.已结束 ?? 0}`,
  },
]);

let seq = 0;
async function load() {
  const mine = ++seq;
  loading.value = true;
  try {
    const result = await API.tasks({
      page: query.page,
      pageSize: query.pageSize,
      kind: "送检",
      mine: query.mine === "1" ? "1" : undefined,
      status: query.mine === "1" || query.status === "全部" ? undefined : query.status || undefined,
      orgId: query.orgId || undefined,
      from: query.from || undefined,
      to: query.to || undefined,
      q: query.q.trim() || undefined,
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
function onTile(key: string) {
  tab.value = key;
  query.mine = "";
  query.status = key;
  reload();
}
function onDates(value: string[] | null) {
  query.from = value?.[0] || "";
  query.to = value?.[1] || "";
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

type TaskRow = Record<string, unknown> & { kind?: string; status?: string };
const ended = (row: TaskRow) => isEnded(String(row.status));
function stepOf(row: TaskRow) {
  const steps = stepsOf(row);
  return { index: steps.indexOf(String(row.status)), total: steps.length };
}
function progressText(row: TaskRow) {
  const { index, total } = stepOf(row);
  if (index >= 0) return `第 ${index + 1}/${total} 步`;
  return ended(row) ? "已结束" : "";
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
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
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
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
}
.arrow {
  margin: 0 4px;
  color: var(--el-color-primary);
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
.over {
  margin-top: 4px;
  font-size: 12px;
  color: var(--el-color-danger);
}
.block {
  margin-top: 12px;
}
.flow-line {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  align-items: center;
  margin-bottom: 8px;
}
.flow-line b {
  margin-right: 8px;
}
.step {
  display: inline-flex;
  align-items: center;
}
.sep {
  margin: 0 6px;
  font-style: normal;
  color: var(--el-text-color-placeholder);
}
.notes {
  margin: 8px 0 0;
  font-size: 12px;
  line-height: 1.7;
}
</style>
