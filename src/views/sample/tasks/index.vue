<template>
  <div class="page-container page-flow">
    <PageHeader title="任务单">
      <template #meta>
        三类单据的进度与到箱情况；批量划拨见「调拨单」。
        <el-tooltip placement="bottom" effect="light">
          <template #content>
            <div>采样（仅本地）：待采样→采样中→已封箱（结束，箱留采样单位）</div>
            <div>送检（仅寄送）：待寄出→运送中→待签收→待检测→已检测</div>
            <div>采样后送检＝合并全流，方向按箱归属派生（只读）</div>
            <div>签收后逐台扫码开始检测；待检测/已检测可退回寄出方</div>
          </template>
          <el-icon class="qmark"><QuestionFilled /></el-icon>
        </el-tooltip>
      </template>
      <template #actions>
        <FreshnessMeta
          v-if="pollingEnabled"
          :updated-at="updatedAt"
          :error="error"
          :interval="15000"
        />
        <el-button v-else link type="primary" :icon="Refresh" @click="refresh">刷新</el-button>
        <el-button
          v-if="TASK_CREATE.some((perm) => can(perm))"
          type="primary"
          :icon="Plus"
          @click="router.push('/task/create')"
        >
          创建任务单
        </el-button>
      </template>
    </PageHeader>

    <!-- 失败态≠空态（P2-6）：加载失败给横幅＋重试，数据区另显「未获取数据」，分页不显共 0 条 -->
    <el-alert v-if="error" type="warning" :closable="false" class="fail-banner">
      <div class="fail-line">
        <b>任务单列表加载失败</b>
        <span class="text-muted">{{ error }}</span>
        <el-button link type="primary" class="retry" @click="refresh">重试</el-button>
      </div>
    </el-alert>

    <el-card shadow="never">
      <!-- 批4/D2：11 页签收敛 4 页签；逐态筛选交给「状态」多选下拉（16 态＋划拨两态） -->
      <el-tabs :model-value="tab" class="status-tabs" @tab-change="onTab">
        <el-tab-pane v-for="item in tabs" :key="item.key" :name="item.key">
          <template #label>
            {{ item.label }}
            <span
              v-if="item.count != null"
              class="count"
              :class="{ hot: item.key === 'mine' && mineHot }"
              :title="
                item.key === 'mine'
                  ? `待我处理 ${item.count} ／ 进行中 ${counts.进行中 ?? 0}`
                  : undefined
              "
            >
              {{ item.count }}
            </span>
          </template>
        </el-tab-pane>
      </el-tabs>

      <div class="filter-bar">
        <el-popover
          v-model:visible="statusOpen"
          placement="bottom-start"
          :width="560"
          trigger="click"
          @show="statusDraft = [...statusSelection]"
        >
          <template #reference>
            <button type="button" class="dd-select" :class="{ on: statusSelection.length }">
              <span class="lab">状态</span>
              <span v-if="statusSelection.length" class="val">{{ statusSummary }}</span>
              <span v-else class="text-muted">全部状态</span>
              <span class="caret">▾</span>
            </button>
          </template>
          <div class="dd-head">
            状态多选
            <span class="text-muted">16 态与服务端 counts 同源 · 勾选写入 status</span>
          </div>
          <div class="dd-grid">
            <div v-for="g in statusGroups" :key="g.title" class="dd-group">
              <div class="g-title">{{ g.title }}</div>
              <label
                v-for="s in g.statuses"
                :key="s"
                class="dd-opt"
                :class="{ zero: !(counts[s] ?? 0) }"
              >
                <input v-model="statusDraft" type="checkbox" :value="s" />
                {{ s }}
                <span v-if="g.historical" class="hist">历史</span>
                <span class="n">{{ counts[s] ?? 0 }}</span>
              </label>
            </div>
          </div>
          <div class="dd-foot">
            <span>
              已选
              <b class="num primary">{{ statusDraft.length }}</b>
            </span>
            <el-button link type="primary" @click="statusDraft = []">清空</el-button>
            <span class="text-muted">mine=1 时可组合状态</span>
            <el-button type="primary" size="small" class="ok" @click="applyStatus">确定</el-button>
          </div>
        </el-popover>

        <el-popover
          v-model:visible="kindOpen"
          placement="bottom-start"
          :width="360"
          trigger="click"
        >
          <template #reference>
            <button type="button" class="dd-select" :class="{ on: query.kind }">
              <span class="lab">类型</span>
              <span v-if="query.kind" class="val">{{ kindOptionLabel(query.kind) }}</span>
              <span v-else class="text-muted">三类（默认）</span>
              <span class="caret">▾</span>
            </button>
          </template>
          <div class="dd-head">
            类型
            <span class="text-muted">服务端 kind 过滤 · 划拨两态切换状态词表</span>
          </div>
          <label
            v-for="opt in KIND_FILTER_OPTIONS"
            :key="opt.value"
            class="type-opt"
            :class="{ sel: query.kind === opt.value }"
          >
            <input
              type="radio"
              name="task-kind-filter"
              :checked="query.kind === opt.value"
              @change="onKind(opt.value)"
            />
            {{ opt.label }}
            <span class="d">{{ opt.desc }}</span>
          </label>
          <div class="type-sep">划拨时状态＝已划拨/已撤销；历史调拨只读收尾（P2-2）</div>
        </el-popover>

        <el-tree-select
          v-model="query.orgId"
          :data="orgOptions"
          check-strictly
          filterable
          clearable
          placeholder="涉及单位"
          style="width: 160px"
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
          :placeholder="
            canImei ? '单号、任务名、箱子名称或 IMEI' : '单号、任务名、箱子名称（IMEI 需权限）'
          "
          :title="canImei ? undefined : 'IMEI 检索需设备标识权限（D7，与箱子列表同口径）'"
          clearable
          style="width: 360px"
          @keyup.enter="reload"
          @clear="reload"
        >
          <template #append><el-button @click="reload">搜索</el-button></template>
        </el-input>
      </div>

      <!-- 可关闭筛选 chips（桶 chip 沿用 R22；boxId 不打印 IMEI，P2-12） -->
      <div v-if="hasChips" class="chips">
        <el-tag v-if="query.bucket" closable type="warning" @close="clearBucket">
          桶：{{ bucketLabel }}
        </el-tag>
        <el-tag v-for="s in statusSelection" :key="s" closable @close="removeStatus(s)">
          状态：{{ s }}
        </el-tag>
        <el-tag v-if="query.kind" closable @close="clearKind">
          类型：{{ kindOptionLabel(query.kind) }}
        </el-tag>
        <el-tag v-if="query.orgId" closable type="info" @close="clearOrg">
          单位：{{ orgLabel }}
        </el-tag>
        <el-tag v-if="query.from || query.to" closable type="info" @close="clearDates">
          创建：{{ query.from || "…" }} ~ {{ query.to || "…" }}
        </el-tag>
        <el-tag v-if="query.q" closable type="info" @close="clearQ">关键字：{{ query.q }}</el-tag>
        <el-tag v-if="query.boxId" closable type="info" :title="query.boxId" @close="clearBox">
          只看该箱子
        </el-tag>
        <el-button v-if="filtered" link type="primary" @click="resetAll">清除筛选</el-button>
      </div>

      <div v-if="!failedEmpty" class="result-bar">
        筛选后
        <b>{{ total }}</b>
        单 / 范围总数
        <b>{{ counts.全部 ?? 0 }}</b>
        单
        <span class="text-muted">counts 同源，不随状态筛选变</span>
        <span class="text-muted sort-note">
          排序：{{ query.sort === "created" ? "创建时间 ↓" : "最近更新 ↓" }}
        </span>
      </div>

      <el-table
        v-loading="loading"
        :data="rows"
        class="task-table"
        max-height="calc(100vh - 352px)"
        :row-class-name="rowClass"
        @row-click="(row: PolicyTask) => router.push(`/task/detail/${row.id}`)"
      >
        <template #empty>
          <div v-if="failedEmpty" class="state-box">
            <div class="state-title">未获取数据</div>
            <div class="text-muted">加载失败 · 指数退避自动重试 · 也可在上方横幅手动重试</div>
          </div>
          <div v-else class="state-box">
            <div class="state-title">
              {{ tab === "mine" ? "没有等你处理的任务" : "没有符合条件的任务" }}
            </div>
            <div class="text-muted">试试清除筛选或切换页签</div>
            <el-button v-if="filtered" size="small" class="state-btn" @click="resetAll">
              清除筛选
            </el-button>
          </div>
        </template>
        <el-table-column label="任务" min-width="180">
          <template #default="{ row }">
            <div class="l1">
              <el-tag
                size="small"
                class="mini kind"
                :type="kindTone(kindLabel(row))"
                effect="plain"
              >
                {{ kindLabel(row) }}
              </el-tag>
              <el-tag
                v-if="row.trip && kindLabel(row) === '采样后送检'"
                size="small"
                class="mini"
                :type="row.trip === '双向' ? 'warning' : 'info'"
                effect="plain"
                :title="
                  row.trip === '双向'
                    ? '箱在检测站：检测站寄出→分公司采样→寄回检测站'
                    : '箱在分公司/总部：本地采样后寄检测站'
                "
              >
                {{ row.trip }}
              </el-tag>
              <el-tag
                v-else-if="isLocalSample(row)"
                size="small"
                class="mini"
                type="info"
                effect="plain"
              >
                仅本地
              </el-tag>
              <a
                class="id-link mono"
                :href="`#/task/detail/${row.id}`"
                :title="`单号链接：#/task/detail/${row.id}（中键/新窗口可达）`"
                @click.stop
              >
                {{ row.id }}
              </a>
              <el-tooltip v-if="row.recordVideo" content="分公司采样现场开箱时录像" placement="top">
                <el-icon class="video"><VideoCamera /></el-icon>
              </el-tooltip>
            </div>
            <div class="l2" :title="row.name">{{ row.name }}</div>
          </template>
        </el-table-column>
        <el-table-column label="流转方向" min-width="130">
          <template #default="{ row }">
            <div v-if="dirOf(row).local" class="l1 dir none">本地采样 · 不寄送</div>
            <div v-else class="l1 dir" :title="dirOf(row).title">
              <span class="from">{{ dirOf(row).from }}</span>
              <span class="a">→</span>
              <span class="to">{{ dirOf(row).to }}</span>
            </div>
            <div class="l2">{{ dirOf(row).hint }}</div>
          </template>
        </el-table-column>
        <el-table-column label="采样/寄出单位" min-width="110">
          <template #default="{ row }">
            <div
              class="l1"
              :title="kindLabel(row) === '送检' ? '送检单 org＝寄出方（P2-3）' : undefined"
            >
              {{ row.org || "—" }}{{ kindLabel(row) === "送检" && row.org ? "（寄出）" : "" }}
            </div>
            <div class="l2">{{ row.placeAt?.address || row.place || "—" }}</div>
          </template>
        </el-table-column>
        <el-table-column label="箱数" width="48" align="center">
          <template #default="{ row }">{{ row.boxIds?.length ?? 0 }}</template>
        </el-table-column>
        <el-table-column label="进度 · 状态" min-width="170">
          <template #default="{ row }">
            <div class="l1">
              <span class="status" :class="`tone-${toneOf(row)}`">
                <i />
                {{ row.status }}
              </span>
              <el-tag
                size="small"
                class="mini"
                effect="plain"
                :type="
                  ended(row) && !ENDED_VOID.includes(row.status)
                    ? 'success'
                    : ended(row)
                      ? 'info'
                      : 'primary'
                "
                :class="{ 'tag-done': doneRow(row) }"
              >
                {{ endTagText(row) }}
              </el-tag>
              <span class="text-muted">{{ stepText(row) }}</span>
            </div>
            <div class="l2 subline">
              <span
                v-if="stepOf(row).index >= 0"
                class="steps"
                :class="{
                  ended: ended(row),
                  'ended-ok': ended(row) && !ENDED_VOID.includes(row.status),
                }"
                :title="progressText(row)"
              >
                <i
                  v-for="n in stepOf(row).total"
                  :key="n"
                  :class="{ done: n - 1 < stepOf(row).index, now: n - 1 === stepOf(row).index }"
                />
              </span>
              <span v-else-if="ended(row)" class="void-note">
                {{
                  row.kind === "划拨" || row.kind === "调拨"
                    ? "归属转移 · 无物流步"
                    : "作废终态 · 无步条"
                }}
              </span>
              <span
                v-if="row.arrival"
                class="arrival"
                :class="{ on: row.arrival.near === row.arrival.total }"
              >
                {{ row.arrival.near }}/{{ row.arrival.total }} 台已到{{ row.arrival.role }}附近
              </span>
              <span v-if="row.openOver" class="over">{{ row.openOver }} 台开箱超限</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="操作" min-width="180">
          <template #default="{ row }">
            <!-- 按钮＝服务端 task.actions（kind+status+参与方），前端不自造；已结束行无动作 chip -->
            <div v-if="(row.actions || []).length" class="ops">
              <template v-if="ended(row)">
                <el-button
                  v-for="to in row.actions"
                  :key="to"
                  link
                  type="danger"
                  :title="`终态单仅保留退回入口（P2-10）`"
                  @click.stop="openAction(row, to)"
                >
                  {{ TASK_ACTIONS[to] || to }}
                </el-button>
              </template>
              <template v-else>
                <el-button
                  v-if="primaryAction(row)"
                  type="primary"
                  size="small"
                  @click.stop="openAction(row, primaryAction(row))"
                >
                  {{ TASK_ACTIONS[primaryAction(row)] || primaryAction(row) }}
                </el-button>
                <el-button
                  v-for="to in secondaryActions(row)"
                  :key="to"
                  link
                  :type="to === '已取消' ? 'primary' : to === '强制签收' ? 'warning' : 'danger'"
                  :title="to === '已取消' ? '取消任务：备注选填' : undefined"
                  @click.stop="openAction(row, to)"
                >
                  {{ to === "已取消" ? "取消" : TASK_ACTIONS[to] || to }}
                </el-button>
              </template>
            </div>
            <span v-else class="text-muted">—</span>
          </template>
        </el-table-column>
        <el-table-column min-width="96">
          <template #header>
            <button
              type="button"
              class="sort-th"
              :class="{ sorted: query.sort !== 'created' }"
              title="按最近流转时间倒序（sample_task_log MAX(created_at)，D4）"
              @click="setSort('updated')"
            >
              最近更新
              <span class="ico">{{ query.sort === "created" ? "⇅" : "▼" }}</span>
            </button>
          </template>
          <template #default="{ row }">
            <div class="l1 num">
              <TimeText :value="row.updatedAt || row.createdAt" mode="ago" />
            </div>
            <div class="l2 num">
              <TimeText :value="row.updatedAt || row.createdAt" mode="short" />
            </div>
          </template>
        </el-table-column>
        <el-table-column min-width="96">
          <template #header>
            <button
              type="button"
              class="sort-th"
              :class="{ sorted: query.sort === 'created' }"
              title="切回创建时间倒序"
              @click="setSort('created')"
            >
              创建
              <span class="ico">{{ query.sort === "created" ? "▼" : "⇅" }}</span>
            </button>
          </template>
          <template #default="{ row }">
            <div class="l1">{{ row.createdBy || "—" }}</div>
            <div class="l2 num"><TimeText :value="row.createdAt" mode="short" /></div>
          </template>
        </el-table-column>
      </el-table>
      <DataPager
        v-model:page="query.page"
        v-model:page-size="query.pageSize"
        :total="failedEmpty ? null : total"
        :sizes="[20, 50, 100]"
      />
    </el-card>

    <TaskActionDialog v-model="action.open" :task="action.task" :to="action.to" @done="refresh" />
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: "SampleTasks" });

