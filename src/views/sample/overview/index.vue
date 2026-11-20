<template>
  <div class="page-container page-flow">
    <PageHeader title="集团总览">
      <template #meta>
        <span class="head-meta">
          <span v-if="headerSub">{{ headerSub }}</span>
          <FreshnessMeta :updated-at="updatedAt" :error="error" :interval="5000" />
        </span>
      </template>
      <template #actions>
        <el-button :icon="Refresh" :loading="loading" @click="refresh">刷新</el-button>
      </template>
    </PageHeader>

    <!-- 模拟视角横幅：数据按该单位该角色的范围与权限计算，非真实权限（大屏模式下保留） -->
    <el-alert
      v-if="viewAs"
      type="info"
      :closable="false"
      show-icon
      class="viewas-alert"
      data-test="viewas-banner"
    >
      <template #title>
        <span class="viewas-alert-text">
          模拟视角：{{ viewAs.orgName }} ·
          {{ viewAs.roleLabel }}——数据按该单位该角色的范围与权限计算，非真实权限
        </span>
        <el-button
          link
          type="primary"
          size="small"
          class="viewas-exit"
          data-test="viewas-exit"
          @click="exitViewAs"
        >
          退出视角
        </el-button>
      </template>
    </el-alert>

    <!-- 模拟视角选择行：仅系统管理员；大屏（内容全屏）模式隐藏，横幅保留 -->
    <div v-if="isAdmin && !appStore.contentFullscreen" class="viewas-bar" data-test="viewas-bar">
      <span class="viewas-label">模拟视角</span>
      <el-tree-select
        v-model="asOrgId"
        :data="deptOptions"
        check-strictly
        filterable
        clearable
        placeholder="选择公司"
        class="viewas-org"
        :render-after-expand="false"
        data-test="viewas-org"
        @change="onViewAsChange"
      />
      <el-select
        v-model="asRoleCode"
        filterable
        clearable
        placeholder="选择角色"
        class="viewas-role"
        data-test="viewas-role"
        @change="onViewAsChange"
      >
        <el-option
          v-for="r in roleChoices"
          :key="r.value"
          :label="r.label"
          :value="r.code"
          :disabled="r.disabled"
        />
      </el-select>
      <el-button v-if="viewAs" size="small" data-test="viewas-exit-bar" @click="exitViewAs">
        退出视角
      </el-button>
      <span class="viewas-hint text-muted">只读模拟，不改变真实权限</span>
    </div>

    <ErrorState v-if="error" :message="`刷新失败：${error}`" :retrying="loading" @retry="refresh" />

    <!-- 首载骨架：按真实版式占位，避免加载完成后布局跳动 -->
    <div v-if="!data && loading" class="boot" aria-busy="true" aria-label="正在加载集团总览">
      <div class="kpi-grid">
        <el-skeleton v-for="i in 6" :key="i" animated class="kpi-skeleton">
          <template #template>
            <el-skeleton-item variant="text" style="width: 55%" />
            <el-skeleton-item variant="h3" style="width: 40%; margin-top: 10px" />
            <el-skeleton-item variant="text" style="width: 65%; margin-top: 10px" />
          </template>
        </el-skeleton>
      </div>
      <div class="charts">
        <SectionCard title="箱子状态分布">
          <el-skeleton :rows="5" animated />
        </SectionCard>
        <SectionCard title="箱子最多的分公司">
          <el-skeleton :rows="5" animated />
        </SectionCard>
      </div>
      <SectionCard title="单位列表">
        <el-skeleton :rows="6" animated />
      </SectionCard>
    </div>

    <EmptyState
      v-else-if="data && !data.branchTotal && !data.stationCount"
      description="你的数据范围里没有可总览的单位"
    >
      <div class="empty-guide">
        <p class="text-muted guide-text">
          总览按分公司 / 检测站统计箱子。你的数据范围未覆盖任何单位（例如「仅本人」），
          可以回工作台处理待办，或到采样箱列表查看自己有权看的箱子。
        </p>
        <div class="guide-actions">
          <el-button type="primary" :icon="Odometer" @click="goHome">去工作台</el-button>
          <el-button :icon="Box" @click="goBoxes">查看采样箱</el-button>
        </div>
      </div>
    </EmptyState>

    <template v-else-if="data">
      <div
        class="kpi-grid"
        :class="{ 'is-three': kpis.length === 3 }"
        role="group"
        aria-label="集团关键指标"
        data-test="group-station-tiles"
      >
        <KpiCard v-for="item in kpis" :key="item.key" :item="item" @select="openTile" />
      </div>

      <div v-if="flagChips.length" class="flag-strip" role="group" aria-label="异常箱子快捷入口">
        <button
          v-for="chip in flagChips"
          :key="chip.key"
          type="button"
          class="flag-chip"
          :class="`is-${chip.tone}`"
          :aria-label="`${chip.label} ${chip.value} 台，点击查看箱子`"
          @click="openTile(chip.key)"
        >
          <i class="dot" aria-hidden="true" />
          {{ chip.label }}
          <b>{{ chip.value }}</b>
        </button>
      </div>

      <div class="charts">
        <SectionCard title="箱子状态分布" :sub="donutSub">
          <div class="donut-wrap">
            <InsightChart
              :options="donutOptions"
              height="260px"
              :empty="!donutParts.length"
              empty-text="暂无箱子数据"
              @select="onDonutSelect"
            />
            <div v-if="donutParts.length" class="donut-center" aria-hidden="true">
              <strong>{{ data.total?.total.toLocaleString() }}</strong>
              <span>台</span>
            </div>
          </div>
        </SectionCard>
        <SectionCard title="箱子最多的分公司" sub="前 8 家 · 点条形筛选列表">
          <InsightChart
            :options="topOptions"
            height="260px"
            :empty="!data.top.length"
            empty-text="暂无分公司箱子"
            @select="onTopSelect"
          />
        </SectionCard>
      </div>

      <SectionCard
        ref="unitsCard"
        title="单位列表"
        :sub="`${data.unitTotal.toLocaleString()} 家`"
        flush
        data-test="group-units"
      >
        <template #extra>
          <el-radio-group v-model="typeFilter" size="small" aria-label="单位类型筛选">
            <el-radio-button value="">全部</el-radio-button>
            <el-radio-button value="branch">分公司</el-radio-button>
            <el-radio-button value="station">检测站</el-radio-button>
          </el-radio-group>
          <el-select v-model="sort" size="small" style="width: 124px" aria-label="排序方式">
            <el-option label="箱子最多" value="total" />
            <el-option label="在途最多" value="moving" />
            <el-option label="异常最多" value="alert" />
            <el-option label="按名称" value="name" />
          </el-select>
          <el-input
            v-model="keyword"
            size="small"
            clearable
            placeholder="搜索单位名称"
            :prefix-icon="Search"
            style="width: 190px"
            aria-label="搜索单位名称"
          />
        </template>

        <EntityList
          :rows="unitRows"
          :total="data.unitTotal"
          :page="page"
          :page-size="pageSize"
          row-key="id"
          :loading="loading"
          empty-text="没有匹配的单位"
          @row-click="openUnit"
          @update:page="(p) => (page = p)"
          @update:page-size="(s) => (pageSize = s)"
        >
          <el-table-column label="单位" min-width="240">
            <template #default="{ row }">
              <div class="unit-cell" :data-test="`unit-${row.id}`">
                <span class="avatar" :class="{ 'is-station': row.station }" aria-hidden="true">
                  {{ row.name.slice(0, 1) }}
                </span>
                <div class="unit-name">
                  <div class="name-line">
                    <b>{{ row.name }}</b>
                    <el-tag
                      size="small"
                      :type="row.station ? 'warning' : row.hq ? 'info' : 'primary'"
                      effect="plain"
                    >
                      {{ row.station ? "检测站" : row.hq ? "总部" : "分公司" }}
                    </el-tag>
                  </div>
                  <div v-if="row.path !== row.name" class="text-muted path">{{ row.path }}</div>
                </div>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="状态分布" min-width="140">
            <template #default="{ row }">
              <DistributionBar v-if="row.stats" :segments="segmentsOf(row)" />
              <span v-else class="zero">—</span>
            </template>
          </el-table-column>
          <el-table-column label="箱子" width="82" align="right">
            <template #default="{ row }">
              <span class="num">{{ num(row, "total") }}</span>
            </template>
          </el-table-column>
          <el-table-column :label="lifeLabel('在途')" width="82" align="right">
            <template #default="{ row }">
              <span class="num" :class="tone(row, 'moving', 'primary')">
                {{ num(row, "moving") }}
              </span>
            </template>
          </el-table-column>
          <el-table-column label="在仓库" width="90" align="right">
            <template #default="{ row }">
              <span class="num" :class="tone(row, 'idle', 'success')">{{ num(row, "idle") }}</span>
            </template>
          </el-table-column>
          <el-table-column :label="lifeLabel('待激活')" width="90" align="right">
            <template #default="{ row }">
              <span class="num" :class="tone(row, 'pending', 'warning')">
                {{ num(row, "pending") }}
              </span>
            </template>
          </el-table-column>
          <el-table-column label="检测流转" width="180">
            <template #default="{ row }">
              <div v-if="row.station" class="flow-cell">
                <span>
                  来站
                  <b :class="{ zero: !row.station.moving }">{{ row.station.moving }}</b>
                </span>
                <span>
                  待检
                  <b :class="{ warn: row.station.arrived, zero: !row.station.arrived }">
                    {{ row.station.arrived }}
                  </b>
                </span>
                <span>
                  今检
                  <b :class="{ ok: row.station.inspected, zero: !row.station.inspected }">
                    {{ row.station.inspected }}
                  </b>
                </span>
              </div>
              <span v-else class="zero">—</span>
            </template>
          </el-table-column>
          <el-table-column label="异常" min-width="150">
            <template #default="{ row }">
              <div v-if="row.stats && hasFlags(row)" class="flag-cell">
                <el-tag v-if="row.stats.flags.offline" size="small" type="info" effect="plain">
                  离线 {{ row.stats.flags.offline }}
                </el-tag>
                <el-tag v-if="row.stats.flags.low" size="small" type="warning" effect="plain">
                  低电 {{ row.stats.flags.low }}
                </el-tag>
                <el-tag v-if="row.stats.flags.alert" size="small" type="danger" effect="plain">
                  告警 {{ row.stats.flags.alert }}
                </el-tag>
              </div>
              <span v-else class="zero">—</span>
            </template>
          </el-table-column>
          <el-table-column width="40" align="center">
            <template #default>
              <el-icon class="row-go" aria-hidden="true"><ArrowRight /></el-icon>
            </template>
          </el-table-column>

          <template #card="{ row }">
            <div class="unit-card-body" :data-test="`unit-${u(row).id}`">
              <div class="name-line">
                <span class="avatar" :class="{ 'is-station': u(row).station }" aria-hidden="true">
                  {{ u(row).name.slice(0, 1) }}
                </span>
                <b>{{ u(row).name }}</b>
                <el-tag
                  size="small"
                  :type="u(row).station ? 'warning' : u(row).hq ? 'info' : 'primary'"
                  effect="plain"
                >
                  {{ u(row).station ? "检测站" : u(row).hq ? "总部" : "分公司" }}
                </el-tag>
                <el-icon class="go" aria-hidden="true"><ArrowRight /></el-icon>
              </div>
              <div v-if="u(row).path !== u(row).name" class="text-muted path">
                {{ u(row).path }}
              </div>
              <DistributionBar
                v-if="u(row).stats"
                :segments="segmentsOf(u(row))"
                class="card-bar"
              />
              <div class="card-nums">
                <span>
                  箱子
                  <b>{{ num(u(row), "total") }}</b>
                </span>
                <template v-if="u(row).station">
                  <span>
                    来站
                    <b :class="{ zero: !u(row).station!.moving }">{{ u(row).station!.moving }}</b>
                  </span>
                  <span>
                    待检
                    <b :class="{ warn: u(row).station!.arrived, zero: !u(row).station!.arrived }">
                      {{ u(row).station!.arrived }}
                    </b>
                  </span>
                  <span>
                    今检
                    <b :class="{ ok: u(row).station!.inspected, zero: !u(row).station!.inspected }">
                      {{ u(row).station!.inspected }}
                    </b>
                  </span>
                </template>
                <template v-else>
                  <span>
                    {{ lifeLabel("在途") }}
                    <b :class="tone(u(row), 'moving', 'primary')">{{ num(u(row), "moving") }}</b>
                  </span>
                  <span>
                    在仓库
                    <b :class="tone(u(row), 'idle', 'success')">{{ num(u(row), "idle") }}</b>
                  </span>
                  <span>
                    {{ lifeLabel("待激活") }}
                    <b :class="tone(u(row), 'pending', 'warning')">{{ num(u(row), "pending") }}</b>
                  </span>
                </template>
              </div>
              <div v-if="u(row).stats && hasFlags(u(row))" class="flag-cell">
                <el-tag v-if="u(row).stats!.flags.offline" size="small" type="info" effect="plain">
                  离线 {{ u(row).stats!.flags.offline }}
                </el-tag>
                <el-tag v-if="u(row).stats!.flags.low" size="small" type="warning" effect="plain">
                  低电 {{ u(row).stats!.flags.low }}
                </el-tag>
                <el-tag v-if="u(row).stats!.flags.alert" size="small" type="danger" effect="plain">
                  告警 {{ u(row).stats!.flags.alert }}
                </el-tag>
              </div>
            </div>
          </template>

          <template #empty-action>
            <el-button v-if="keyword || typeFilter" size="small" @click="clearFilter">
              清除筛选
            </el-button>
            <el-button v-if="data.myUnitId" size="small" type="primary" @click="goMyUnit">
              进入本单位总览
            </el-button>
          </template>
        </EntityList>
      </SectionCard>
    </template>
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: "SampleOverview" });

