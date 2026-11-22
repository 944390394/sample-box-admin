<template>
  <div class="page-container page-flow">
    <PageHeader
      title="调拨单"
      subtitle="批量划拨箱子给公司：创建后待目标分公司管理员接受，接受时归属立即转移；接受前创建方可取消、接收方可拒收（原因必填）；接受后不可撤销，只能重新划拨。"
    >
      <template #actions>
        <el-button v-if="can(TRANSFER_CREATE)" type="primary" :icon="Plus" @click="openCreate">
          批量划拨箱子
        </el-button>
      </template>
    </PageHeader>

    <StatTiles :items="tiles" :max="4" @update:model-value="onTile" />

    <el-card shadow="never">
      <el-tabs v-model="tab" class="status-tabs" @tab-change="onTab">
        <el-tab-pane v-for="item in tabs" :key="item.key" :name="item.key">
          <template #label>
            {{ item.label }}
            <span
              v-if="item.count != null"
              class="count"
              :class="{ hot: item.key === '待接受' && item.count > 0 }"
            >
              {{ item.count }}
            </span>
          </template>
        </el-tab-pane>
      </el-tabs>

      <!-- 已结束页签：逐态收窄交给状态 chips（可关闭）；其余页签不显 -->
      <div v-if="tab === '已结束'" class="chips">
        <span class="text-muted chips-label">状态：</span>
        <el-check-tag
          v-for="s in ENDED_CHIPS"
          :key="s"
          :checked="chips.includes(s)"
          class="chip"
          @change="toggleChip(s)"
        >
          {{ s }} {{ chipCount(s) }}
        </el-check-tag>
        <el-button v-if="chips.length" link type="primary" @click="clearChips">清空</el-button>
        <span class="text-muted chips-hint">已结束＝已完成/已取消/已拒收三态合集</span>
      </div>

      <div class="filter-bar">
        <el-tree-select
          v-model="query.orgId"
          :data="orgOptions"
          check-strictly
          filterable
          clearable
          placeholder="涉及公司（来源或目标）"
          style="width: 220px"
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
          placeholder="单号 / 单名 / 箱码 / 箱名 / 快递单号"
          clearable
          style="width: 280px"
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
        class="transfer-table"
        :empty-text="emptyText"
        @row-click="(row: TransferListItem) => router.push(`/sample/transfers/${row.id}`)"
      >
        <el-table-column label="划拨单" min-width="240">
          <template #default="{ row }">
            <div class="name">
              <b>{{ row.name }}</b>
              <el-tag size="small" :type="transferTone(row.status)" effect="plain">
                {{ row.status }}
              </el-tag>
              <el-tag v-if="row.legacy" size="small" type="info" effect="plain" class="hist-tag">
                历史已划拨
              </el-tag>
            </div>
            <div class="text-muted mono">{{ row.id }}</div>
          </template>
        </el-table-column>
        <el-table-column label="来源 → 目标" min-width="220">
          <template #default="{ row }">
            <span>{{ fromText(row.from) }}</span>
            <span class="arrow">→</span>
            <b>{{ row.toOrg.name || "—" }}</b>
            <div v-if="row.status === '已完成'" class="text-muted sub">
              接受人 {{ row.acceptedBy || "—（历史）" }}
            </div>
            <div v-else-if="row.status === '已拒收' && row.rejectReason" class="sub reject">
              原因：{{ row.rejectReason }}
            </div>
          </template>
        </el-table-column>
        <el-table-column label="箱数" width="70" align="center">
          <template #default="{ row }">{{ row.boxCount }}</template>
        </el-table-column>
        <el-table-column label="快递单号" min-width="150">
          <template #default="{ row }">
            <span v-if="row.trackingNo" class="mono">{{ row.trackingNo }}</span>
            <span v-else class="text-muted">
              {{ row.legacy ? "—（历史无）" : "未填写（选填）" }}
            </span>
            <div v-if="row.trackingNo && isEnded(row.status)" class="text-muted sub">
              接受后只读
            </div>
          </template>
        </el-table-column>
        <el-table-column label="创建人" width="110">
          <template #default="{ row }">{{ row.by || "—" }}</template>
        </el-table-column>
        <el-table-column label="时间" width="150">
          <template #default="{ row }">
            <TimeText :value="row.createdAt" />
            <div class="text-muted">
              <TimeText :value="row.createdAt" mode="short" />
            </div>
            <div v-if="row.acceptedAt" class="text-muted sub">
              接受
              <TimeText :value="row.acceptedAt" mode="short" />
            </div>
            <div v-else-if="row.rejectedAt" class="text-muted sub">
              拒收
              <TimeText :value="row.rejectedAt" mode="short" />
            </div>
            <div v-else-if="row.cancelledAt" class="text-muted sub">
              取消
              <TimeText :value="row.cancelledAt" mode="short" />
            </div>
            <div v-else-if="row.revokedAt" class="text-muted sub">
              撤销
              <TimeText :value="row.revokedAt" mode="short" />
            </div>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="190" fixed="right">
          <template #default="{ row }">
            <div class="ops" @click.stop>
              <!-- R25 行操作按态×角色（服务端 abilities 下发）：接受/拒收/取消开弹框，补单号进详情，重新划拨预填向导 -->
              <el-button
                v-if="row.abilities.accept"
                link
                type="primary"
                @click="openAction(row as TransferListItem, 'accept')"
              >
                接受
              </el-button>
              <el-button
                v-if="row.abilities.reject"
                link
                type="danger"
                @click="openAction(row as TransferListItem, 'reject')"
              >
                拒收
              </el-button>
              <el-button
                v-if="row.abilities.cancel"
                link
                type="danger"
                @click="openAction(row as TransferListItem, 'cancel')"
              >
                取消
              </el-button>
              <el-button
                v-if="row.abilities.tracking"
                link
                type="primary"
                @click="router.push(`/sample/transfers/${row.id}`)"
              >
                补单号
              </el-button>
              <el-button
                v-if="row.abilities.retransfer && can(TRANSFER_CREATE)"
                link
                type="primary"
                @click="openRecreate(row as TransferListItem)"
              >
                重新划拨
              </el-button>
              <el-button link type="primary" @click="router.push(`/sample/transfers/${row.id}`)">
                查看
              </el-button>
            </div>
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

    <p class="rule-note text-muted">
      划拨规则（R25 三态）：创建后待目标分公司管理员接受，接受时箱子归属转到目标公司（保管人清空）；
      接受前创建方可取消（箱不动）、接收方可拒收（原因必填、箱不动）；接受后不可撤销，只能重新划拨。
      快递单号创建选填、接受前创建方可补填/修改、接受后只读。历史「已划拨」映射「已完成」（接受人—不伪造）、「已撤销」只读保留。
      提交前需输入当前登录账号密码做二次确认。
    </p>

    <CreateDialog v-model="createOpen" :prefill="prefill" @saved="load" />
    <ActionDialog v-model="actionOpen" :mode="actionMode" :detail="actionDetail" @done="load" />
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: "SampleTransfers" });