import { Plus, QuestionFilled, Refresh, Search, VideoCamera } from "@element-plus/icons-vue";
import type { OptionItem } from "@/api/common";
import API, { type PolicyTask, type TaskCounts, type TaskQuery } from "@/api/sample/report-policy";
import DeptAPI from "@/api/system/dept";
import DataPager from "@/components/biz/DataPager.vue";
import FreshnessMeta from "@/components/biz/FreshnessMeta.vue";
import PageHeader from "@/components/biz/PageHeader.vue";
import TimeText from "@/components/biz/TimeText.vue";
import { usePerm } from "@/composables/usePerm";
import { useTaskListPolling } from "@/composables/useTaskListPolling";
import { hasActiveFilter, useUrlQuery } from "@/composables/useUrlQuery";
import { taskToneFor } from "@/utils/tone";
import TaskActionDialog from "./TaskActionDialog.vue";
import {
  isEndedFor,
  isLocalSample,
  KIND_FILTER_OPTIONS,
  STATUS_FILTER_KEYS,
  statusGroupsFor,
  stepsOf,
  TASK_ACTIONS,
} from "./status";
import { ENDED_VOID, kindLabel, kindTone } from "../doc-flow";
import { IMEI_PERMS, TASK_CREATE } from "../data";

/**
 * 任务单列表（R23 批4/5/6）：4 页签＋状态/类型下拉＋可关闭 chips；列含流转方向与最近更新排序；
 * 操作列按钮来自服务端 actions，行内推进走 TaskActionDialog；失败态≠空态；15s 静默轮询仅进行中/待我处理。
 * 筛选都写在地址栏里（mine/bucket/status/kind/sort/orgId/日期/q/boxId）。
 */
