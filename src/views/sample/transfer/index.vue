<template>
  <div class="page-container page-flow">
    <PageHeader
      title="调拨单"
      subtitle="批量划拨箱子给公司：提交即生效，归属立即转移；不寄出、不签收，无物流步骤。"
    >
      <template #actions>
        <el-button
          v-if="can(TRANSFER_CREATE)"
          type="primary"
          :icon="Plus"
          @click="createOpen = true"
        >
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
            <span v-if="item.count != null" class="count">{{ item.count }}</span>
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
          placeholder="单号 / 单名 / 箱码 / 箱名"
          clearable
          style="width: 260px"
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
            </div>
            <div class="text-muted mono">{{ row.id }}</div>
          </template>
        </el-table-column>
        <el-table-column label="原公司 → 目标公司" min-width="220">
          <template #default="{ row }">
            <span>{{ fromText(row.from) }}</span>
            <span class="arrow">→</span>
            <b>{{ row.toOrg.name || "—" }}</b>
          </template>
        </el-table-column>
        <el-table-column label="箱数" width="70" align="center">
          <template #default="{ row }">{{ row.boxCount }}</template>
        </el-table-column>
        <el-table-column label="划拨人" width="110">
          <template #default="{ row }">{{ row.by || "—" }}</template>
        </el-table-column>
        <el-table-column label="时间" width="150">
          <template #default="{ row }">
            <TimeText :value="row.createdAt" />
            <div class="text-muted">
              <TimeText :value="row.createdAt" mode="short" />
            </div>
            <div v-if="row.revokedAt" class="revoked-line text-muted">
              撤销
              <TimeText :value="row.revokedAt" mode="short" />
            </div>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="130" fixed="right">
          <template #default="{ row }">
            <div class="ops" @click.stop>
              <el-button
                v-if="row.status === '已划拨' && can(TRANSFER_REVOKE)"
                link
                type="danger"
                @click="openRevoke(row.id)"
              >
                撤销划拨
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
      划拨规则：提交即生效，箱子归属立刻转到目标公司（保管人清空）；状态只有「已划拨 / 已撤销」。
      撤销守卫：箱子不在未结束任务、划拨后未开箱、未检测、归属未改挂，任一不合格则整单禁撤。
    </p>

    <CreateDialog v-model="createOpen" @saved="load" />
    <RevokeDialog :id="revokeId" v-model="revokeOpen" @saved="load" />
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: "SampleTransfers" });

import { Plus, Search } from "@element-plus/icons-vue";
import TransferAPI, {
  type TransferCounts,
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
import { useUrlQuery } from "@/composables/useUrlQuery";
import { transferTone } from "@/utils/tone";
import { TRANSFER_CREATE, TRANSFER_REVOKE } from "../data";
import CreateDialog from "./CreateDialog.vue";
import RevokeDialog from "./RevokeDialog.vue";

/**
 * 划拨单列表：批量归属划拨，提交即生效、无物流。页签 全部/已划拨/已撤销 + KPI（单数/箱次双口径）。
 * 新建走服务端 candidate-boxes 下发的箱子集（替换预览页 16 台 POOL 副本）；撤销整单禁撤守卫在服务端实时判定。
 */
const router = useRouter();
const can = usePerm();
const {
  state: query,
  sync,
  reset,
} = useUrlQuery({
  status: "全部",
  orgId: "",
  from: "",
  to: "",
  q: "",
  page: 1,
  pageSize: 20,
});
const rows = ref<TransferListItem[]>([]);
const total = ref(0);
const counts = ref<Partial<TransferCounts>>({});
const kpiHint = ref("箱次口径：同一箱子出现在多单计多次");
const loading = ref(false);
const orgOptions = ref<OptionItem[]>([]);
const dates = ref<string[] | null>(query.from && query.to ? [query.from, query.to] : null);
const tab = ref(query.status || "全部");
const createOpen = ref(false);
const revokeOpen = ref(false);
const revokeId = ref("");
const filtered = computed(() => Boolean(query.orgId || query.from || query.q));

const tabs = computed(() => [
  { key: "全部", label: "全部", count: counts.value.全部 },
  { key: "已划拨", label: "已划拨", count: counts.value.已划拨 },
  { key: "已撤销", label: "已撤销", count: counts.value.已撤销 },
]);
const tiles = computed<StatTile[]>(() => [
  {
    key: "全部",
    label: "全部划拨单",
    value: counts.value.全部 ?? 0,
    tone: "primary",
    hint: `总数 ${counts.value.全部 ?? 0} 单 · 筛选后 ${counts.value.全部 ?? 0} 单`,
  },
  {
    key: "已划拨",
    label: "已划拨",
    value: counts.value.已划拨 ?? 0,
    tone: "success",
    hint: `总数 ${counts.value.已划拨 ?? 0} · 筛选后 ${counts.value.已划拨 ?? 0}`,
  },
  {
    key: "已撤销",
    label: "已撤销",
    value: counts.value.已撤销 ?? 0,
    tone: "info",
    hint: `总数 ${counts.value.已撤销 ?? 0} · 筛选后 ${counts.value.已撤销 ?? 0}`,
  },
  {
    key: "boxes",
    label: "涉及箱子数（累计）",
    value: counts.value.boxCountTotal ?? 0,
    tone: "default",
    clickable: false,
    hint: kpiHint.value,
  },
]);
const emptyText = computed(() =>
  tab.value === "已撤销" ? "暂无已撤销的划拨单" : "没有符合条件的划拨单"
);

function fromText(from: TransferFrom[]) {
  if (!from?.length) return "—";
  return from.map((f) => `${f.orgName}（${f.count}）`).join("、");
}

let seq = 0;
async function load() {
  const mine = ++seq;
  loading.value = true;
  try {
    const result = await TransferAPI.list({
      status: query.status === "全部" ? undefined : query.status,
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
  sync();
  void load();
}
function onTab(name: string | number) {
  query.status = String(name);
  reload();
}
function onTile(key: string) {
  if (key === "boxes") return;
  tab.value = key;
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
  tab.value = "全部";
  void load();
}
function openRevoke(id: string) {
  revokeId.value = id;
  revokeOpen.value = true;
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
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
}
.arrow {
  margin: 0 6px;
  color: var(--el-color-primary);
}
.revoked-line {
  font-size: 12px;
}
.ops {
  display: flex;
  gap: 4px;
  align-items: center;
}
.rule-note {
  margin-top: 12px;
  font-size: 12px;
  line-height: 1.7;
}
</style>
