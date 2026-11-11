<template>
  <div class="page-container page-flow runtime-page">
    <PageHeader title="系统日志" subtitle="从异常定位到请求、代码位置与设备接入问题">
      <template #actions>
        <el-switch v-model="autoRefresh" active-text="每15秒刷新" />
        <el-button :loading="loading" @click="search">刷新</el-button>
      </template>
    </PageHeader>
    <el-alert
      v-if="health?.lastFailure || health?.dropped"
      type="warning"
      :closable="false"
      show-icon
      :title="`采集降级：本次服务运行已丢弃 ${health?.dropped || 0} 条。${health?.lastFailure || '达到采集速率上限'}。统计可能不完整。`"
    />
    <div class="metrics">
      <button @click="clearCategory">
        <span>记录总数</span>
        <strong>{{ summary.total || 0 }}</strong>
        <small>当前筛选范围</small>
      </button>
      <button class="danger" @click="filterCategory('error')">
        <span>错误记录</span>
        <strong>{{ summary.errors || 0 }}</strong>
        <small>优先排查异常</small>
      </button>
      <button class="warning" @click="filterCategory('slow')">
        <span>慢请求</span>
        <strong>{{ summary.slow || 0 }}</strong>
        <small>阈值 ≥ {{ health?.slowMs || 2000 }} ms</small>
      </button>
      <button
        @click="
          mode = 'issues';
          search();
        "
      >
        <span>不同问题</span>
        <strong>{{ summary.issues || 0 }}</strong>
        <small>按来源和错误特征合并</small>
      </button>
    </div>
    <el-card shadow="never" class="filters">
      <div class="filter-row">
        <el-radio-group v-model="preset" @change="setRange">
          <el-radio-button value="1">近1小时</el-radio-button>
          <el-radio-button value="24">近24小时</el-radio-button>
          <el-radio-button value="168">近7天</el-radio-button>
        </el-radio-group>
        <el-date-picker
          v-model="range"
          type="datetimerange"
          range-separator="至"
          start-placeholder="开始时间"
          end-placeholder="结束时间"
          :clearable="false"
          @change="preset = ''"
        />
      </div>
      <div class="filter-grid">
        <el-select
          v-model="filters.kind"
          placeholder="全部异常类型"
          clearable
          aria-label="异常类型"
        >
          <el-option v-for="(name, key) in kinds" :key="key" :label="name" :value="key" />
        </el-select>
        <el-select v-model="filters.level" placeholder="全部严重程度" clearable>
          <el-option label="错误" value="error" />
          <el-option label="警告" value="warn" />
          <el-option label="信息" value="info" />
        </el-select>
        <el-select v-model="filters.source" placeholder="全部来源" clearable>
          <el-option v-for="(name, key) in sources" :key="key" :label="name" :value="key" />
        </el-select>
        <el-input
          v-model="filters.q"
          placeholder="错误描述 / 接口 / 错误码"
          clearable
          @keyup.enter="search"
        />
        <el-input
          v-model="filters.requestId"
          placeholder="完整请求编号"
          clearable
          @keyup.enter="search"
        />
        <el-input
          v-model="filters.deviceId"
          placeholder="设备编号，如 BOX-001"
          clearable
          @keyup.enter="search"
        />
        <el-input-number
          v-model="minDuration"
          :min="0"
          :max="3600000"
          :controls="false"
          placeholder="最低耗时 ms"
          aria-label="最低耗时毫秒"
        />
        <el-input-number
          v-model="statusCode"
          :min="100"
          :max="599"
          :controls="false"
          placeholder="HTTP状态码"
          aria-label="HTTP状态码"
        />
        <el-checkbox v-model="excludeAuth">隐藏登录过期记录</el-checkbox>
        <div class="actions">
          <el-button type="primary" @click="search">查询</el-button>
          <el-button @click="reset">重置</el-button>
        </div>
      </div>
    </el-card>
    <el-card shadow="never">
      <div class="results-head">
        <el-radio-group v-model="mode" @change="search">
          <el-radio-button value="issues">问题汇总</el-radio-button>
          <el-radio-button value="events">日志明细</el-radio-button>
        </el-radio-group>
        <el-select
          v-if="mode === 'issues'"
          v-model="sort"
          aria-label="问题排序"
          style="width: 160px"
          @change="search"
        >
          <el-option label="最近发生优先" value="recent" />
          <el-option label="出现次数优先" value="count" />
          <el-option label="耗时最长优先" value="duration" />
        </el-select>
        <el-button v-if="filters.fingerprint" @click="backToIssues">返回问题汇总</el-button>
        <small>{{ updatedAt ? `更新于 ${time(updatedAt)}` : "等待查询" }} · 每页50条</small>
      </div>
      <div v-if="filters.fingerprint || filters.kind" class="active-filter">
        <el-tag
          closable
          @close="
            filters.fingerprint = '';
            filters.kind = '';
            search();
          "
        >
          {{ filters.fingerprint ? "仅显示所选问题" : kinds[filters.kind] || filters.kind }}
        </el-tag>
      </div>
      <el-alert v-if="loadError" :title="loadError" type="error" show-icon :closable="false" />
      <el-table
        v-loading="loading"
        :data="list"
        :row-key="mode === 'issues' ? 'fingerprint' : 'id'"
        stripe
        @row-click="openRow"
      >
        <el-table-column label="级别 / 来源" width="140">
          <template #default="{ row }">
            <el-tag
              :type="row.level === 'error' ? 'danger' : row.level === 'warn' ? 'warning' : 'info'"
              size="small"
            >
              {{ levels[row.level] }}
            </el-tag>
            <div class="sub">{{ sources[row.source] || row.source }}</div>
          </template>
        </el-table-column>
        <el-table-column label="问题" min-width="330">
          <template #default="{ row }">
            <div class="problem">{{ row.message }}</div>
            <div class="sub mono">
              {{ row.method }} {{ row.path || kinds[row.kind] || row.kind }}
            </div>
          </template>
        </el-table-column>
        <el-table-column v-if="mode === 'issues'" label="出现次数" width="100">
          <template #default="{ row }">
            <b>{{ row.occurrences }}</b>
          </template>
        </el-table-column>
        <el-table-column :label="mode === 'issues' ? '最长 / 平均耗时' : '处理耗时'" width="160">
          <template #default="{ row }">
            <span
              :class="{
                slow:
                  (mode === 'issues' ? row.maxDuration : row.duration) >= (health?.slowMs || 2000),
              }"
            >
              {{ ms(mode === "issues" ? row.maxDuration : row.duration) }}
            </span>
            <div v-if="mode === 'issues'" class="sub">平均 {{ ms(row.avgDuration) }}</div>
          </template>
        </el-table-column>
        <el-table-column :label="mode === 'issues' ? '最近 / 首次发生' : '发生时间'" width="205">
          <template #default="{ row }">
            {{ time(row.lastTime || row.time) }}
            <div v-if="mode === 'issues'" class="sub">首次 {{ time(row.firstTime) }}</div>
          </template>
        </el-table-column>
        <el-table-column label="状态 / 错误码" width="150">
          <template #default="{ row }">
            {{ row.status ?? "—" }}
            <div class="sub">{{ row.code || "—" }}</div>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="150" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click.stop="openRow(row)">
              {{ mode === "issues" ? "查看明细" : "详情" }}
            </el-button>
            <el-button
              v-if="mode === 'issues' && row.latestId"
              link
              type="primary"
              @click.stop="openLatest(row)"
            >
              最近一条
            </el-button>
          </template>
        </el-table-column>
        <template #empty>
          <el-empty description="当前范围没有记录，可调整时间或筛选条件" :image-size="70" />
        </template>
      </el-table>
      <footer class="pager">
        <small>
          第 {{ page }} 页 · {{ mode === "issues" ? "同类错误合并展示" : "按发生时间倒序" }}
        </small>
        <div>
          <el-button :disabled="page <= 1 || loading" @click="previous">上一页</el-button>
          <el-button :disabled="!hasMore || loading" @click="next">下一页</el-button>
        </div>
      </footer>
    </el-card>
    <p class="footnote">
      默认保留 {{ health?.retentionDays || 30 }} 天、最多
      {{ (health?.maxRows || 100000).toLocaleString() }}
      条，先到上限先清理。普通成功请求不记录。前端需登录且网络可达才会上报；历史异常无法补采。时间按浏览器本地时区显示。
    </p>
    <el-drawer v-model="drawer" title="异常详情" size="min(760px, 95vw)">
      <el-alert v-if="detailError" :title="detailError" type="error" :closable="false" />
      <div v-if="detail" v-loading="detailLoading">
        <el-tag
          :type="detail.level === 'error' ? 'danger' : detail.level === 'warn' ? 'warning' : 'info'"
        >
          {{ levels[detail.level] }} · {{ sources[detail.source] }}
        </el-tag>
        <h3 class="detail-title">{{ detail.message }}</h3>
        <el-descriptions :column="2" border>
          <el-descriptions-item label="发生时间" :span="2">
            {{ time(detail.time) }}
          </el-descriptions-item>
          <el-descriptions-item label="处理耗时">{{ ms(detail.duration) }}</el-descriptions-item>
          <el-descriptions-item label="HTTP状态 / 错误码">
            {{ detail.status ?? "—" }} / {{ detail.code || "—" }}
          </el-descriptions-item>
          <el-descriptions-item label="来源">{{ sources[detail.source] }}</el-descriptions-item>
          <el-descriptions-item label="类型">
            {{ kinds[detail.kind] || detail.kind }}
          </el-descriptions-item>
          <el-descriptions-item label="路径" :span="2">
            <span class="break">{{ detail.method }} {{ detail.path || "—" }}</span>
          </el-descriptions-item>
          <el-descriptions-item label="请求编号" :span="2">
            <span class="break mono">{{ detail.requestId }}</span>
          </el-descriptions-item>
          <el-descriptions-item label="操作者编号">
            {{ detail.actorId || "—" }}
          </el-descriptions-item>
          <el-descriptions-item label="关联设备">{{ detail.deviceId || "—" }}</el-descriptions-item>
          <el-descriptions-item label="服务版本" :span="2">
            {{ detail.release || "未标记版本" }}
          </el-descriptions-item>
        </el-descriptions>
        <p class="footnote">
          {{
            detail.source === "frontend"
              ? "浏览器耗时包含网络传输，可能和服务端耗时不同。"
              : "接口耗时为服务端从收到请求到结束响应的时间，包含排队与依赖等待。"
          }}
        </p>
        <div class="actions">
          <el-button :disabled="!detail.requestId" @click="related">同一请求相关记录</el-button>
          <el-button v-if="canDetail" @click="copy">复制脱敏排障信息</el-button>
        </div>
        <h4>异常堆栈</h4>
        <pre class="stack">{{
          canDetail
            ? detail.stack || "该记录没有抛出堆栈（业务拒绝、慢请求或连接中断可无堆栈）"
            : "需要「查看及复制脱敏堆栈」权限"
        }}</pre>
        <p class="footnote">
          不采集请求正文、认证头、Cookie 或完整查询参数；复制前仍请确认不含业务敏感信息。
        </p>
      </div>
    </el-drawer>
  </div>
