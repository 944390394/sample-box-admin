<template>
  <div v-if="station" class="station-board">
    <aside class="rail">
      <el-input
        v-model="companyQ"
        size="small"
        clearable
        placeholder="搜索来源公司"
        :prefix-icon="Search"
      />
      <div class="rail-list">
        <button class="rail-item" :class="{ active: !company }" @click="pickCompany('')">
          <span class="rail-name">全部公司</span>
          <span class="rail-nums">
            <span>
              途
              <b>{{ station.moving }}</b>
            </span>
            <span>
              待
              <b :class="{ warn: station.arrived }">{{ station.arrived }}</b>
            </span>
            <span>
              检
              <b :class="{ ok: station.inspected }">{{ station.inspected }}</b>
            </span>
          </span>
        </button>
        <button
          v-for="item in station.companies"
          :key="item.key"
          class="rail-item"
          :class="{ active: company === item.key }"
          @click="pickCompany(item.key)"
        >
          <span class="rail-name" :title="item.name">{{ item.name }}</span>
          <span class="rail-nums">
            <span>
              途
              <b>{{ item.moving }}</b>
            </span>
            <span>
              待
              <b :class="{ warn: item.arrived }">{{ item.arrived }}</b>
            </span>
            <span>
              检
              <b :class="{ ok: item.inspected }">{{ item.inspected }}</b>
            </span>
          </span>
        </button>
        <p v-if="!station.companies.length" class="quiet">
          {{ companyQ.trim() ? "没有匹配的公司" : "暂无来箱" }}
        </p>
      </div>
      <el-pagination
        v-if="station.companyTotal > station.companyPageSize"
        class="rail-pager"
        small
        background
        layout="prev, pager, next"
        :total="station.companyTotal"
        :page-size="station.companyPageSize"
        :current-page="companyPage"
        @current-change="(p: number) => (companyPage = p)"
      />
    </aside>

    <div class="detail">
      <el-tabs v-model="tab">
        <el-tab-pane name="waiting">
          <template #label>
            待检测
            <i class="tab-count" :class="{ warn: boxes.waiting }">{{ boxes.waiting }}</i>
          </template>
          <div data-test="station-waiting">
            <el-table
              v-if="station.waiting.length"
              :data="station.waiting"
              class="click-table"
              max-height="420"
              :row-class-name="({ row }: { row: WaitingBox }) => (overLimit(row) ? 'over-row' : '')"
              @row-click="(row: WaitingBox) => router.push(`/task/detail/${row.taskId}`)"
            >
              <el-table-column label="采样箱" min-width="120">
                <template #default="{ row }">
                  <b>{{ row.boxName }}</b>
                </template>
              </el-table-column>
              <el-table-column label="任务" min-width="150" prop="taskName" />
              <el-table-column v-if="!company" label="来源" min-width="120" prop="from" />
              <el-table-column label="本次开箱" width="140">
                <template #default="{ row }">
                  <span class="opens">
                    <span v-if="row.opensDuring == null" class="zero">—</span>
                    <span v-else :class="{ danger: overLimit(row) }">{{ row.opensDuring }} 次</span>
                    {{ " " }}
                    <el-tag v-if="overLimit(row)" type="danger" size="small">超限</el-tag>
                  </span>
                </template>
              </el-table-column>
              <el-table-column label="签收" width="110">
                <template #default="{ row }"><TimeText :value="row.signedAt" /></template>
              </el-table-column>
            </el-table>
            <el-empty v-else description="没有待检测的箱子" :image-size="70" />
            <div v-if="boxes.waiting > boxes.pageSize" class="foot">
              <el-pagination
                background
                small
                layout="total, prev, pager, next"
                :total="boxes.waiting"
                :page-size="boxes.pageSize"
                :current-page="waitingPage"
                @current-change="(p: number) => (waitingPage = p)"
              />
            </div>
          </div>
        </el-tab-pane>

        <el-tab-pane name="done">
          <template #label>
            {{ dayText }}已检测
            <i class="tab-count ok">{{ boxes.done }}</i>
          </template>
          <div data-test="station-done">
            <el-table
              v-if="station.done.length"
              :data="station.done"
              class="click-table"
              max-height="420"
              @row-click="(row: DoneBox) => router.push(`/task/detail/${row.taskId}`)"
            >
              <el-table-column label="采样箱" min-width="120">
                <template #default="{ row }">
                  <b>{{ row.boxName }}</b>
                </template>
              </el-table-column>
              <el-table-column label="任务" min-width="150" prop="taskName" />
              <el-table-column v-if="!company" label="来源" min-width="120" prop="from" />
              <el-table-column label="本次开箱" width="100">
                <template #default="{ row }">
                  {{ row.opensDuring == null ? "—" : `${row.opensDuring} 次` }}
                </template>
              </el-table-column>
              <el-table-column label="开始检测" width="130">
                <template #default="{ row }">
                  <span :title="fullTime(row.inspectedAt)">{{ clockText(row.inspectedAt) }}</span>
                  <div class="text-muted">{{ row.inspectedBy }}</div>
                </template>
              </el-table-column>
            </el-table>
            <el-empty v-else :description="`${dayText}没有开箱检测`" :image-size="70" />
            <div v-if="boxes.done > boxes.pageSize" class="foot">
              <el-pagination
                background
                small
                layout="total, prev, pager, next"
                :total="boxes.done"
                :page-size="boxes.pageSize"
                :current-page="donePage"
                @current-change="(p: number) => (donePage = p)"
              />
            </div>
          </div>
        </el-tab-pane>

        <el-tab-pane name="inbound">
          <template #label>
            在途任务
            <i class="tab-count">{{ boxes.inbound }}</i>
          </template>
          <div data-test="station-inbound">
            <el-table
              v-if="station.inbound.length"
              :data="station.inbound"
              class="click-table"
              max-height="420"
              @row-click="(row: InboundTask) => router.push(`/task/detail/${row.id}`)"
            >
              <el-table-column label="任务" min-width="180" prop="name" />
              <el-table-column v-if="!company" label="来源" min-width="120" prop="from" />
              <el-table-column label="状态" width="100">
                <template #default="{ row }">
                  <el-tag size="small" :type="taskTone(row.status)">{{ row.status }}</el-tag>
                </template>
              </el-table-column>
              <el-table-column label="箱子" width="80" align="right">
                <template #default="{ row }">
                  <span class="num">{{ row.boxes }} 台</span>
                </template>
              </el-table-column>
              <el-table-column label="创建" width="120">
                <template #default="{ row }"><TimeText :value="row.createdAt" /></template>
              </el-table-column>
            </el-table>
            <el-empty v-else description="没有在途任务" :image-size="70" />
            <div v-if="boxes.inbound > boxes.pageSize" class="foot">
              <el-pagination
                background
                small
                layout="total, prev, pager, next"
                :total="boxes.inbound"
                :page-size="boxes.pageSize"
                :current-page="inboundPage"
                @current-change="(p: number) => (inboundPage = p)"
              />
            </div>
          </div>
        </el-tab-pane>
      </el-tabs>
    </div>
  </div>