const router = useRouter();
const route = useRoute();
const can = usePerm();
// D7（R22 批3）：设备标识三项齐全才能按 IMEI 检索（与箱子页 canImei 同口径）；否则 placeholder 说明只能搜名称。
const canImei = computed(() => IMEI_PERMS.every((perm) => can(perm)));
const QUERY_DEFAULTS = {
  status: "进行中",
  mine: "",
  bucket: "",
  kind: "",
  sort: "",
  orgId: "",
  from: "",
  to: "",
  q: "",
  boxId: "",
  page: 1,
  pageSize: 20,
};
const { state: query, sync, reset } = useUrlQuery(QUERY_DEFAULTS);
const rows = ref<PolicyTask[]>([]);
const total = ref(0);
const counts = ref<Partial<TaskCounts>>({});
const orgOptions = ref<OptionItem[]>([]);
const dates = ref<string[] | null>(query.from && query.to ? [query.from, query.to] : null);

/**
 * 地址栏外部变化收口（浏览器前进/后退、分享链接、keep-alive 缓存实例与路由提交的竞态）：
 * fullPath 变化时把路由 query 与本页状态做差集，不一致才采纳并重载——
 * 自己 sync() 写回地址栏时两者相等，不会回环；缓存实例被重新激活时状态以地址栏为准。
 */