import {
  ArrowRight,
  Box,
  CircleCheck,
  House,
  Odometer,
  Position,
  Refresh,
  Search,
  Suitcase,
  Van,
} from "@element-plus/icons-vue";
import { refDebounced } from "@vueuse/core";
import OverviewAPI, {
  type BoxStats,
  type GroupOverview,
  type OverviewUnit,
  type StationCounts,
  type ViewAs,
} from "@/api/sample/overview";
import type { OptionItem } from "@/api/common";
import DeptAPI from "@/api/system/dept";
import RoleAPI, { type RoleOption } from "@/api/system/role";
import DistributionBar, { type DistSegment } from "@/components/biz/DistributionBar.vue";
import FreshnessMeta from "@/components/biz/FreshnessMeta.vue";
import PageHeader from "@/components/biz/PageHeader.vue";
import SectionCard from "@/components/biz/SectionCard.vue";
import EmptyState from "@/components/ov/EmptyState.vue";
import EntityList from "@/components/ov/EntityList.vue";
import ErrorState from "@/components/ov/ErrorState.vue";
import InsightChart from "@/components/ov/InsightChart.vue";
import KpiCard from "@/components/ov/KpiCard.vue";
import type { ChartSelect, KpiItem } from "@/components/ov/types";
import { useChartPalette } from "@/composables/useChartPalette";
import { useOverviewPolling } from "@/composables/useOverviewPolling";
import { useAppStore } from "@/stores/app";
import { useUserStore } from "@/stores/user";
import { lifeLabel } from "@/utils/labels";
import type { ComponentPublicInstance } from "vue";
import type { LocationQueryRaw } from "vue-router";