</template>

<script setup lang="ts">
import { Search } from "@element-plus/icons-vue";
import { refDebounced } from "@vueuse/core";
import { computed, ref, watch } from "vue";
import type { DoneBox, InboundTask, UnitOverview, WaitingBox } from "@/api/sample/overview";
import TimeText from "@/components/biz/TimeText.vue";
import { fullTime, toDate } from "@/utils/time";
import { taskTone } from "@/utils/tone";

export interface StationQuery {
  company: string;
  companyQ: string;
  companyPage: number;
  waitingPage: number;
  donePage: number;
  inboundPage: number;
}

/**
 * 检测站主从面板：左边来源公司轨道（可搜索、分页），右边待检测 / 已检测 / 在途三页签。
 * 不选公司就是全部公司的第一页；所有翻页、筛选通过 query 事件交给父级重新取数。
 */
const props = defineProps<{ station: UnitOverview["station"]; dayText: string }>();
const emit = defineEmits<{ query: [q: StationQuery] }>();
const router = useRouter();

const tab = ref("waiting");
const company = ref("");
const companyQ = ref("");
const debouncedQ = refDebounced(companyQ, 300);
const companyPage = ref(1);
const waitingPage = ref(1);
const donePage = ref(1);
const inboundPage = ref(1);

const boxes = computed(
  () =>
    props.station?.boxes ?? {
      pageSize: 20,
      waiting: 0,
      done: 0,
      inbound: 0,
      waitingPage: 1,
      donePage: 1,
      inboundPage: 1,
    }
);