watch(
  () => route.fullPath,
  () => {
    let changed = false;
    for (const [key, def] of Object.entries(QUERY_DEFAULTS)) {
      const raw = route.query[key];
      const value = Array.isArray(raw) ? raw[0] : raw;
      const next =
        value == null || value === ""
          ? def
          : typeof def === "number"
            ? Number(value) || def
            : String(value);
      if ((query as Record<string, string | number>)[key] !== next) {
        (query as Record<string, string | number>)[key] = next;
        changed = true;
      }
    }
    if (changed) {
      dates.value = query.from && query.to ? [query.from, query.to] : null;
      refresh();
    }
  }
);

// 批4：页签只留 4 个伪态；具体状态（含多选）落「全部」页签＋chips，mine 页签内可与状态组合（P1-4）
const tab = computed(() => {
  if (query.mine === "1") return "mine";
  if (!query.status || query.status === "进行中") return "进行中";
  if (query.status === "已结束") return "已结束";
  return "全部";
});
const statusSelection = computed(() => [
  ...new Set(
    query.status
      .split(",")
      .map((s) => s.trim())
      .filter((s) => STATUS_FILTER_KEYS.includes(s))
  ),
]);
const statusSummary = computed(() =>
  statusSelection.value.length > 1
    ? `${statusSelection.value[0]} +${statusSelection.value.length - 1}`
    : statusSelection.value[0] || ""
);
const statusGroups = computed(() => statusGroupsFor(query.kind));
const statusOpen = ref(false);
const statusDraft = ref<string[]>([]);
const kindOpen = ref(false);