import { Plus, Search } from "@element-plus/icons-vue";
import TransferAPI, {
  type TransferCounts,
  type TransferDetail,
  type TransferFrom,
  type TransferListItem,
} from "@/api/sample/transfer";
import DeptAPI from "@/api/system/dept";
import type { OptionItem } from "@/api/common";
import PageHeader from "@/components/biz/PageHeader.vue";
import StatTiles, { type StatTile } from "@/components/biz/StatTiles.vue";
import TimeText from "@/components/biz/TimeText.vue";
import DataPager from "@/components/biz/DataPager.vue";
import { usePerm } from "@/composables/usePerm";
import { hasActiveFilter, useUrlQuery } from "@/composables/useUrlQuery";
import { transferTone } from "@/utils/tone";
import { TRANSFER_CREATE } from "../data";
import CreateDialog from "./CreateDialog.vue";
import ActionDialog from "./ActionDialog.vue";

/**
 * R25（#71）划拨单列表：三态收敛 4 页签（全部/待接受/已结束/已撤销·历史）＋状态 chips（已结束逐态收窄）
 * ＋KPI（全部/待接受/已完成/涉及箱数累计）＋快递单号列＋行操作按态×角色（服务端 abilities）。
 * 已结束＝已完成/已取消/已拒收三终态合集；历史已划拨→已完成（legacy 标，接受人—）、已撤销只读保留。
 * 接受/拒收/取消开 ActionDialog；补单号进详情；重新划拨预填原单箱集（R24 沿用）。
 */