function pickCompany(key: string) {
  company.value = company.value === key ? "" : key;
  waitingPage.value = 1;
  donePage.value = 1;
  inboundPage.value = 1;
}
function overLimit(row: { opensDuring?: number | null; maxOpens?: number | null }) {
  return row.maxOpens != null && row.opensDuring != null && row.opensDuring > row.maxOpens;
}
function pad(n: number) {
  return String(n).padStart(2, "0");
}
function clockText(time: string) {
  const d = toDate(time);
  return d ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : "—";
}

watch(debouncedQ, () => {
  companyPage.value = 1;
});
watch([company, debouncedQ, companyPage, waitingPage, donePage, inboundPage], () => {
  emit("query", {
    company: company.value,
    companyQ: debouncedQ.value.trim(),
    companyPage: companyPage.value,
    waitingPage: waitingPage.value,
    donePage: donePage.value,
    inboundPage: inboundPage.value,
  });
});
</script>

<style scoped>
.station-board {
  display: grid;
  grid-template-columns: 260px minmax(0, 1fr);
  min-height: 320px;
}
.rail {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border-right: 1px solid var(--card-divider);
}
.rail-list {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 4px;
  max-height: 430px;
  overflow-y: auto;
}
.rail-item {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 8px 10px;
  font: inherit;
  text-align: left;
  cursor: pointer;
  background: none;
  border: 1px solid transparent;
  border-radius: 8px;
  transition:
    background 0.15s,
    border-color 0.15s;
}
.rail-item:hover {
  background: var(--el-fill-color-lighter);
}
.rail-item.active {
  background: color-mix(in srgb, var(--el-color-primary) 8%, transparent);
  border-color: color-mix(in srgb, var(--el-color-primary) 35%, transparent);
}
.rail-name {
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 13px;
  font-weight: 600;
  color: var(--el-text-color-primary);
  white-space: nowrap;
}
.rail-nums {
  display: flex;
  gap: 10px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.rail-nums b {
  font-variant-numeric: tabular-nums;
  color: var(--el-text-color-primary);
}
.rail-nums b.warn {
  color: var(--el-color-warning);
}
.rail-nums b.ok {
  color: var(--el-color-success);
}
.rail-pager {
  justify-content: center;
}
.quiet {
  padding: 12px 4px;
  margin: 0;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}
.detail {
  min-width: 0;
  padding: 0 12px 12px;
}
.detail :deep(.el-tabs__header) {
  margin-bottom: 10px;
}
.tab-count {
  padding: 0 6px;
  font-size: 11px;
  font-style: normal;
  font-variant-numeric: tabular-nums;
  line-height: 17px;
  color: var(--el-text-color-secondary);
  background: var(--el-fill-color-light);
  border-radius: 999px;
}
.tab-count.warn {
  color: var(--el-color-warning);
  background: var(--status-warn-bg);
}
.tab-count.ok {
  color: var(--el-color-success);
  background: var(--status-ok-bg);
}
.click-table {
  width: 100%;
}
.click-table :deep(.el-table__row) {
  cursor: pointer;
}
.click-table :deep(.over-row) {
  --el-table-tr-bg-color: var(--status-danger-bg);
}
.opens {
  white-space: nowrap;
}
.danger {
  font-weight: 600;
  color: var(--el-color-danger);
}
.zero {
  color: var(--el-text-color-placeholder);
}
.num {
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.foot {
  display: flex;
  justify-content: flex-end;
  padding-top: 10px;
}
@media (max-width: 767px) {
  .station-board {
    grid-template-columns: minmax(0, 1fr);
  }
  .rail {
    border-right: 0;
    border-bottom: 1px solid var(--card-divider);
  }
  .rail-list {
    flex-direction: row;
    max-height: none;
    overflow-x: auto;
    overflow-y: hidden;
  }
  .rail-item {
    flex-shrink: 0;
    min-width: 132px;
  }
}
</style>