</template>
<script setup lang="ts">
import PageHeader from "@/components/biz/PageHeader.vue";
import LogAPI, { type LogItem, type LogPage } from "@/api/system/runtime-log";
import { useUserStore } from "@/stores";
defineOptions({ name: "SystemRuntimeLog" });
const sources: Record<string, string> = {
  http: "服务端接口",
  frontend: "前端页面",
  tcp: "设备接入",
  database: "数据库",
  service: "后台服务",
  process: "进程 / 启动",
};
const levels: Record<string, string> = { error: "错误", warn: "警告", info: "信息" };
const kinds: Record<string, string> = {
  auth: "登录过期 / 会话失效",
  exception: "异常抛出",
  request_failed: "请求失败",
  slow: "慢请求",
  aborted: "请求中断",
  startup: "启动",
  fatal: "进程异常退出",
  ingest: "上报处理",
  frame: "报文切帧",
  socket: "连接异常",
  vue: "页面渲染",
  promise: "未处理的异步错误",
  resource: "静态资源",
  uplink_write: "上报写入",
  event: "事件处理",
  geocoder: "地址解析",
};
const canDetail = computed(() => useUserStore().userInfo.perms?.includes("sys:runtime-log:detail"));
const mode = ref("issues"),
  preset = ref("24"),
  range = ref<[Date, Date]>([new Date(Date.now() - 86400000), new Date()]);