// P2-11：mine badge 只在真子集时标红（全范围角色 mine==进行中 时灰，不再失去信号）
const mineHot = computed(() => (counts.value.mine ?? 0) < (counts.value.进行中 ?? 0));
const tabs = computed(() => [
  { key: "mine", label: "待我处理", count: counts.value.mine },
  { key: "进行中", label: "进行中", count: counts.value.进行中 },
  { key: "已结束", label: "已结束", count: counts.value.已结束 },
  { key: "全部", label: "全部", count: counts.value.全部 },
]);

// D1（R22 批2）：工作台桶 chip 文案，与 home 卡片标题一致；地址栏 bucket= 可关闭（参照箱子页 tile=）。
const BUCKET_LABELS: Record<string, string> = {
  sampling: "采样待推进",
  arrive: "待确认到达",
  sign: "待签收",
  returning: "待接收退回",
  send: "待寄出",
  overLimit: "开箱超限",
};
const bucketLabel = computed(() => BUCKET_LABELS[query.bucket] || query.bucket);
const orgLabel = computed(
  () => orgOptions.value.find((o) => o.value === query.orgId)?.label || query.orgId
);
const kindOptionLabel = (kind: string) =>
  KIND_FILTER_OPTIONS.find((o) => o.value === kind)?.label || kind;
// P2-9：清除判定含结束日期 to 与 kind/具体状态（R22 helper 显式列键）
const filtered = computed(
  () =>
    hasActiveFilter(query, ["orgId", "from", "to", "q", "boxId", "kind"]) ||
    statusSelection.value.length > 0
);
const hasChips = computed(
  () =>
    filtered.value ||
    Boolean(query.bucket) ||
    Boolean(query.boxId) ||
    Boolean(query.orgId) ||
    Boolean(query.from || query.to) ||
    Boolean(query.q)
);

// D8（批6）：15s 静默轮询仅进行中/待我处理；切页签/visibility 隐藏暂停、失败退避、不抢骨架（复用 useOverviewPolling）
const pollingEnabled = computed(() => tab.value === "mine" || tab.value === "进行中");
let seq = 0;
async function load() {
  const mine = ++seq;
  const result = await API.tasks({
    page: query.page,
    pageSize: query.pageSize,
    mine: query.mine === "1" ? "1" : undefined,
    // P1-4：mine=1 也带 status（服务端 mineRows 内存过滤，可组合）；「全部」页签不传 status
    status: query.status === "全部" ? undefined : query.status || undefined,
    // D1：桶参数（与 todo 同谓词）；非法值服务端静默忽略，这里只传已知桶
    bucket: BUCKET_LABELS[query.bucket] ? (query.bucket as TaskQuery["bucket"]) : undefined,
    kind: query.kind || undefined,
    // D4（批5）：默认最近更新；表头可切回创建
    sort: query.sort === "created" ? "created" : "updated",
    orgId: query.orgId || undefined,
    from: query.from || undefined,
    to: query.to || undefined,
    q: query.q.trim() || undefined,
    boxId: query.boxId || undefined,
  });
  if (mine !== seq) return false;
  rows.value = result.list;
  total.value = result.total;
  counts.value = result.counts || {};
  return true;
}
const polling = useTaskListPolling(load, {
  interval: 15000,
  enabled: () => pollingEnabled.value,
});
const { updatedAt, error, loading, refresh } = polling;
// 失败态≠空态：有旧数据时横幅＋黄点标旧；一条都没有时数据区显「未获取数据」、分页不显共 0 条
const failedEmpty = computed(() => Boolean(error.value) && rows.value.length === 0);