const router = useRouter();
const route = useRoute();
const can = usePerm();
const QUERY_DEFAULTS = {
  status: "全部",
  orgId: "",
  from: "",
  to: "",
  q: "",
  page: 1,
  pageSize: 20,
};
const { state: query, sync, reset } = useUrlQuery(QUERY_DEFAULTS);
const rows = ref<TransferListItem[]>([]);
const total = ref(0);
const counts = ref<Partial<TransferCounts>>({});
const kpiHint = ref("箱次口径：同一箱子出现在多单计多次");
const loading = ref(false);
const orgOptions = ref<OptionItem[]>([]);
const dates = ref<string[] | null>(query.from && query.to ? [query.from, query.to] : null);
const createOpen = ref(false);
/** R25 动作弹框（接受/拒收/取消）：行操作触发，拉详情后开框。 */
const actionOpen = ref(false);
const actionMode = ref<"accept" | "reject" | "cancel" | "">("");
const actionDetail = ref<TransferDetail | null>(null);
/** 已结束页签的逐态 chips（已完成/已取消/已拒收）。 */
const ENDED_CHIPS = ["已完成", "已取消", "已拒收"];
const chips = ref<string[]>([]);
const tab = ref("全部");
/**
 * 「重新划拨」带进向导的预填。箱集取原单详情的逐台快照，名称取原单名，
 * 向导里按箱子当前归属重新判定可选性——预填不是绕过服务端守卫。
 */
const prefill = ref<{ boxIds: string[]; names: Record<string, string>; fromName: string } | null>(
  null
);
const filtered = computed(() => hasActiveFilter(query, ["orgId", "from", "to", "q"]));

/** 页签 key ↔ status 参数：已结束页签带 chips 时下发逗号多选，否则下发伪态。 */
function effectiveStatus(): string {
  if (tab.value === "已结束" && chips.value.length) return chips.value.join(",");
  if (tab.value === "已撤销·历史") return "已撤销";
  return tab.value;
}
/** URL 深链回解：status 参数 → 页签＋chips。 */
function parseStatus(status: string) {
  if (status === "待接受") {
    tab.value = "待接受";
    chips.value = [];
  } else if (status === "已撤销") {
    tab.value = "已撤销·历史";
    chips.value = [];
  } else if (status === "已结束" || status.includes(",") || ENDED_CHIPS.includes(status)) {
    // D-3（#81）：单具体终态（chip 单击写回的 URL 形态）也回解到已结束＋chips=[该态]，
    // 不再落「全部」丢 chips——落地行数==chip 计数，chips 保留、第二 chip 可达（多选交互可用）。
    tab.value = "已结束";
    chips.value =
      status === "已结束" ? [] : status.split(",").filter((s) => ENDED_CHIPS.includes(s));
  } else {
    tab.value = "全部";
    chips.value = [];
  }
}
parseStatus(query.status || "全部");