/**
 * 集团总览（补充协议 1.2.10）：全局指标、状态分布、Top 分公司，下面一张可搜索筛选排序的单位列表。
 * 单位几千家公司时列表在服务端分页，页面只拿一页；每 5 秒轮询，后台暂停、失败退避。
 */
const router = useRouter();
const route = useRoute();
const data = ref<GroupOverview | null>(null);
const palette = useChartPalette();
const appStore = useAppStore();
const userStore = useUserStore();
/** 仅系统管理员能切换模拟视角（与后端 asOrgId/asRoleCode 门禁同口径）。 */
const isAdmin = computed(() => (userStore.userInfo.roles || []).includes("ADMIN"));
/** 单位列表卡片：点 Top 分公司柱状图后滚到这里，用模板引用而不是查 data-test（U-P2-4）。 */
const unitsCard = ref<ComponentPublicInstance | null>(null);

const keyword = ref("");
const debouncedKeyword = refDebounced(keyword, 300);
const typeFilter = ref<"" | "branch" | "station">("");
const sort = ref<"total" | "moving" | "alert" | "name">("total");
const page = ref(1);
const pageSize = ref(20);

/** 模拟视角：公司＋角色都选齐才带参重取；支持从 URL query 深链进入。 */
const asOrgId = ref(typeof route.query.asOrgId === "string" ? route.query.asOrgId : "");
const asRoleCode = ref(typeof route.query.asRoleCode === "string" ? route.query.asRoleCode : "");
const deptOptions = ref<OptionItem[]>([]);
const roleOptions = ref<RoleOption[]>([]);
const roleChoices = computed(() =>
  roleOptions.value.filter((r): r is RoleOption & { code: string } => Boolean(r.code))
);
const viewAs = computed<ViewAs | null>(() => data.value?.viewAs ?? null);
const simulating = computed(() => Boolean(asOrgId.value && asRoleCode.value));