function reload() {
  query.page = 1;
  sync();
  refresh();
}
function onTab(name: string | number) {
  const key = String(name);
  query.mine = key === "mine" ? "1" : "";
  query.status = key === "mine" ? "" : key;
  // 切页签即退出桶视图与具体状态选择（桶是「待我处理」的子筛，不挂在别的页签上）
  query.bucket = "";
  reload();
}
function applyStatus() {
  const values = statusDraft.value;
  if (tab.value === "mine") {
    query.status = values.join(",");
  } else {
    // 具体状态落「全部」页签（4 页签只承载伪态）；空选择回「全部」
    query.mine = "";
    query.bucket = "";
    query.status = values.length ? values.join(",") : "全部";
  }
  statusOpen.value = false;
  reload();
}
function removeStatus(s: string) {
  const values = statusSelection.value.filter((x) => x !== s);
  query.status = tab.value === "mine" ? values.join(",") : values.join(",") || "全部";
  reload();
}
function onKind(value: string) {
  query.kind = value;
  // 类型切换换状态词表（划拨两态 vs 16 态）：清掉跨词表的具体状态选择
  if (statusSelection.value.length) query.status = tab.value === "mine" ? "" : "全部";
  kindOpen.value = false;
  reload();
}
function clearKind() {
  query.kind = "";
  reload();
}
function onDates(value: string[] | null) {
  query.from = value?.[0] || "";
  query.to = value?.[1] || "";
  reload();
}
function clearDates() {
  dates.value = null;
  query.from = "";
  query.to = "";
  reload();
}
function clearOrg() {
  query.orgId = "";
  reload();
}
function clearQ() {
  query.q = "";
  reload();
}
function clearBox() {
  query.boxId = "";
  reload();
}
function clearBucket() {
  query.bucket = "";
  reload();
}
function resetAll() {
  reset();
  dates.value = null;
  refresh();
}
function setSort(value: "updated" | "created") {
  query.sort = value === "updated" ? "" : value;
  reload();
}
watch(
  () => [query.page, query.pageSize],
  () => {
    sync();
    refresh();
  }
);

// 表格行在模板里是 DefaultRow，按普通对象收
type TaskRow = Record<string, unknown> & { kind?: string; status?: string };
// 结束口径和服务端流程校验同一份（R23 含本地采样已封箱终态）
const ended = (row: TaskRow) => isEndedFor(row as Record<string, unknown>);
/** 灰绿 done 行：仅本地采样已封箱（kind 感知，与详情 endedToneFor 同口径；全站无 done token，页内局部定义） */
const doneRow = (row: TaskRow) => isLocalSample(row) && row.status === "已封箱";
function toneOf(row: TaskRow) {
  return doneRow(row) ? "done" : taskToneFor(row);
}
function rowClass({ row }: { row: TaskRow }) {
  return doneRow(row) ? "row-done" : "";
}
function stepOf(row: TaskRow) {
  const steps = stepsOf(row);
  return { index: steps.indexOf(String(row.status)), total: steps.length };
}
function stepText(row: TaskRow) {
  const { index, total } = stepOf(row);
  return index >= 0 ? `第 ${index + 1}/${total} 步` : "";
}
function progressText(row: TaskRow) {
  const { index, total } = stepOf(row);
  if (index >= 0) return `第 ${index + 1}/${total} 步`;
  // 已取消、已拒收不在步骤序列里，没有第几步可算
  return ended(row) ? "已结束" : "";
}
/** 行内显式三态 tag（预览②）：进行中／已结束／已结束·可退回（终态但服务端仍允许退回，P2-10） */
function endTagText(row: TaskRow) {
  if (!ended(row)) return "进行中";
  const actions = (row as { actions?: string[] }).actions || [];
  return row.status === "已检测" && actions.includes("退回中") ? "已结束·可退回" : "已结束";
}

/** 流转方向（D3/批5）：双向显首腿、title 给全程；退回＝返程；仅本地＝不寄送灰字；划拨＝归属转移无步条。 */
function dirOf(row: TaskRow) {
  const r = row as unknown as PolicyTask;
  const label = kindLabel(r);
  const returning = r.status === "退回中" || r.status === "已退回";
  if (isLocalSample(r))
    return {
      local: true,
      from: "",
      to: "",
      hint: "封箱即结束 · 箱留采样单位",
      title: "仅本地采样，不寄送",
    };
  if (r.kind === "划拨" || r.kind === "调拨")
    return {
      local: false,
      from: r.fromOrg || "—",
      to: r.toOrg || "—",
      hint: "归属转移 · 无物流",
      title: `归属转移：${r.fromOrg || "—"} → ${r.toOrg || "—"}`,
    };
  if (returning)
    return {
      local: false,
      from: r.toOrg || "—",
      to: r.fromOrg || "—",
      hint: r.status === "退回中" ? "退回返程" : "退回完成",
      title: `退回返程：${r.toOrg || "—"} → ${r.fromOrg || "—"}`,
    };
  if (label === "采样后送检" && r.trip === "双向")
    return {
      local: false,
      from: r.fromOrg || "—",
      to: r.org || "—",
      hint: "双向首腿 · 返程寄回检测站",
      title: `双向全程：${r.fromOrg || "检测站"}寄出→${r.org || "分公司"}采样→寄回${r.toOrg || "检测站"}`,
    };
  const from = r.fromOrg || r.org || "—";
  const to = r.toOrg || (label === "送检" ? "—" : r.org || "—");
  return {
    local: false,
    from,
    to,
    hint:
      label === "送检"
        ? "仅寄送 · 接收方固定检测站"
        : label === "采样后送检"
          ? "单向 · 本地采样后直寄"
          : r.trip
            ? `${r.trip} · 旧单只读`
            : "—",
    title: `${from} → ${to}`,
  };
}

