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
        <span class="filter-bar__spacer" />
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

      <!-- #94：32px 密行＋sticky 表头（max-height 内滚，沿任务单列表基线；
           345px＝页头＋两行筛选条＋分页＋页边距，900 高下分页不折行到折叠线外） -->
      <el-table v-loading="loading" :data="list" class="log-table" max-height="calc(100vh - 345px)">
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
        <el-table-column label="时间" width="110">
          <template #default="{ row }">
            <TimeText :value="row.createdAt" />
          </template>
        </el-table-column>
        <el-table-column label="操作者" min-width="170">
          <template #default="{ row }">
            <span class="actor">
              {{ row.actorName || "—" }}
              <span class="text-muted org-name">{{ row.orgName || "" }}</span>
            </span>
          </template>
        </el-table-column>
        <el-table-column label="动作" min-width="180">
          <template #default="{ row }">
            <el-tag
              size="small"
              :type="actionTag(actionText(row)).type"
              :effect="actionTag(actionText(row)).plain ? 'plain' : 'light'"
              class="action-tag"
              data-test="oplog-action"
            >
              {{ actionText(row) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="对象" min-width="220">
          <template #default="{ row }">
            <el-tooltip
              :disabled="!row.targetId && !targetDisplay(row).fallback"
              :content="tooltipText(row)"
              placement="top"
            >
              <span
                class="target"
                :class="{ fallback: targetDisplay(row).fallback }"
                data-test="oplog-target"
              >
                {{ targetDisplay(row).text }}
              </span>
            </el-tooltip>
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
        <el-descriptions-item label="对象">
          <span class="target inline" :class="{ fallback: targetDisplay(detailRow).fallback }">
            {{ targetDisplay(detailRow).text || "—" }}
          </span>
          <span v-if="detailRow.targetId" class="text-muted">（{{ detailRow.targetId }}）</span>
        </el-descriptions-item>
        <el-descriptions-item label="结果">{{ detailRow.result }}</el-descriptions-item>
        <el-descriptions-item label="来源 IP">{{ detailRow.ip || "—" }}</el-descriptions-item>
        <el-descriptions-item label="明细">
          <!-- #94：detail 是 JSON 对象时结构化——grant diff 差集行＋其余键值对表格；原始 JSON 折叠可查 -->
          <template v-if="detailObj">
            <div v-if="diffRows.length" class="detail-diff" data-test="oplog-detail-diff">
              <div v-for="(r, i) in diffRows" :key="i" class="diff-row" :class="r.cls">
                <span v-if="r.sign" class="sign">{{ r.sign }}</span>
                {{ r.text }}
              </div>
            </div>
            <table v-if="kvRows.length" class="detail-kv" data-test="oplog-detail-kv">
              <tbody>
                <tr v-for="r in kvRows" :key="r.label">
                  <th>{{ r.label }}</th>
                  <td>{{ r.value }}</td>
                </tr>
              </tbody>
            </table>
            <el-button link type="primary" class="raw-toggle" @click="showRaw = !showRaw">
              {{ showRaw ? "收起原始 JSON" : "查看原始 JSON" }}
            </el-button>
            <pre v-if="showRaw" class="detail-json">{{ detailText }}</pre>
          </template>
          <pre v-else-if="detailText" class="detail-json">{{ detailText }}</pre>
          <span v-else>—</span>
        </el-descriptions-item>
      </el-descriptions>
    </el-drawer>
  </div>
</template>

<script setup lang="ts">
import PageHeader from "@/components/biz/PageHeader.vue";
import TimeText from "@/components/biz/TimeText.vue";
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
const showRaw = ref(false);

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

/** #94：detail 解析成对象才结构化；数组/标量/非 JSON 走原文本通路 */
const detailObj = computed<Record<string, unknown> | null>(() => {
  const raw = detailRow.value?.detail || "";
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
});

/** 数据范围文案（与角色页 SCOPES 同词汇） */
const SCOPES: Record<number, string> = {
  1: "全部数据",
  2: "本单位及下级",
  3: "本单位",
  4: "仅本人",
  5: "自定义部门数据",
};
const scopeText = (value: unknown) => SCOPES[Number(value)] || "—";

/** grant diff 专用键：走差集行，不再进键值表 */
const DIFF_KEYS = new Set([
  "added",
  "removed",
  "grantOn",
  "grantOff",
  "scopeBefore",
  "scopeAfter",
  "scope",
  "deptBefore",
  "deptAfter",
  "deptIds",
  "limitedBefore",
  "limitedAfter",
  "maxScopeBefore",
  "maxScopeAfter",
]);

type DiffRow = { sign: string; text: string; cls: "add" | "del" | "pass" | "range" };

/** #94：before/after 差集结构化（沿 RoleAuditDrawer 的 ＋/－/⇄/范围行视觉） */
const diffRows = computed<DiffRow[]>(() => {
  const d = detailObj.value;
  if (!d) return [];
  const rows: DiffRow[] = [];
  const codes = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
  for (const code of codes(d.added)) rows.push({ sign: "＋", text: code, cls: "add" });
  for (const code of codes(d.removed)) rows.push({ sign: "－", text: code, cls: "del" });
  for (const code of codes(d.grantOn))
    rows.push({ sign: "⇄", text: `${code} 开可转授`, cls: "pass" });
  for (const code of codes(d.grantOff))
    rows.push({ sign: "⇄", text: `${code} 关可转授`, cls: "pass" });
  if (d.scopeBefore != null)
    rows.push({
      sign: "",
      text: `数据范围：${scopeText(d.scopeBefore)} → ${scopeText(d.scopeAfter)}`,
      cls: "range",
    });
  if (d.scope != null)
    rows.push({ sign: "", text: `初始数据范围：${scopeText(d.scope)}`, cls: "range" });
  const before = Array.isArray(d.deptBefore) ? d.deptBefore.map(String) : [];
  const after = Array.isArray(d.deptAfter) ? d.deptAfter.map(String) : [];
  if (before.length || after.length) {
    const bs = new Set(before);
    const as = new Set(after);
    for (const id of after.filter((x) => !bs.has(x)))
      rows.push({ sign: "＋", text: `自定义部门 ${id}`, cls: "add" });
    for (const id of before.filter((x) => !as.has(x)))
      rows.push({ sign: "－", text: `自定义部门 ${id}`, cls: "del" });
  }
  if (Array.isArray(d.deptIds) && d.deptIds.length)
    rows.push({ sign: "", text: `自定义部门：${d.deptIds.map(String).join("、")}`, cls: "range" });
  if (typeof d.limitedBefore === "boolean" || typeof d.limitedAfter === "boolean")
    rows.push({
      sign: "",
      text: `部门权限上限：${d.limitedBefore ? "开" : "关"} → ${d.limitedAfter ? "开" : "关"}`,
      cls: "range",
    });
  if (d.maxScopeBefore !== undefined || d.maxScopeAfter !== undefined)
    rows.push({
      sign: "",
      text: `最大数据范围：${scopeText(d.maxScopeBefore)} → ${scopeText(d.maxScopeAfter)}`,
      cls: "range",
    });
  return rows;
});

/** 键值表中文标签（未知键原样给键名） */
const DETAIL_LABELS: Record<string, string> = {
  before: "改前",
  after: "改后",
  affectedBoxCount: "影响箱数",
  二次确认: "口令再认证",
  原因: "原因",
  trackingNo: "快递单号",
  asOrgId: "切换视角单位",
  asRoleCode: "切换视角角色",
  note: "备注",
};

function formatDetailValue(value: unknown): string {
  if (value == null) return "—";
  if (typeof value === "boolean") return value ? "是" : "否";
  if (Array.isArray(value))
    return (
      value.map((x) => (typeof x === "object" ? JSON.stringify(x) : String(x))).join("、") || "—"
    );
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** #94：差集之外的键补键值对表格（改前/改后、二次确认、快递单号等） */
const kvRows = computed(() => {
  const d = detailObj.value;
  if (!d) return [];
  return Object.entries(d)
    .filter(([key]) => !DIFF_KEYS.has(key))
    .map(([key, value]) => ({ label: DETAIL_LABELS[key] || key, value: formatDetailValue(value) }));
});

function openDetail(row: unknown) {
  detailRow.value = row as OperationLogItem;
  showRaw.value = false;
  detailOpen.value = true;
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
/** 旧服务端（无 targetName）兼容：类型＋编号拼接 */
function targetText(row: unknown) {
  const item = row as OperationLogItem;
  const id = item.targetId || "";
  const type = id.startsWith("TK-")
    ? "任务单"
    : id.startsWith("AL-")
      ? "划拨单"
      : TARGET_TYPES[item.targetType || ""] || item.targetType || "";
  // 系统名称这类全局设置没有编号，编号和类型相同时不重复显示
  return [type, id && id !== item.targetType ? id : ""].filter(Boolean).join(" ");
}

/**
 * #94：对象列显示服务端解析的 targetName（人名/部门名/箱名/单号+名称）；
 * 回退态（targetResolved=false）灰字＋tooltip 原编号；旧服务端无字段时回退旧拼接。
 * 表格插槽 row 是 DefaultRow，沿旧 targetText 的 unknown＋断言口径。
 */
function targetDisplay(row: unknown): { text: string; fallback: boolean } {
  const item = row as OperationLogItem;
  if (item.targetName) return { text: item.targetName, fallback: item.targetResolved === false };
  return { text: targetText(item), fallback: false };
}

/** tooltip：可读名＋原编号（回退态靠它看编号；长名截断时靠它看全） */
function tooltipText(row: unknown) {
  const item = row as OperationLogItem;
  const { text } = targetDisplay(item);
  return item.targetId ? `${text}（编号 ${item.targetId}）` : text;
}

/** 旧记录里的技术说法换成业务说法。 */
function actionText(row: unknown) {
  const action = (row as OperationLogItem).action || "";
  if (action === "创建含上报策略的任务") return "创建任务单";
  const legacy = action.match(/^任务(.+)，更新上报策略覆盖$/);
  if (legacy) return legacy[1] === "强制签收" ? "任务单强制签收" : `任务单推进到「${legacy[1]}」`;
  return action;
}

/**
 * #94 动作语义色族：登录 info／建单 primary／改权限·改设置 warning／签收·检测 success／
 * 划拨·撤销 danger／其余中性。EP tag 没有 default type（缺省即 primary，会与建单撞色），
 * 其余用 info＋plain 中性灰描边，与登录的 info 浅底区分。
 */
function actionTag(action: string): {
  type: "primary" | "success" | "warning" | "info" | "danger";
  plain: boolean;
} {
  if (/划拨|撤销|删除|拒收|退回|取消|强制下线/.test(action))
    return { type: "danger", plain: false };
  if (/签收|检测|封箱|采样中|已采样/.test(action)) return { type: "success", plain: false };
  if (
    /权限|角色|设置|策略|密码|改密|上限|改名|修改部门|修改显示|修改数据库|修改天地图|修改公司/.test(
      action
    )
  )
    return { type: "warning", plain: false };
  if (/新增|创建|建单/.test(action)) return { type: "primary", plain: false };
  if (/登录|退出|解锁|解绑|绑定/.test(action)) return { type: "info", plain: false };
  return { type: "info", plain: true };
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
/* #94：32px 密行＋sticky 表头＋12px 字号（沿任务单列表基线；全站 override 的 46px td 收回） */
.log-table {
  --el-table-border-color: var(--el-border-color-extra-light);
}
.log-table :deep(.el-table__body td.el-table__cell) {
  height: 32px;
  padding: 1px 0;
}
.log-table :deep(.cell) {
  padding: 0 8px;
  font-size: 12px;
  line-height: 1.4;
}
.log-table :deep(th.el-table__cell) {
  height: 28px;
  padding: 0;
  font-size: 11px;
  font-weight: 600;
  color: var(--el-text-color-secondary);
  background: var(--el-fill-color-lighter);
}
.log-table :deep(.el-table__body-wrapper) {
  min-height: 120px;
}
.actor {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.org-name {
  margin-left: 6px;
  font-size: 11px;
}
.action-tag {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.target {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.target.inline {
  display: inline;
}
/* 回退态（范围外/已删除/未解析）：灰字，编号靠 tooltip */
.target.fallback {
  color: var(--el-text-color-secondary);
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
/* #94 详情抽屉：差集行（沿 RoleAuditDrawer 视觉）＋键值对表格 */
.detail-diff {
  margin-bottom: 8px;
}
.diff-row {
  padding: 1px 0;
  font-size: 12px;
  line-height: 1.5;
  word-break: break-all;
}
.diff-row .sign {
  margin-right: 4px;
  font-weight: 600;
}
.diff-row.add {
  color: var(--el-color-success-dark-2);
}
.diff-row.del {
  color: var(--el-color-danger);
}
.diff-row.pass {
  color: var(--el-color-primary);
}
.diff-row.range {
  color: var(--el-text-color-regular);
}
.detail-kv {
  width: 100%;
  margin-bottom: 4px;
  font-size: 12px;
  border-collapse: collapse;
}
.detail-kv th,
.detail-kv td {
  padding: 4px 8px;
  vertical-align: top;
  text-align: left;
  word-break: break-all;
  border: 1px solid var(--el-border-color-extra-light);
}
.detail-kv th {
  width: 88px;
  font-weight: 600;
  color: var(--el-text-color-secondary);
  background: var(--el-fill-color-lighter);
}
.raw-toggle {
  padding: 0;
  font-size: 12px;
}
.detail-json {
  max-height: 320px;
  margin: 4px 0 0;
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