onMounted(async () => {
  if (!isAdmin.value) return;
  try {
    const [depts, roles] = await Promise.all([DeptAPI.getOptions(), RoleAPI.getOptions()]);
    deptOptions.value = depts;
    roleOptions.value = roles;
  } catch {
    /* 选项加载失败不影响真实总览，选择行留空即可 */
  }
});

/** 把模拟参数写进 URL（replace 不增历史），深链/刷新/keep-alive 回到本页都能还原同一视角。 */
function syncViewAsQuery() {
  const query: LocationQueryRaw = { ...route.query };
  if (asOrgId.value) query.asOrgId = asOrgId.value;
  else delete query.asOrgId;
  if (asRoleCode.value) query.asRoleCode = asRoleCode.value;
  else delete query.asRoleCode;
  void router.replace({ query });
}
function onViewAsChange() {
  syncViewAsQuery();
  if (page.value !== 1) page.value = 1;
  else void refresh();
}
/** 退出视角：清参回真实集团视角（横幅与选择行两处退出按钮共用）。 */
function exitViewAs() {
  asOrgId.value = "";
  asRoleCode.value = "";
  syncViewAsQuery();
  if (page.value !== 1) page.value = 1;
  else void refresh();
}
// keep-alive 回到本页时按当前 URL 还原视角：从单位页「退出视角」回来（URL 无 as 参数）
// 必须清掉缓存里的旧模拟参数，否则轮询会带着旧参数再次单单位 replace 形成回环。
// 注册在 useOverviewPolling 之前，先同步参数再由其 onActivated 补一次 load。
onActivated(() => {
  const qOrg = typeof route.query.asOrgId === "string" ? route.query.asOrgId : "";
  const qRole = typeof route.query.asRoleCode === "string" ? route.query.asRoleCode : "";
  if (qOrg !== asOrgId.value || qRole !== asRoleCode.value) {
    asOrgId.value = qOrg;
    asRoleCode.value = qRole;
    page.value = 1;
  }
});