const filters = reactive({
  level: "",
  source: "",
  q: "",
  requestId: "",
  deviceId: "",
  kind: "",
  fingerprint: "",
});
const minDuration = ref<number>(),
  list = ref<LogItem[]>([]),
  loading = ref(false),
  loadError = ref(""),
  page = ref(1),
  hasMore = ref(false),
  updatedAt = ref(0);
const sort = ref("recent"),
  statusCode = ref<number>(),
  excludeAuth = ref(true),
  detailError = ref("");
const summary = ref<LogPage["summary"]>({
    total: 0,
    errors: 0,
    slow: 0,
    issues: 0,
    maxDuration: null,
  }),
  health = ref<LogPage["health"]>();
const cursors = ref<Array<{ time: number; id: string } | null>>([null]);
let nextCursor: { time: number; id: string } | null = null,
  sequence = 0;
const drawer = ref(false),
  detailLoading = ref(false),
  detail = ref<LogItem>(),
  autoRefresh = ref(false);
function time(n?: number) {
  return n
    ? `${new Date(n).toLocaleString("zh-CN", { hour12: false })}.${String(new Date(n).getMilliseconds()).padStart(3, "0")}`
    : "—";
}
function ms(n?: number | null) {
  return n == null ? "—" : `${n.toLocaleString()} ms`;
}
function setRange() {
  range.value = [new Date(Date.now() - Number(preset.value) * 3600000), new Date()];
  search();
}
async function load() {
  const request = ++sequence;
  loading.value = true;
  loadError.value = "";
  try {
    if (!range.value || range.value[1].getTime() - range.value[0].getTime() > 31 * 86400000)
      throw new Error("请选择不超过31天的时间范围");
    const cursor = cursors.value[page.value - 1];
    const data = await LogAPI.page({
      ...filters,
      from: range.value[0].getTime(),
      to: range.value[1].getTime(),
      minDuration: minDuration.value,
      status: statusCode.value,
      sort: sort.value,
      excludeAuth: String(excludeAuth.value),
      group: String(mode.value === "issues"),
      page: page.value,
      cursorTime: cursor?.time,
      cursorId: cursor?.id,
    });
    if (request !== sequence) return;
    list.value = data.list;
    summary.value = data.summary;
    health.value = data.health;
    nextCursor = data.nextCursor || null;
    hasMore.value = mode.value === "issues" ? !!data.hasMore : !!nextCursor;
    updatedAt.value = Date.now();
  } catch (e) {
    if (request === sequence) {
      loadError.value = e instanceof Error ? e.message : "查询失败，请重试";
      list.value = [];
      hasMore.value = false;
    }
  } finally {
    if (request === sequence) loading.value = false;
  }
}
function search() {
  if (preset.value)
    range.value = [new Date(Date.now() - Number(preset.value) * 3600000), new Date()];
  page.value = 1;
  cursors.value = [null];
  void load();
}
function reset() {
  Object.assign(filters, {
    level: "",
    source: "",
    q: "",
    requestId: "",
    deviceId: "",
    kind: "",
    fingerprint: "",
  });
  minDuration.value = undefined;
  statusCode.value = undefined;
  excludeAuth.value = true;
  sort.value = "recent";
  preset.value = "24";
  setRange();
}
function clearCategory() {
  filters.level = "";
  filters.kind = "";
  search();
}
function filterCategory(k: string) {
  filters.level = k === "error" ? "error" : "";
  filters.kind = k === "slow" ? "slow" : "";
  search();
}
function next() {
  if (mode.value === "events") {
    cursors.value = cursors.value.slice(0, page.value);
    cursors.value.push(nextCursor);
  }
  page.value++;
  void load();
}
function previous() {
  page.value--;
  void load();
}
let detailSequence = 0;
watch(drawer, (open) => {
  if (!open) {
    detailSequence++;
    detailLoading.value = false;
  }
});
async function loadDetail(id: string, initial?: LogItem) {
  const request = ++detailSequence;
  drawer.value = true;
  detail.value = initial;
  detailError.value = "";
  detailLoading.value = canDetail.value;
  if (!canDetail.value) return;
  try {
    const value = await LogAPI.detail(id);
    if (request === detailSequence) detail.value = value;
  } catch {
    if (request === detailSequence) detailError.value = "详情读取失败或日志已过保留期";
  } finally {
    if (request === detailSequence) detailLoading.value = false;
  }
}
async function openRow(row: unknown) {
  const item = row as LogItem;
  if (mode.value === "issues") {
    filters.fingerprint = item.fingerprint;
    mode.value = "events";
    search();
    return;
  }
  await loadDetail(item.id, item);
}
function backToIssues() {
  filters.fingerprint = "";
  mode.value = "issues";
  search();
}
async function openLatest(row: unknown) {
  const item = row as LogItem;
  if (!item.latestId) return;
  if (!canDetail.value) {
    await openRow(item);
    return;
  }
  await loadDetail(item.latestId);
}
function related() {
  if (!detail.value) return;
  filters.requestId = detail.value.requestId;
  filters.fingerprint = "";
  filters.source = "";
  filters.kind = "";
  filters.level = "";
  filters.q = "";
  filters.deviceId = "";
  statusCode.value = undefined;
  excludeAuth.value = false;
  minDuration.value = undefined;
  mode.value = "events";
  drawer.value = false;
  search();
}
async function copy() {
  if (!detail.value) return;
  try {
    await navigator.clipboard.writeText(JSON.stringify(detail.value, null, 2));
    ElMessage.success("已复制脱敏排障信息");
  } catch {
    ElMessage.warning("浏览器不允许复制，请手动选择文本");
  }
}
let timer: ReturnType<typeof setInterval> | undefined;
function start() {
  if (timer) return;
  timer = setInterval(() => {
    if (
      autoRefresh.value &&
      page.value === 1 &&
      !drawer.value &&
      !loading.value &&
      document.visibilityState === "visible"
    ) {
      if (preset.value)
        range.value = [new Date(Date.now() - Number(preset.value) * 3600000), new Date()];
      void load();
    }
  }, 15000);
}
function stop() {
  clearInterval(timer);
  timer = undefined;
}
onMounted(() => {
  void load();
  start();
});
onActivated(start);
onDeactivated(stop);
onUnmounted(stop);
</script>
<style scoped>
.runtime-page {
  gap: var(--page-gap);
}
.page-heading,
.actions,
.results-head,
.pager,
.filter-row {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: center;
}
.page-heading,
.results-head,
.pager {
  justify-content: space-between;
}
h2 {
  margin: 0;
  font-size: 23px;
}
h3 {
  font-size: 18px;
}
.page-heading p,
.footnote,
.sub,
.results-head small,
.pager small {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.page-heading p {
  margin: 7px 0 0;
  font-size: 13px;
}
.metrics {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: var(--page-gap);
}
.metrics button {
  padding: 16px 20px;
  color: var(--el-text-color-primary);
  text-align: left;
  cursor: pointer;
  background: var(--el-bg-color);
  border: 1px solid var(--card-border);
  border-radius: var(--card-radius);
}
.metrics strong {
  display: block;
  margin: 8px 0;
  font-size: 30px;
}
.metrics small {
  color: var(--el-text-color-secondary);
}
.metrics .danger strong {
  color: var(--el-color-danger);
}
.metrics .warning strong,
.slow {
  color: var(--el-color-warning);
}
.filter-grid {
  display: grid;
  grid-template-columns: 160px 160px minmax(220px, 1fr) minmax(200px, 1fr);
  gap: 12px;
  margin-top: 14px;
}
.filter-grid .el-input-number {
  width: 100%;
}
.results-head {
  margin-bottom: 16px;
}
.problem {
  display: -webkit-box;
  overflow: hidden;
  -webkit-line-clamp: 2;
  line-height: 1.5;
  overflow-wrap: anywhere;
  -webkit-box-orient: vertical;
}
.sub {
  margin-top: 5px;
  overflow-wrap: anywhere;
}
.mono {
  font-family: ui-monospace, Consolas, monospace;
}
.pager {
  margin-top: 18px;
}
.footnote {
  margin: 0;
  line-height: 1.7;
}
.stack {
  max-height: 420px;
  padding: 16px;
  overflow: auto;
  font-size: 12px;
  line-height: 1.65;
  color: #dce6f6;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
  background: #111c2f;
  border-radius: 8px;
}
.break,
.detail-title {
  overflow-wrap: anywhere;
}
.detail-title {
  margin: 16px 0;
}
.active-filter {
  margin-bottom: 12px;
}
.el-descriptions + .footnote {
  margin: 14px 0;
}
.runtime-page :deep(.el-table__row) {
  cursor: pointer;
}
@media (max-width: 1100px) {
  .filter-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
@media (max-width: 650px) {
  .runtime-page {
    padding: 10px;
  }
  .metrics {
    grid-template-columns: repeat(2, 1fr);
  }
  .filter-grid {
    grid-template-columns: 1fr;
  }
  .filter-row :deep(.el-date-editor) {
    width: 100%;
  }
}
</style>
