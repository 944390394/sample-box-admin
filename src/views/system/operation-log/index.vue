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
        <el-tree-select
          v-if="orgOptions.length"
          v-model="orgId"
          :data="orgOptions"
          :props="{ disabled: 'readOnly' }"
          check-strictly
          filterable
          clearable
          placeholder="所属单位"
          class="org"
          :render-after-expand="false"
          @change="search"
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
        <el-tooltip
          v-if="canExport"
          content="按当前筛选导出 CSV，一次最多 50,000 行"
          placement="top"
        >
          <el-button :loading="exporting" @click="exportCsv">导出 CSV</el-button>
        </el-tooltip>
      </div>

      <el-alert v-if="loadError" type="error" :closable="false" show-icon class="load-error">
        <template #title>{{ loadError.title }}</template>
        <template #default>
          {{ loadError.detail }}
          <el-button link type="primary" class="retry" @click="load">重试</el-button>
        </template>
      </el-alert>

      <el-table v-loading="loading" :data="list" class="log-table">
        <template #empty>
          <el-empty>
            <template #description>
              <p>{{ loadError ? "加载失败，请重试" : "这段时间没有操作记录" }}</p>
              <p v-if="!loadError" class="empty-hint">
                仅显示您数据范围内的操作记录，可调整时间范围或单位筛选后再试。
              </p>
            </template>
            <el-button v-if="loadError" type="primary" @click="load">重试</el-button>
          </el-empty>
        </template>
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
        <el-table-column label="操作" width="80" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="openDetail(row)">详情</el-button>
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

    <el-drawer v-model="detailOpen" title="操作日志详情" size="420px">
      <el-descriptions v-if="detailRow" :column="1" border>
        <el-descriptions-item label="时间">
          {{ fullTime(detailRow.createdAt) }}
        </el-descriptions-item>
        <el-descriptions-item label="单位">{{ detailRow.orgName || "—" }}</el-descriptions-item>
        <el-descriptions-item label="操作者">
          {{ detailRow.actorName || "—" }}
          <span v-if="detailRow.actorId" class="text-muted">（{{ detailRow.actorId }}）</span>
        </el-descriptions-item>
        <el-descriptions-item label="动作">{{ actionText(detailRow) }}</el-descriptions-item>
        <el-descriptions-item label="对象">{{ targetText(detailRow) || "—" }}</el-descriptions-item>
        <el-descriptions-item label="结果">{{ detailRow.result }}</el-descriptions-item>
        <el-descriptions-item label="来源 IP">{{ detailRow.ip || "—" }}</el-descriptions-item>
        <el-descriptions-item label="明细">
          <pre v-if="detailText" class="detail-json">{{ detailText }}</pre>
          <span v-else>—</span>
        </el-descriptions-item>
      </el-descriptions>
    </el-drawer>
  </div>
</template>

<script setup lang="ts">
import PageHeader from "@/components/biz/PageHeader.vue";
import { fullTime } from "@/utils/time";
import OperationLogAPI, {
  type OperationLogCursor,
  type OperationLogItem,
} from "@/api/system/operation-log";
import DeptAPI from "@/api/system/dept";
import type { OptionItem } from "@/api/common";
import { usePerm } from "@/composables/usePerm";
import { downloadFile } from "@/utils/download";
import type { ApiError } from "@/utils/request";

defineOptions({
  name: "OperationLog",
  inheritAttrs: false,
});

const can = usePerm();
/** 导出按钮仅有 sys:oplog:export 码才显示；无码调接口也会被服务端 A0301/403 拦住 */
const canExport = computed(() => can("sys:oplog:export"));

const loading = ref(false);
const list = ref<OperationLogItem[]>([]);
const actor = ref("");
const targetId = ref("");
const orgId = ref("");
/** 单位选项来自 scoped /depts/options：祖先只读壳不可选（选了也会被服务端收敛为空） */
const orgOptions = ref<(OptionItem & { readOnly?: boolean })[]>([]);
const range = ref<[string, string]>(defaultRange());
const cursors = ref<(OperationLogCursor | null)[]>([null]);
const pageIndex = ref(0);
const nextCursor = ref<OperationLogCursor | null>(null);
const loadError = ref<{ title: string; detail: string } | null>(null);
const exporting = ref(false);
const detailOpen = ref(false);
const detailRow = ref<OperationLogItem | null>(null);

/** 明细多是 JSON（grant diff/scope 前后），能解析就格式化展示，否则原样给文本 */
const detailText = computed(() => {
  const raw = detailRow.value?.detail || "";
  if (!raw) return "";
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
});