let token = 0;
async function load(): Promise<boolean> {
  const mine = ++token;
  const result = await OverviewAPI.group({
    q: debouncedKeyword.value.trim(),
    type: typeFilter.value,
    sort: sort.value,
    page: page.value,
    pageSize: pageSize.value,
    // 公司＋角色选齐才带模拟参数，避免只选一半时后端 400
    ...(simulating.value ? { asOrgId: asOrgId.value, asRoleCode: asRoleCode.value } : {}),
  });
  if (mine !== token) return false;
  // 页面已被 keep-alive 缓存（用户切去了别的页签）时迟到的结果一律丢弃：
  // 不更新后台页签的数据/时间戳，更不能触发下面的单单位自动 replace，
  // 把用户从当前页面（如工作台）拽回单位总览（P2 延迟回环）。
  // 轮询本身已在 useOverviewPolling 的 onDeactivated 暂停，这里兜住在途请求的竞态。
  if (route.name !== "SampleOverview") return false;
  // 数据范围里只有一个单位时直接进它的总览。带 from=auto 标记：
  // 单位总览的「返回」据此回工作台，而不是回集团总览又被 replace 回来（回环陷阱）。
  // 模拟视角的单单位跳转把 as 参数透传过去，单位页据此继续按模拟口径渲染。
  if (
    result.unitTotal === 1 &&
    result.units.length === 1 &&
    !debouncedKeyword.value.trim() &&
    !typeFilter.value
  ) {
    void router.replace({
      path: `/monitor/overview/${result.units[0].id}`,
      query: {
        from: "auto",
        ...(simulating.value ? { asOrgId: asOrgId.value, asRoleCode: asRoleCode.value } : {}),
      },
    });
    return false;
  }
  data.value = result;
  return true;
}
const { updatedAt, error, loading, refresh } = useOverviewPolling(load, 5000);

const headerSub = computed(() =>
  data.value
    ? `${data.value.branchTotal.toLocaleString()} 家分公司 · ${data.value.stationCount} 个检测站`
    : ""
);

/** EntityList 的行是宽松 Record，这里还原成接口类型再用。 */
function u(row: Record<string, unknown>): OverviewUnit {
  return row as unknown as OverviewUnit;
}
const unitRows = computed(() => (data.value?.units ?? []) as unknown as Record<string, unknown>[]);

type ColKey = "total" | "moving" | "idle" | "pending";
/** el-table 插槽行是宽松类型，这里只要求用到的字段 */
type UnitLike = { stats?: BoxStats | null; station?: StationCounts | null };
function valueOf(unit: UnitLike, key: ColKey): number | null {
  const s = unit.stats;
  if (!s) return null;
  if (key === "total") return s.total;
  if (key === "moving") return s.counts["在途"] ?? 0;
  if (key === "idle") return s.counts["未使用"] ?? 0;
  return s.counts["待激活"] ?? 0;
}
function num(unit: UnitLike, key: ColKey) {
  const value = valueOf(unit, key);
  return value == null ? "—" : value.toLocaleString();
}
function tone(unit: UnitLike, key: ColKey, name: string) {
  return valueOf(unit, key) ? `tone-${name}` : "zero";
}
function hasFlags(unit: UnitLike) {
  const f = unit.stats?.flags;
  return Boolean(f && (f.offline || f.low || f.alert));
}
function segmentsOf(unit: UnitLike): DistSegment[] {
  const s = unit.stats;
  if (!s) return [];
  return [
    { label: lifeLabel("在途"), value: s.counts["在途"] ?? 0, color: "var(--el-color-primary)" },
    { label: "在仓库", value: s.counts["未使用"] ?? 0, color: "var(--el-color-success)" },
    {
      label: lifeLabel("待激活"),
      value: s.counts["待激活"] ?? 0,
      color: "var(--el-color-warning)",
    },
    { label: lifeLabel("停用"), value: s.counts["停用"] ?? 0, color: "var(--status-stale)" },
  ];
}