/** 操作列：主按钮＝第一个非取消动作；其余低强调链接；已结束行只留退回链接（服务端 actions 事实）。 */
function primaryAction(row: TaskRow) {
  const actions = (row as { actions?: string[] }).actions || [];
  return ended(row) ? "" : actions.find((a) => a !== "已取消") || "";
}
function secondaryActions(row: TaskRow) {
  const actions = (row as { actions?: string[] }).actions || [];
  const primary = primaryAction(row);
  return actions.filter((a) => a !== primary);
}
const action = reactive({ open: false, to: "", task: null as PolicyTask | null });
function openAction(row: TaskRow, to: string) {
  action.task = row as unknown as PolicyTask;
  action.to = to;
  action.open = true;
}

onMounted(async () => {
  try {
    orgOptions.value = await DeptAPI.getOptions();
  } catch {
    orgOptions.value = [];
  }
});
// keep-alive 切回：非轮询页签补一次加载（R22 口径）；轮询页签失败过（updatedAt 空）也补一次
onActivated(() => {
  if (!pollingEnabled.value || error.value) refresh();
});
</script>

<style scoped>
.page-container {
  /* 灰绿 done（预览②）：全站无此 token，tone.ts 不动，页内局部定义 */
  --task-done: #67a37c;
  --task-done-bg: #eef5f0;
}
html.dark .page-container {
  --task-done: #7fb894;
  --task-done-bg: rgb(103 163 124 / 12%);
}
.qmark {
  margin-left: 4px;
  font-size: 14px;
  vertical-align: -2px;
  color: var(--el-text-color-placeholder);
  cursor: help;
}
.fail-banner {
  margin-bottom: 8px;
}
.fail-line {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
.fail-line .retry {
  margin-left: auto;
}
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
  margin-bottom: 8px;
}
/* 下拉触发器（预览① .select）：激活态主色描边 */
.dd-select {
  display: inline-flex;
  gap: 6px;
  align-items: center;
  height: 32px;
  padding: 0 10px;
  font-size: 12px;
  color: var(--el-text-color-primary);
  white-space: nowrap;
  cursor: pointer;
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color);
  border-radius: 6px;
}
.dd-select .lab {
  color: var(--el-text-color-secondary);
}
.dd-select .val {
  font-weight: 600;
  color: var(--el-color-primary);
}
.dd-select .caret {
  font-size: 10px;
  color: var(--el-text-color-placeholder);
}
.dd-select.on {
  border-color: var(--el-color-primary);
  box-shadow: 0 0 0 2px var(--el-color-primary-light-9);
}
.date-range {
  width: 220px;
}
.date-range :deep(.el-date-editor) {
  width: 100%;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  margin-bottom: 8px;
}
.result-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  padding: 4px 10px;
  margin-bottom: 8px;
  font-size: 12px;
  color: var(--el-text-color-regular);
  background: var(--el-fill-color-lighter);
  border: 1px solid var(--el-border-color-extra-light);
  border-radius: 6px;
}
.result-bar b {
  font-variant-numeric: tabular-nums;
}
.result-bar .sort-note {
  margin-left: auto;
}
/* 32px 密行＋sticky 表头（max-height 内滚）＋12px 字号（预览②③）。
   全站 override 给 td 定了 46px 高，这里按预览基线收回 32px（特异性高于全局 .el-table .el-table__body td） */