/**
 * D-2（#81）：地址栏外部变化收口（keep-alive 按 fullPath 复活旧实例带 stale tab、页签重访、
 * KPI tile 路径、浏览器前进/后退）：fullPath 变化时把路由 query 与本页状态做差集，
 * 不一致才采纳并重载——自己 sync() 写回地址栏时两者相等，不会回环；
 * 缓存实例被重新激活时状态以地址栏为准（tab/chips 由 parseStatus 回解）。
 * 参照任务单页同款 watcher（tasks/index.vue），真刷新/跨页深链仍走 setup 一次性回解。
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
      parseStatus(query.status || "全部");
      void load();
    }
  }
);

const tabs = computed(() => [
  { key: "全部", label: "全部", count: counts.value.全部 },
  { key: "待接受", label: "待接受", count: counts.value.待接受 },
  { key: "已结束", label: "已结束", count: counts.value.已结束 },
  { key: "已撤销·历史", label: "已撤销·历史", count: counts.value.已撤销 },
]);
const tiles = computed<StatTile[]>(() => [
  {
    key: "全部",
    label: "全部划拨单",
    value: counts.value.全部 ?? 0,
    tone: "primary",
    hint: `总数 ${counts.value.全部 ?? 0} 单`,
  },
  {
    key: "待接受",
    label: "待接受",
    value: counts.value.待接受 ?? 0,
    tone: "warning",
    hint: "需目标分公司管理员确认 · 接受前可取消/拒收",
  },
  {
    key: "已完成",
    label: "已完成",
    value: counts.value.已完成 ?? 0,
    tone: "success",
    hint: "含历史「已划拨」映射 · 接受时归属已转移",
  },
  {
    key: "boxes",
    label: "涉及箱数（累计）",
    value: counts.value.boxCountTotal ?? 0,
    tone: "default",
    clickable: false,
    hint: kpiHint.value,
  },
]);
const emptyText = computed(() =>
  tab.value === "已撤销·历史"
    ? "暂无已撤销的划拨单"
    : tab.value === "待接受"
      ? "暂无待接受的划拨单"
      : "没有符合条件的划拨单"
);

function fromText(from: TransferFrom[]) {
  if (!from?.length) return "—";
  return from.map((f) => `${f.orgName}（${f.count}）`).join("、");
}
function chipCount(s: string): number {
  return counts.value[s as keyof TransferCounts] ?? 0;
}
function isEnded(status: string) {
  return ["已完成", "已取消", "已拒收", "已撤销", "已划拨"].includes(status);
}

let seq = 0;
async function load() {
  const mine = ++seq;
  loading.value = true;
  try {
    const status = effectiveStatus();
    const result = await TransferAPI.list({
      status: status === "全部" ? undefined : status,
      orgId: query.orgId || undefined,
      from: query.from || undefined,
      to: query.to || undefined,
      q: query.q.trim() || undefined,
      page: query.page,
      pageSize: query.pageSize,
    });
    if (mine !== seq) return;
    rows.value = result.list;
    total.value = result.total;
    counts.value = result.counts || {};
    if (result.kpiHints?.boxCountTotal) kpiHint.value = result.kpiHints.boxCountTotal;
  } finally {
    if (mine === seq) loading.value = false;
  }
}
function reload() {
  query.page = 1;
  query.status = effectiveStatus();
  sync();
  void load();
}
function onTab(name: string | number) {
  tab.value = String(name);
  chips.value = [];
  reload();
}
function toggleChip(s: string) {
  chips.value = chips.value.includes(s) ? chips.value.filter((x) => x !== s) : [...chips.value, s];
  reload();
}
function clearChips() {
  chips.value = [];
  reload();
}
function onTile(key: string) {
  if (key === "boxes") return;
  tab.value = key === "已完成" ? "已结束" : key;
  chips.value = key === "已完成" ? ["已完成"] : [];
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
  tab.value = "全部";
  chips.value = [];
  query.status = "全部";
  void load();
}
/** 顶栏「批量划拨箱子」：不带预填。 */
function openCreate() {
  prefill.value = null;
  createOpen.value = true;
}
/** R25 行接受/拒收/取消：拉详情后开 ActionDialog（按态×角色门已由 abilities 决定入口显隐）。 */
async function openAction(row: TransferListItem, mode: "accept" | "reject" | "cancel") {
  try {
    actionDetail.value = await TransferAPI.detail(row.id);
    actionMode.value = mode;
    actionOpen.value = true;
  } catch (error) {
    ElMessage.error((error as Error).message || "取不到这张划拨单，请稍后再试");
  }
}
/**
 * 「重新划拨」：拉这张单的逐台快照，把箱集回填到同一个建单向导。
 * 详情接口按当前数据范围鉴权，拿不到就提示重试，不静默开一个空向导。
 */
async function openRecreate(row: TransferListItem) {
  try {
    const detail = await TransferAPI.detail(row.id);
    const boxIds = detail.boxes.map((box) => box.boxId);
    if (!boxIds.length) {
      ElMessage.warning("这张划拨单没有箱子，无法重新划拨");
      return;
    }
    const names: Record<string, string> = {};
    for (const box of detail.boxes) names[box.boxId] = box.name || box.code;
    prefill.value = { boxIds, names, fromName: detail.name };
    createOpen.value = true;
  } catch (error) {
    ElMessage.error((error as Error).message || "取不到这张单的箱子，请稍后再试");
  }
}
watch(
  () => [query.page, query.pageSize],
  () => {
    sync();
    void load();
  }
);

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
  color: var(--el-color-warning);
  background: var(--el-color-warning-light-9);
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  margin-bottom: 12px;
}
.chips-label {
  font-size: 12px;
}
.chip {
  cursor: pointer;
}
.chips-hint {
  font-size: 12px;
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
.transfer-table :deep(.el-table__row) {
  cursor: pointer;
}
.name {
  display: flex;
  gap: 6px;
  align-items: center;
}
.hist-tag {
  font-size: 10px;
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
}
.arrow {
  margin: 0 6px;
  color: var(--el-color-primary);
}
.sub {
  font-size: 12px;
}
.sub.reject {
  color: var(--el-color-danger);
}
.ops {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  align-items: center;
}
.rule-note {
  margin-top: 12px;
  font-size: 12px;
  line-height: 1.7;
}
</style>