/** 真实占比：base 为 0 时返回 0%，不造假环比。 */
function pct(value: number, base: number): string {
  if (!base) return "0%";
  const p = (value / base) * 100;
  return `${p >= 10 ? Math.round(p) : Math.round(p * 10) / 10}%`;
}

const kpis = computed<KpiItem[]>(() => {
  const s = data.value?.total;
  if (!s) return [];
  const total = s.total;
  const moving = s.counts["在途"] ?? 0;
  const list: KpiItem[] = [
    {
      key: "total",
      label: "箱子总数",
      value: total,
      hint: `覆盖 ${(data.value?.branchTotal ?? 0) + (data.value?.stationCount ?? 0)} 家单位`,
      clickable: false,
      icon: Box,
    },
    {
      key: "life:在途",
      label: lifeLabel("在途"),
      value: moving,
      hint: `占总数 ${pct(moving, total)}`,
      tone: "primary",
      icon: Van,
    },
    {
      key: "life:未使用",
      label: "在仓库",
      value: s.counts["未使用"] ?? 0,
      hint: `占总数 ${pct(s.counts["未使用"] ?? 0, total)}`,
      tone: "success",
      icon: House,
    },
  ];
  const st = data.value?.stationTotal;
  if (st) {
    list.push(
      {
        key: "moving",
        label: "运往检测站",
        value: st.moving,
        // 「运往检测站」的台数是「在途」台数的子集，占比只按在途算。
        // 以前在途为 0 时会换成按总数算，同一张卡在两种数据下写的不是同一个口径（L-P0-3）；
        // 现在分母没了就不写占比，不换成另一个分母。
        hint: moving ? `占在途 ${pct(st.moving, moving)}` : "",
        tone: "primary",
        clickable: false,
        icon: Position,
      },
      {
        key: "arrived",
        label: "已到检测站 · 未开箱检测",
        value: st.arrived,
        hint: `占总数 ${pct(st.arrived, total)}`,
        tone: st.arrived ? "warning" : "default",
        clickable: false,
        icon: Suitcase,
      },
      {
        key: "inspected",
        label: "今日已检测",
        value: st.inspected,
        hint: `占总数 ${pct(st.inspected, total)}`,
        tone: "success",
        clickable: false,
        icon: CircleCheck,
      }
    );
  }
  return list;
});

const flagChips = computed(() => {
  const f = data.value?.total?.flags;
  if (!f) return [];
  return [
    { key: "flag:alert", label: "告警", value: f.alert ?? 0, tone: "danger" },
    { key: "flag:offline", label: "离线", value: f.offline ?? 0, tone: "warning" },
    { key: "flag:low", label: "低电量", value: f.low ?? 0, tone: "danger" },
  ].filter((chip) => chip.value > 0);
});

/** 环图扇区：name 是显示名，key 是存储值，点击跳转时用 key。 */
const donutParts = computed(() => {
  const p = palette.value;
  const s = data.value?.total;
  if (!s) return [];
  return [
    { key: "在途", name: lifeLabel("在途"), value: s.counts["在途"] ?? 0, color: p.primary },
    { key: "未使用", name: "在仓库", value: s.counts["未使用"] ?? 0, color: p.success },
    { key: "待激活", name: lifeLabel("待激活"), value: s.counts["待激活"] ?? 0, color: p.warning },
    { key: "停用", name: lifeLabel("停用"), value: s.counts["停用"] ?? 0, color: p.info },
  ].filter((part) => part.value > 0);
});

const donutSub = computed(() =>
  data.value?.total ? `共 ${data.value.total.total.toLocaleString()} 台 · 点扇区查看箱子` : ""
);