function openDetail(row: unknown) {
  detailRow.value = row as OperationLogItem;
  detailOpen.value = true;
}

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
  oplog: "操作日志",
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

/** 错误态按码分流：无权限给授权指引，网络错误可重试，其余（如超 31 天）照服务端文案。 */
function describeError(error: unknown): { title: string; detail: string } {
  const err = error as ApiError;
  const code = err?.code;
  if (code === "A0301")
    return {
      title: "没有查看操作日志的权限",
      detail: "当前角色未分配操作日志查看权限，请联系管理员授权后重试。",
    };
  if (!code || code === "ERR_NETWORK" || code === "ECONNABORTED" || code === "ETIMEDOUT")
    return {
      title: "网络连接失败",
      detail: "未能加载操作日志，请检查网络后重试。",
    };
  return { title: "加载失败", detail: err?.message || "请稍后重试。" };
}

function currentFilter() {
  const [from, to] = range.value || [];
  return {
    from,
    to,
    orgId: orgId.value || undefined,
    actor: actor.value.trim() || undefined,
    targetId: targetId.value.trim() || undefined,
  };
}

async function load() {
  const { from, to } = currentFilter();
  if (!from || !to) {
    ElMessage.warning("请选择时间");
    return;
  }
  loading.value = true;
  loadError.value = null;
  try {
    const cursor = cursors.value[pageIndex.value];
    const page = await OperationLogAPI.page({
      ...currentFilter(),
      limit: 20,
      cursorTime: cursor?.time,
      cursorId: cursor?.id,
    });
    list.value = page.list;
    nextCursor.value = page.nextCursor;
  } catch (error) {
    list.value = [];
    nextCursor.value = null;
    loadError.value = describeError(error);
  } finally {
    loading.value = false;
  }
}

/** 导出当前筛选（不带翻页游标）；截断时响应头会标明，提示分批导出。 */
async function exportCsv() {
  const { from, to } = currentFilter();
  if (!from || !to) {
    ElMessage.warning("请选择时间");
    return;
  }
  exporting.value = true;
  try {
    const res = await OperationLogAPI.export(currentFilter());
    downloadFile(res);
    if (String(res.headers["x-export-truncated"]) === "1") {
      const max = Number(res.headers["x-export-max"]) || 50000;
      ElMessage.warning(
        `已达单次导出上限 ${max.toLocaleString()} 行，仅导出最近的 ${max.toLocaleString()} 行；其余请缩小时间范围后分批导出`
      );
    } else {
      ElMessage.success("导出成功");
    }
  } catch (error) {
    reportExportError(error);
  } finally {
    exporting.value = false;
  }
}

/**
 * 错误体（含 blob 包裹的 JSON）已由 request.ts 拦截器统一解析成带 code/msg/status 的 ApiError，
 * 这里只按码分流：无权限给授权指引，400 超 31 天照服务端文案，网络错误可重试。
 */
function reportExportError(error: unknown) {
  const code = (error as ApiError)?.code;
  const msg = (error as ApiError)?.message;
  if (code === "A0301") {
    ElMessage.error("没有导出操作日志的权限，请联系管理员授权后重试");
  } else if (!code || code === "ERR_NETWORK" || code === "ECONNABORTED" || code === "ETIMEDOUT") {
    ElMessage.error("网络连接失败，导出未完成，请重试");
  } else {
    ElMessage.error(msg || "导出失败，请重试");
  }
}

/** 回到默认：最近 7 天、不限单位/操作者和对象。 */
function resetFilters() {
  range.value = defaultRange();
  orgId.value = "";
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

onMounted(async () => {
  void load();
  try {
    orgOptions.value = await DeptAPI.getOptions();
  } catch {
    orgOptions.value = [];
  }
});
</script>

<style lang="scss" scoped>
.filter-bar {
  margin-bottom: 12px;
}
.range {
  width: 360px;
  max-width: 100%;
}
.org {
  width: 220px;
}
.field {
  width: 200px;
}
.field.wide {
  width: 300px;
}
.load-error {
  margin-bottom: 12px;
}
.retry {
  margin-left: 8px;
}
.empty-hint {
  font-size: 12px;
  color: var(--el-text-color-secondary);
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
.detail-json {
  max-height: 320px;
  margin: 0;
  overflow: auto;
  font-size: 12px;
  word-break: break-all;
  white-space: pre-wrap;
}
@media (max-width: 640px) {
  .range,
  .org,
  .field,
  .field.wide {
    width: 100%;
  }
}
</style>
