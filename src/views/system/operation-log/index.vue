<template>
  <div class="page-container page-flow">
    <PageHeader
      title="操作日志"
      subtitle="谁在什么时候做了什么：登录、建单、改权限、改设置都记在这里。"
    />

    <el-card shadow="never">
      <div class="filter-bar">
        <el-date-picker
          v-model="range"
          :editable="false"
          type="datetimerange"
          range-separator="至"
          start-placeholder="开始时间"
          end-placeholder="结束时间"
          value-format="YYYY-MM-DD HH:mm:ss"
          class="range"
        />
        <el-input
          v-model="actor"
          clearable
          placeholder="操作者：姓名或编号"
          class="field"
          @keyup.enter="search"
        />
        <el-input
          v-model="targetId"
          clearable
          placeholder="对象：人员、部门、箱子、任务单号"
          class="field wide"
          @keyup.enter="search"
        />
        <el-button type="primary" @click="search">查询</el-button>
        <el-button @click="resetFilters">重置</el-button>
      </div>

      <el-table
        v-loading="loading"
        :data="list"
        class="log-table"
        empty-text="这段时间没有操作记录"
      >
        <el-table-column label="时间" width="150">
          <template #default="{ row }">
            <span class="time" :title="row.createdAt">{{ logTime(row.createdAt) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作者" min-width="150">
          <template #default="{ row }">
            <div>{{ row.actorName || "—" }}</div>
            <div class="text-muted">{{ row.orgName || "" }}</div>
          </template>
        </el-table-column>
        <el-table-column label="动作" min-width="180">
          <template #default="{ row }">
            <b class="action">{{ actionText(row) }}</b>
          </template>
        </el-table-column>
        <el-table-column label="对象" min-width="220">
          <template #default="{ row }">
            <span class="target">{{ targetText(row) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="结果" width="80">
          <template #default="{ row }">
            <span class="result" :class="row.result === '成功' ? 'ok' : 'bad'">
              <i />
              {{ row.result }}
            </span>
          </template>
        </el-table-column>
        <el-table-column label="来源 IP" width="140">
          <template #default="{ row }">
            <span class="mono">{{ row.ip || "—" }}</span>
          </template>
        </el-table-column>
      </el-table>
      <div class="pager">
        <span class="text-muted">第 {{ pageIndex + 1 }} 页 · 每页 20 条</span>
        <div>
          <el-button :disabled="pageIndex === 0" @click="prev">上一页</el-button>
          <el-button :disabled="!nextCursor" @click="next">下一页</el-button>
        </div>
      </div>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import PageHeader from "@/components/biz/PageHeader.vue";
import { fullTime } from "@/utils/time";
import OperationLogAPI, {
  type OperationLogCursor,
  type OperationLogItem,
} from "@/api/system/operation-log";

defineOptions({
  name: "OperationLog",
  inheritAttrs: false,
});

const loading = ref(false);
const list = ref<OperationLogItem[]>([]);
const actor = ref("");
const targetId = ref("");
const range = ref<[string, string]>(defaultRange());
const cursors = ref<(OperationLogCursor | null)[]>([null]);
const pageIndex = ref(0);
const nextCursor = ref<OperationLogCursor | null>(null);

/** 日志精确到秒：今年的不写年份，悬停看完整时间。 */
function logTime(time: string) {
  const text = fullTime(time);
  return text.startsWith(String(new Date().getFullYear())) ? text.slice(5) : text;
}

function pad(value: number) {
  return String(value).padStart(2, "0");
}

function formatDate(date: Date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function defaultRange(): [string, string] {
  const end = new Date();
  const start = new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000);
  return [formatDate(start), formatDate(end)];
}

/** 对象类型显示成中文；任务单的对象类型历史上记成 report-policy。 */
const TARGET_TYPES: Record<string, string> = {
  user: "人员",
  dept: "部门",
  role: "角色",
  box: "采样箱",
  branding: "系统名称和图标",
  map: "地图设置",
  labels: "字段名称",
  database: "数据库",
  "report-policy": "上报策略",
};
function targetText(row: unknown) {
  const item = row as OperationLogItem;
  const id = item.targetId || "";
  const type = id.startsWith("TK-")
    ? "任务单"
    : TARGET_TYPES[item.targetType || ""] || item.targetType || "";
  // 系统名称这类全局设置没有编号，编号和类型相同时不重复显示
  return [type, id && id !== item.targetType ? id : ""].filter(Boolean).join(" ");
}
/** 旧记录里的技术说法换成业务说法。 */
function actionText(row: unknown) {
  const action = (row as OperationLogItem).action || "";
  if (action === "创建含上报策略的任务") return "创建任务单";
  const legacy = action.match(/^任务(.+)，更新上报策略覆盖$/);
  if (legacy) return legacy[1] === "强制签收" ? "任务单强制签收" : `任务单推进到「${legacy[1]}」`;
  return action;
}

async function load() {
  const [from, to] = range.value || [];
  if (!from || !to) {
    ElMessage.warning("请选择时间");
    return;
  }
  loading.value = true;
  try {
    const cursor = cursors.value[pageIndex.value];
    const page = await OperationLogAPI.page({
      from,
      to,
      limit: 20,
      actor: actor.value.trim() || undefined,
      targetId: targetId.value.trim() || undefined,
      cursorTime: cursor?.time,
      cursorId: cursor?.id,
    });
    list.value = page.list;
    nextCursor.value = page.nextCursor;
  } finally {
    loading.value = false;
  }
}

/** 回到默认：最近 7 天、不限操作者和对象。 */
function resetFilters() {
  range.value = defaultRange();
  actor.value = "";
  targetId.value = "";
  search();
}

function search() {
  cursors.value = [null];
  pageIndex.value = 0;
  load();
}

function next() {
  if (!nextCursor.value) return;
  cursors.value = cursors.value.slice(0, pageIndex.value + 1);
  cursors.value.push(nextCursor.value);
  pageIndex.value += 1;
  load();
}

function prev() {
  if (pageIndex.value === 0) return;
  pageIndex.value -= 1;
  load();
}

onMounted(load);
</script>

<style lang="scss" scoped>
.filter-bar {
  margin-bottom: 12px;
}
.range {
  width: 360px;
  max-width: 100%;
}
.field {
  width: 200px;
}
.field.wide {
  width: 300px;
}
.time,
.mono {
  font-variant-numeric: tabular-nums;
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
}
.action {
  font-weight: 600;
}
.target {
  overflow-wrap: anywhere;
}
.result {
  display: inline-flex;
  gap: 5px;
  align-items: center;
}
.result i {
  width: 6px;
  height: 6px;
  background: currentcolor;
  border-radius: 50%;
}
.result.ok {
  color: var(--status-ok);
}
.result.bad {
  color: var(--status-danger);
}
.pager {
  display: flex;
  gap: 8px;
  align-items: center;
  justify-content: space-between;
  margin-top: 12px;
}
@media (max-width: 640px) {
  .range,
  .field,
  .field.wide {
    width: 100%;
  }
}
</style>