const donutOptions = computed(() => {
  const p = palette.value;
  return {
    tooltip: { trigger: "item", formatter: "{b}：{c} 台（{d}%）" },
    legend: {
      bottom: 0,
      icon: "circle",
      itemWidth: 8,
      itemHeight: 8,
      itemGap: 14,
      textStyle: { color: p.textSecondary, fontSize: 12 },
    },
    series: [
      {
        type: "pie",
        radius: ["60%", "80%"],
        center: ["50%", "44%"],
        padAngle: 2,
        itemStyle: { borderColor: p.bg, borderWidth: 2, borderRadius: 5 },
        label: { show: false },
        emphasis: { scaleSize: 4 },
        data: donutParts.value.map((part) => ({
          name: part.name,
          value: part.value,
          itemStyle: { color: part.color },
        })),
      },
    ],
  };
});

const topOptions = computed(() => {
  const p = palette.value;
  const top = data.value?.top || [];
  const names = top.map((item) => item.name);
  const seriesOf = (name: string, key: "moving" | "idle" | "pending", color: string) => ({
    name,
    type: "bar",
    stack: "total",
    barWidth: 14,
    itemStyle: { color, borderRadius: key === "pending" ? [0, 3, 3, 0] : 0 },
    emphasis: { focus: "series" },
    data: top.map((item) => item[key]),
  });
  return {
    tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
    legend: {
      bottom: 0,
      icon: "circle",
      itemWidth: 8,
      itemHeight: 8,
      itemGap: 14,
      textStyle: { color: p.textSecondary, fontSize: 12 },
    },
    grid: { left: 8, right: 28, top: 8, bottom: 30, containLabel: true },
    xAxis: {
      type: "value",
      splitLine: { lineStyle: { color: p.splitLine } },
      axisLabel: { color: p.textSecondary, fontSize: 11 },
    },
    yAxis: {
      type: "category",
      inverse: true,
      data: names,
      axisTick: { show: false },
      axisLine: { show: false },
      axisLabel: {
        color: p.text,
        fontSize: 12,
        formatter: (value: string) => (value.length > 7 ? `${value.slice(0, 7)}…` : value),
      },
    },
    series: [
      seriesOf(lifeLabel("在途"), "moving", p.primary),
      seriesOf("在仓库", "idle", p.success),
      seriesOf(lifeLabel("待激活"), "pending", p.warning),
    ],
  };
});

function openTile(key: string) {
  if (key.startsWith("life:") || key.startsWith("flag:"))
    void router.push({ path: "/device/boxes", query: { tile: key } });
}
function onDonutSelect(p: ChartSelect) {
  const part = donutParts.value.find((item) => item.name === p.name);
  if (part) openTile(`life:${part.key}`);
}
function onTopSelect(p: ChartSelect) {
  if (!p.name) return;
  keyword.value = p.name;
  nextTick(() => {
    // SectionCard 的根就是一个 section，拿组件实例的 $el 滚过去；
    // 原先用 document.querySelector('[data-test=...]') 是让生产逻辑依赖测试钩子（U-P2-4）
    (unitsCard.value?.$el as HTMLElement | undefined)?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  });
}
function openUnit(row: Record<string, unknown>) {
  void router.push({
    path: `/monitor/overview/${String(row.id)}`,
    query: simulating.value ? { asOrgId: asOrgId.value, asRoleCode: asRoleCode.value } : {},
  });
}
function clearFilter() {
  keyword.value = "";
  typeFilter.value = "";
}
/** 空态引导出口：范围里没有单位时不能把人困在空板上（R4）。 */
function goHome() {
  void router.push("/monitor/home");
}
function goBoxes() {
  void router.push("/device/boxes");
}
function goMyUnit() {
  const id = data.value?.myUnitId;
  if (id)
    void router.push({
      path: `/monitor/overview/${id}`,
      query: simulating.value ? { asOrgId: asOrgId.value, asRoleCode: asRoleCode.value } : {},
    });
}

watch([debouncedKeyword, typeFilter, sort], () => {
  if (page.value !== 1) page.value = 1;
  else void refresh();
});
watch([page, pageSize], () => {
  void refresh();
});
</script>