.task-table {
  --el-table-border-color: var(--el-border-color-extra-light);
}
.task-table :deep(.el-table__body td.el-table__cell) {
  height: 32px;
  padding: 1px 0;
}
.task-table :deep(.cell) {
  padding: 0 8px;
  font-size: 12px;
  line-height: 1.4;
}
.task-table :deep(th.el-table__cell) {
  height: 28px;
  padding: 0;
  font-size: 11px;
  font-weight: 600;
  color: var(--el-text-color-secondary);
  background: var(--el-fill-color-lighter);
}
.task-table :deep(.el-table__body-wrapper) {
  min-height: 120px;
}
.task-table :deep(.el-table__row) {
  cursor: pointer;
}
.task-table :deep(.row-done) {
  background: var(--task-done-bg);
}
.task-table :deep(.row-done:hover > td) {
  background: var(--task-done-bg);
}
.l1 {
  display: flex;
  gap: 5px;
  align-items: center;
  height: 16px;
  overflow: hidden;
}
.l2 {
  height: 14px;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 11px;
  line-height: 14px;
  color: var(--el-text-color-secondary);
  white-space: nowrap;
}
.mini {
  flex-shrink: 0;
  height: 16px;
  padding: 0 4px;
  font-size: 10px;
  line-height: 14px;
}
.mini.kind {
  padding: 0 6px;
  font-size: 11px;
}
.id-link {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 11px;
  color: var(--el-color-primary);
  white-space: nowrap;
  text-decoration: none;
}
.id-link:hover {
  text-decoration: underline;
}
.video {
  flex-shrink: 0;
  color: var(--el-color-success);
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.num {
  font-variant-numeric: tabular-nums;
}
.dir {
  font-size: 12px;
  white-space: nowrap;
}
.dir .a {
  color: var(--el-text-color-placeholder);
}
.dir .from,
.dir .to {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dir .to {
  font-weight: 600;
}
.dir.none {
  color: var(--el-text-color-placeholder);
}
.progress-line {
  display: flex;
  gap: 8px;
  align-items: center;
}
.status {
  display: inline-flex;
  flex-shrink: 0;
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
.tone-done {
  color: var(--task-done);
}
.tag-done {
  --el-tag-text-color: var(--task-done);
  --el-tag-border-color: var(--task-done);
  --el-tag-bg-color: var(--task-done-bg);
}
/* 进度副行：步条/到近/超限同在 14px 一行，保 32px 密行（预览②） */
.subline {
  display: flex;
  gap: 6px;
  align-items: center;
}
/* 每一步一格：做完的实心，当前这步主色，还没到的灰色；终态灰、终态OK灰绿 */
.steps {
  display: inline-flex;
  flex: 0 0 auto;
  gap: 3px;
  width: 64px;
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
.steps.ended-ok i.done {
  background: var(--task-done);
  opacity: 0.55;
}
.void-note {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.arrival {
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 11px;
  color: var(--el-text-color-secondary);
  white-space: nowrap;
}
.arrival.on {
  color: var(--el-color-success);
}
.over {
  flex: 0 0 auto;
  font-size: 11px;
  color: var(--el-color-danger);
  white-space: nowrap;
}
.ops {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  align-items: center;
}
.ops .el-button + .el-button {
  margin-left: 0;
}
/* 链接按钮收回 24px，与主按钮同高，保 32px 密行 */
.ops :deep(.el-button.is-link) {
  height: 24px;
  padding: 0 4px;
}
.sort-th {
  display: inline-flex;
  gap: 2px;
  align-items: center;
  padding: 0;
  font-size: 11px;
  font-weight: 600;
  color: var(--el-text-color-secondary);
  cursor: pointer;
  background: none;
  border: none;
}
.sort-th.sorted {
  color: var(--el-color-primary);
}
.sort-th .ico {
  font-size: 10px;
}
.state-box {
  padding: 16px 0;
  text-align: center;
}
.state-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--el-text-color-regular);
}
.state-btn {
  margin-top: 8px;
}
/* 状态多选下拉面板（预览① dd-*） */
.dd-head {
  display: flex;
  gap: 6px;
  align-items: center;
  padding-bottom: 5px;
  font-size: 12px;
  font-weight: 700;
  border-bottom: 1px solid var(--el-border-color-extra-light);
}
.dd-head .text-muted {
  font-size: 11px;
  font-weight: 400;
}
.dd-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 0 8px;
  padding-top: 3px;
}
.dd-group .g-title {
  font-size: 10px;
  color: var(--el-text-color-placeholder);
}
.dd-opt {
  display: flex;
  gap: 5px;
  align-items: center;
  height: 20px;
  font-size: 12px;
  cursor: pointer;
}
.dd-opt input {
  width: 13px;
  height: 13px;
  margin: 0;
  accent-color: var(--el-color-primary);
}
.dd-opt.zero {
  color: var(--el-text-color-placeholder);
}
.dd-opt .hist {
  padding: 0 3px;
  font-size: 10px;
  color: var(--el-text-color-placeholder);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 3px;
}
.dd-opt .n {
  margin-left: auto;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--el-text-color-secondary);
}
.dd-foot {
  display: flex;
  gap: 8px;
  align-items: center;
  padding-top: 5px;
  margin-top: 5px;
  font-size: 11px;
  color: var(--el-text-color-secondary);
  border-top: 1px solid var(--el-border-color-extra-light);
}
.dd-foot .num.primary {
  color: var(--el-color-primary);
}
.dd-foot .ok {
  margin-left: auto;
}
.type-opt {
  display: flex;
  gap: 6px;
  align-items: center;
  height: 24px;
  font-size: 12px;
  cursor: pointer;
}
.type-opt input {
  width: 13px;
  height: 13px;
  margin: 0;
  accent-color: var(--el-color-primary);
}
.type-opt.sel {
  font-weight: 600;
  color: var(--el-color-primary);
}
.type-opt .d {
  margin-left: auto;
  font-size: 11px;
  color: var(--el-text-color-placeholder);
}
.type-sep {
  padding-top: 3px;
  margin-top: 3px;
  font-size: 10px;
  color: var(--el-text-color-placeholder);
  border-top: 1px dashed var(--el-border-color-lighter);
}
</style>