<style scoped>
.head-meta {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  align-items: center;
}
.viewas-alert :deep(.el-alert__title) {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  align-items: center;
  font-size: 13px;
}
.viewas-exit {
  flex-shrink: 0;
}
.viewas-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 10px;
  align-items: center;
  padding: 10px 14px;
  background: var(--content-bg);
  border: 1px solid var(--card-border);
  border-radius: var(--card-radius);
}
.viewas-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--el-text-color-regular);
}
.viewas-org {
  width: 240px;
}
.viewas-role {
  width: 180px;
}
.viewas-hint {
  font-size: 12px;
}
.boot {
  display: flex;
  flex-direction: column;
  gap: var(--page-gap);
}
.empty-guide {
  display: flex;
  flex-direction: column;
  gap: 12px;
  align-items: center;
}
.guide-text {
  max-width: 460px;
  margin: 0;
  font-size: 13px;
  line-height: 1.7;
  text-align: center;
}
.guide-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: center;
}
.kpi-skeleton {
  padding: 14px 16px;
  background: var(--content-bg);
  border: 1px solid var(--card-border);
  border-radius: var(--card-radius);
}
.kpi-grid {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: var(--page-gap);
}
.kpi-grid.is-three {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}
.flag-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.flag-chip {
  display: inline-flex;
  gap: 6px;
  align-items: center;
  padding: 5px 12px;
  font: inherit;
  font-size: 13px;
  color: var(--el-text-color-regular);
  cursor: pointer;
  background: var(--content-bg);
  border: 1px solid var(--card-border);
  border-radius: 999px;
  transition:
    border-color var(--motion-fast, 150ms),
    box-shadow var(--motion-fast, 150ms);
}
.flag-chip:hover {
  border-color: var(--card-border-hover);
  box-shadow: var(--card-shadow-hover);
}
.flag-chip:focus-visible {
  outline: var(--focus-ring, 2px solid var(--el-color-primary));
  outline-offset: 1px;
}
.flag-chip .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
}
.flag-chip b {
  font-variant-numeric: tabular-nums;
}
.flag-chip.is-danger .dot {
  background: var(--status-danger);
}
.flag-chip.is-danger b {
  color: var(--status-danger);
}
.flag-chip.is-warning .dot {
  background: var(--status-warn);
}
.flag-chip.is-warning b {
  color: var(--status-warn);
}
.charts {
  display: grid;
  grid-template-columns: minmax(0, 2fr) minmax(0, 3fr);
  gap: var(--page-gap);
}
.donut-wrap {
  position: relative;
}
.donut-center {
  position: absolute;
  top: 44%;
  left: 50%;
  display: flex;
  flex-direction: column;
  align-items: center;
  pointer-events: none;
  transform: translate(-50%, -50%);
}
.donut-center strong {
  font-size: 26px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  line-height: 1.2;
  color: var(--el-text-color-primary);
}
.donut-center span {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.unit-cell {
  display: flex;
  gap: 10px;
  align-items: center;
  min-width: 0;
}
.avatar {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  font-size: 14px;
  font-weight: 600;
  color: var(--el-color-primary);
  background: color-mix(in srgb, var(--el-color-primary) 10%, transparent);
  border-radius: 8px;
}
.avatar.is-station {
  color: var(--el-color-warning);
  background: color-mix(in srgb, var(--el-color-warning) 12%, transparent);
}
.unit-name {
  min-width: 0;
}
.name-line {
  display: flex;
  gap: 8px;
  align-items: center;
  min-width: 0;
}
.name-line b {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.path {
  margin-top: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 12px;
  white-space: nowrap;
}
.num {
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.zero {
  font-weight: 400;
  color: var(--el-text-color-placeholder);
}
.tone-primary {
  color: var(--el-color-primary);
}
.tone-success {
  color: var(--el-color-success);
}
.tone-warning {
  color: var(--el-color-warning);
}
.flow-cell {
  display: flex;
  gap: 10px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  white-space: nowrap;
}
.flow-cell b {
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  color: var(--el-text-color-primary);
}
.flow-cell b.warn {
  color: var(--el-color-warning);
}
.flow-cell b.ok {
  color: var(--el-color-success);
}
.flow-cell b.zero {
  color: var(--el-text-color-placeholder);
}
.flag-cell {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.row-go {
  color: var(--el-text-color-placeholder);
  opacity: 0;
  transition:
    opacity var(--motion-fast, 150ms),
    transform var(--motion-fast, 150ms);
}
:deep(.el-table__row:hover) .row-go {
  opacity: 1;
  transform: translateX(2px);
}
.unit-card-body {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.unit-card-body .go {
  margin-left: auto;
  color: var(--el-text-color-placeholder);
}
.card-bar {
  margin: 2px 0;
}
.card-nums {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 14px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.card-nums b {
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  color: var(--el-text-color-primary);
}
.card-nums b.tone-primary {
  color: var(--el-color-primary);
}
.card-nums b.tone-success {
  color: var(--el-color-success);
}
.card-nums b.tone-warning {
  color: var(--el-color-warning);
}
.card-nums b.zero {
  font-weight: 400;
  color: var(--el-text-color-placeholder);
}
@media (max-width: 1280px) {
  .kpi-grid,
  .kpi-grid.is-three {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}
@media (max-width: 1024px) {
  .charts {
    grid-template-columns: minmax(0, 1fr);
  }
}
@media (max-width: 640px) {
  .kpi-grid,
  .kpi-grid.is-three {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
