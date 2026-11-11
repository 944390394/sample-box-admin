<template>
  <div class="page-container page-flow">
    <PageHeader title="采样箱" :subtitle="subtitle">
      <template #actions>
        <el-button :icon="Connection" @click="router.push('/device/serial')">
          USB 串口读取
        </el-button>
        <el-button
          v-if="can(BOX_PERM.export)"
          :icon="Download"
          :loading="exporting"
          @click="exportList"
        >
          导出当前筛选
        </el-button>
      </template>
    </PageHeader>

    <StatTiles v-model="tile" :items="tiles" :max="9" @update:model-value="applyTile" />

    <el-card shadow="never">
      <div class="filter-bar">
        <el-input
          v-model="query.q"
          :prefix-icon="Search"
          placeholder="名称或 IMEI"
          clearable
          style="width: 220px"
          @input="debouncedReload"
          @clear="reload"
        />
        <el-tree-select
          v-model="query.orgId"
          :data="orgOptions"
          check-strictly
          filterable
          clearable
          placeholder="所属单位"
          style="width: 220px"
          :render-after-expand="false"
          @change="reload"
        />
        <el-button v-if="filtered" link type="primary" @click="resetFilters">清除筛选</el-button>
        <span class="filter-bar__spacer" />
        <template v-if="canBatch">
          <span v-if="selected.length" class="text-muted">已选 {{ selected.length }} 台</span>
          <el-button
            :disabled="!selected.length"
            @click="openPolicy({ ids: selected.map((b) => b.id) })"
          >
            批量上报策略
          </el-button>
          <el-button :disabled="!total" @click="openPolicy({ filter: currentFilter() })">
            对筛选结果设置
          </el-button>
        </template>
      </div>

      <el-table
        v-loading="loading && !rows.length"
        :data="rows"
        row-key="id"
        class="box-table"
        empty-text="没有符合条件的采样箱"
        @row-click="(row: SampleBox) => openDetail(row)"
        @selection-change="(list: SampleBox[]) => (selected = list)"
      >
        <el-table-column v-if="canBatch" type="selection" width="40" fixed="left" />
        <el-table-column label="采样箱" min-width="180" fixed="left">
          <template #default="{ row }">
            <div class="name-cell">
              <span
                class="dot"
                :class="onlineOf(row) ? 'on' : 'off'"
                :title="onlineOf(row) ? '在线' : '离线'"
              />
              <div class="name-text">
                <b>{{ row.name || row.id }}</b>
                <div class="text-muted mono">{{ row.id }}</div>
                <div v-if="row.alert" class="danger alert-line" :title="row.alert">
                  {{ row.alert }}
                </div>
              </div>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="状态 · 上报" width="120">
          <template #default="{ row }">
            <el-tag size="small" :type="lifeTone(row.life)">{{ lifeLabel(row.life) }}</el-tag>
            <el-tag
              v-if="row.wipe"
              type="danger"
              size="small"
              class="ml"
              :title="wipeTitle(row.wipe)"
            >
              抹除中
            </el-tag>
            <div class="text-muted" :class="{ offline: !onlineOf(row) }">
              <TimeText :value="row.last" />
            </div>
          </template>
        </el-table-column>
        <el-table-column v-if="can(BOX_PERM.power)" label="电量" width="110">
          <template #default="{ row }">
            <template v-if="row.batteryUsable != null">
              <el-progress
                :percentage="row.batteryUsable"
                :stroke-width="6"
                :color="batteryColor(row.batteryUsable)"
              />
              <div v-if="row.charge === 1 || row.charge === 2" class="text-muted">
                {{ chargeLabel(row.charge) }}
              </div>
            </template>
            <span v-else class="text-muted">{{ row.battery || "—" }}</span>
          </template>
        </el-table-column>
        <el-table-column
          v-if="can(BOX_PERM.lid) || can(BOX_PERM.signal)"
          label="箱盖 · 信号"
          width="96"
        >
          <template #default="{ row }">
            <span :class="{ danger: row.lid === 1 }">{{ lidLabel(row.lid) }}</span>
            <div class="text-muted">{{ signalText(row.csq) }}</div>
          </template>
        </el-table-column>
        <el-table-column label="所属 · 保管人" min-width="140">
          <template #default="{ row }">
            <div>
              {{ row.org || "总公司" }}
              <el-tag v-if="!row.orgId" size="small" type="info" class="ml">未分配</el-tag>
            </div>
            <div class="text-muted">
              {{ row.owner && row.owner !== "—" ? row.owner : "无保管人" }}
            </div>
          </template>
        </el-table-column>
        <el-table-column v-if="can(BOX_PERM.location)" label="位置" min-width="240">
          <template #default="{ row }">
            <LocationLine :box="row" :period-sec="row.reportPeriodSec" compact empty-text="—" />
          </template>
        </el-table-column>
        <el-table-column v-if="can(policyPerm.read)" label="上报策略" width="120">
          <template #default="{ row }">
            <el-tag size="small" :type="policyStatusType(row.reportPolicyStatus)">
              {{ policyStatusText(row.reportPolicyStatus) }}
            </el-tag>
            <span class="text-muted ml">{{ row.reportPeriodSec }} 秒</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="110" fixed="right">
          <template #default="{ row }">
            <div class="ops" @click.stop>
              <el-button
                v-if="row.life === '待激活' && can(BOX_PERM.activate)"
                link
                type="primary"
                @click="openActivate(row)"
              >
                激活
              </el-button>
              <el-button v-else link type="primary" @click="openDetail(row)">查看</el-button>
              <el-dropdown
                v-if="moreOf(row).length"
                trigger="click"
                @command="(cmd: string) => onMore(cmd, row)"
              >
                <el-button link>
                  更多
                  <el-icon class="el-icon--right"><ArrowDown /></el-icon>
                </el-button>
                <template #dropdown>
                  <el-dropdown-menu>
                    <el-dropdown-item
                      v-for="item in moreOf(row)"
                      :key="item.cmd"
                      :command="item.cmd"
                      :divided="item.danger"
                      :class="{ 'is-danger': item.danger }"
                    >
                      {{ item.label }}
                    </el-dropdown-item>
                  </el-dropdown-menu>
                </template>
              </el-dropdown>
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

    <el-dialog v-model="activate.open" title="激活采样箱" width="460px" style="max-width: 94vw">
      <p v-if="activate.box" class="lead">
        IMEI {{ activate.box.id }}
        <template v-if="activate.box.iccid">· ICCID {{ activate.box.iccid }}</template>
      </p>
      <p class="text-muted">
        核对箱体上贴的 IMEI 后确认。激活后状态变为{{
          lifeLabel("未使用")
        }}，所属总公司，之后可以分配给单位和保管人。
      </p>
      <el-form label-position="top" @submit.prevent>
        <el-form-item label="名称（选填）">
          <el-input
            v-if="can(BOX_PERM.rename)"
            v-model="activate.name"
            maxlength="32"
            show-word-limit
            :placeholder="`不填用默认名称：${activate.box?.name || ''}`"
            @keyup.enter="doActivate"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="activate.open = false">取消</el-button>
        <el-button type="primary" :loading="activate.busy" @click="doActivate">确认激活</el-button>
      </template>
    </el-dialog>

    <AssignDialog v-model="assignOpen" :box="current" @saved="load" />
    <ReportPolicyDialog
      v-model="policy.open"
      :box-id="policy.boxId"
      :box-name="policy.boxName"
      :ids="policy.ids"
      :filter="policy.filter"
      @saved="load"
    />
  </div>
</template>

<script setup lang="ts">
import { clock } from "@/utils/time";
defineOptions({ name: "SampleBoxes" });

import { ArrowDown, Connection, Download, Search } from "@element-plus/icons-vue";
import SampleBoxAPI, { type BoxFlag, type BoxFlags } from "@/api/sample/box";
import DeptAPI from "@/api/system/dept";
import type { OptionItem } from "@/api/common";
import { policyPerm } from "@/api/sample/report-policy";
import PageHeader from "@/components/biz/PageHeader.vue";
import StatTiles, { type StatTile } from "@/components/biz/StatTiles.vue";
import TimeText from "@/components/biz/TimeText.vue";
import DataPager from "@/components/biz/DataPager.vue";
import LocationLine from "@/components/biz/LocationLine.vue";
import { usePerm } from "@/composables/usePerm";
import { useUrlQuery } from "@/composables/useUrlQuery";
import { downloadFile } from "@/utils/download";
import { chargeLabel, lidLabel, lifeLabel } from "@/utils/labels";
import { batteryColor, lifeTone } from "@/utils/tone";
import AssignDialog from "./AssignDialog.vue";
import ReportPolicyDialog from "./ReportPolicyDialog.vue";
import { deleteArchive, policyStatusText, policyStatusType, wipeTitle } from "./management";
import { telemetryState } from "./telemetry";
import { BOX_PERM, type SampleBox } from "../data";

/**
 * 采样箱清单：顶部指标卡兼作筛选（状态、告警、离线、低电、开着盖），下面按名称、IMEI、所属单位搜。
 * 筛选写在地址栏里，从详情页返回时还在。10 秒刷新一次。
 */
const router = useRouter();
const can = usePerm();
const { state: query, sync } = useUrlQuery({ q: "", orgId: "", tile: "", page: 1, pageSize: 20 });

const rows = ref<SampleBox[]>([]);
const total = ref(0);
const counts = ref<Record<string, number>>({});
const flags = ref<Partial<BoxFlags>>({});
const loading = ref(false);
const exporting = ref(false);
const selected = ref<SampleBox[]>([]);
const orgOptions = ref<OptionItem[]>([]);
// 跟全站时钟走：在线点和「x 秒前」每秒刷新
const now = clock;
const tile = ref(query.tile);
const current = ref<SampleBox | null>(null);
const assignOpen = ref(false);
const canBatch = computed(() => can(policyPerm.batch));
const filtered = computed(() => Boolean(query.q || query.orgId || tile.value));
const subtitle = computed(() => {
  const all = Object.values(counts.value).reduce((n, v) => n + v, 0);
  return `共 ${all} 台。新设备第一次上电会自动建档为「${lifeLabel("待激活")}」，核对后激活即可使用。`;
});

const tiles = computed<StatTile[]>(() => {
  const list: StatTile[] = [
    {
      key: "life:在途",
      label: lifeLabel("在途"),
      value: counts.value["在途"] ?? 0,
      tone: "primary",
    },
    {
      key: "life:未使用",
      label: lifeLabel("未使用"),
      value: counts.value["未使用"] ?? 0,
      tone: "success",
    },
    {
      key: "life:待激活",
      label: lifeLabel("待激活"),
      value: counts.value["待激活"] ?? 0,
      tone: counts.value["待激活"] ? "warning" : "default",
    },
    { key: "life:停用", label: lifeLabel("停用"), value: counts.value["停用"] ?? 0, tone: "info" },
    {
      key: "flag:offline",
      label: "离线",
      value: flags.value.offline ?? 0,
      tone: flags.value.offline ? "warning" : "default",
    },
  ];
  if (can(BOX_PERM.power) || can(BOX_PERM.lid)) {
    list.push(
      {
        key: "flag:low",
        label: "低电量",
        value: flags.value.low ?? 0,
        tone: flags.value.low ? "danger" : "default",
      },
      {
        key: "flag:lid",
        label: "开着盖",
        value: flags.value.lid ?? 0,
        tone: flags.value.lid ? "warning" : "default",
      },
      {
        key: "flag:ready",
        label: "可调配",
        value: flags.value.ready ?? 0,
        hint: "空闲、电量足、在线",
        tone: "success",
      }
    );
  }
  return list;
});

function currentFilter() {
  const [kind, value] = tile.value.split(":");
  return {
    q: query.q.trim() || undefined,
    orgId: query.orgId || undefined,
    life: kind === "life" ? value : undefined,
    flag: kind === "flag" ? (value as BoxFlag) : undefined,
  };
}

let seq = 0;
async function load() {
  const mine = ++seq;
  loading.value = true;
  try {
    const filter = currentFilter();
    const page = await SampleBoxAPI.page({
      ...filter,
      flag: filter.flag || "",
      page: query.page,
      pageSize: query.pageSize,
    });
    if (mine !== seq) return;
    rows.value = page.list;
    total.value = page.total;
    counts.value = page.counts || {};
    flags.value = page.flags || {};
  } finally {
    if (mine === seq) loading.value = false;
  }
}
function reload() {
  query.page = 1;
  sync();
  void load();
}
let typing = 0;
function debouncedReload() {
  window.clearTimeout(typing);
  typing = window.setTimeout(reload, 300);
}
function applyTile(key: string) {
  query.tile = key;
  reload();
}
function resetFilters() {
  query.q = "";
  query.orgId = "";
  tile.value = "";
  query.tile = "";
  reload();
}
watch(
  () => [query.page, query.pageSize],
  () => {
    sync();
    void load();
  }
);

function onlineOf(input: Partial<SampleBox>) {
  const row = input as SampleBox;
  return telemetryState(row.last, row.reportPeriodSec, now.value).online;
}
function signalText(csq: number | null | undefined) {
  if (csq == null) return "—";
  if (csq === 99 || csq <= 0) return "无信号";
  return csq >= 20 ? "信号强" : csq >= 10 ? "信号中" : "信号弱";
}
function openDetail(input: Partial<SampleBox>) {
  const row = input as SampleBox;
  if (can(BOX_PERM.detail)) void router.push(`/device/boxes/${encodeURIComponent(row.id)}`);
}

interface MoreItem {
  cmd: string;
  label: string;
  danger?: boolean;
}
function moreOf(input: Partial<SampleBox>): MoreItem[] {
  const row = input as SampleBox;
  const list: MoreItem[] = [];
  if (row.life !== "待激活" && can(BOX_PERM.rename)) list.push({ cmd: "rename", label: "改名称" });
  if (can(BOX_PERM.assignOrg) || can(BOX_PERM.assignOwner))
    list.push({
      cmd: "assign",
      label:
        can(BOX_PERM.assignOrg) && can(BOX_PERM.assignOwner)
          ? "分配单位和保管人"
          : can(BOX_PERM.assignOrg)
            ? "分配所属单位"
            : "分配保管人",
    });
  if (can(policyPerm.single)) list.push({ cmd: "policy", label: "上报策略" });
  if (row.life === "未使用" && can(BOX_PERM.disable)) list.push({ cmd: "disable", label: "停用" });
  if (row.life === "停用" && can(BOX_PERM.enable)) list.push({ cmd: "restore", label: "恢复使用" });
  if (["未使用", "停用"].includes(row.life) && can(BOX_PERM.delete))
    list.push({ cmd: "delete", label: row.wipe ? "删除（抹除中）" : "删除档案", danger: true });
  return list;
}
async function onMore(cmd: string, input: Partial<SampleBox>) {
  const row = input as SampleBox;
  current.value = row;
  if (cmd === "assign") assignOpen.value = true;
  else if (cmd === "policy") openPolicy({ boxId: row.id, boxName: row.name });
  else if (cmd === "rename") await rename(row);
  else if (cmd === "disable") await changeLife(row, "disable");
  else if (cmd === "restore") await changeLife(row, "restore");
  else if (
    cmd === "delete" &&
    (await deleteArchive(
      row.id,
      Boolean(row.remote) && can(BOX_PERM.wipe),
      Boolean(row.wipe),
      row.name || row.id
    ))
  )
    await load();
}

async function rename(input: Partial<SampleBox>) {
  const row = input as SampleBox;
  try {
    const { value } = await ElMessageBox.prompt(
      "1–32 个字，不能和别的采样箱重名",
      `改名称 · ${row.id}`,
      {
        inputValue: row.name,
        inputValidator: (text: string) =>
          (text.trim().length >= 1 && text.trim().length <= 32) || "名称要 1–32 个字",
        confirmButtonText: "保存",
        cancelButtonText: "取消",
      }
    );
    await SampleBoxAPI.rename(row.id, value.trim());
    ElMessage.success("已改名");
    await load();
  } catch {
    /* 取消或接口报错（拦截器已提示） */
  }
}

async function changeLife(input: Partial<SampleBox>, action: "disable" | "restore") {
  const row = input as SampleBox;
  const verb = action === "disable" ? "停用" : "恢复使用";
  try {
    await ElMessageBox.confirm(
      action === "disable"
        ? `停用后「${row.name}」不能被任务选中，可以随时恢复。`
        : `恢复后「${row.name}」回到${lifeLabel("未使用")}状态。`,
      `${verb}采样箱`,
      {
        type: action === "disable" ? "warning" : "info",
        confirmButtonText: verb,
        cancelButtonText: "取消",
      }
    );
  } catch {
    return;
  }
  await (action === "disable" ? SampleBoxAPI.disable(row.id) : SampleBoxAPI.restore(row.id));
  ElMessage.success(`已${verb}`);
  await load();
}

const activate = reactive({ open: false, busy: false, name: "", box: null as SampleBox | null });
function openActivate(input: Partial<SampleBox>) {
  const row = input as SampleBox;
  Object.assign(activate, { open: true, busy: false, name: "", box: row });
}
async function doActivate() {
  if (!activate.box) return;
  activate.busy = true;
  try {
    await SampleBoxAPI.activate(activate.box.id, activate.name.trim());
    ElMessage.success("已激活");
    activate.open = false;
    await load();
  } finally {
    activate.busy = false;
  }
}

const policy = reactive<{
  open: boolean;
  boxId?: string;
  boxName?: string;
  ids?: string[];
  filter?: Record<string, unknown>;
}>({ open: false });
function openPolicy(target: {
  boxId?: string;
  boxName?: string;
  ids?: string[];
  filter?: Record<string, unknown>;
}) {
  Object.assign(policy, {
    boxId: undefined,
    boxName: undefined,
    ids: undefined,
    filter: undefined,
    ...target,
    open: true,
  });
}

async function exportList() {
  exporting.value = true;
  try {
    const filter = currentFilter();
    const file = await SampleBoxAPI.export({ ...filter, flag: filter.flag || "" });
    downloadFile(file, "采样箱.csv");
  } finally {
    exporting.value = false;
  }
}

let poll = 0;
onMounted(async () => {
  void load();
  poll = window.setInterval(() => void load(), 10000);
  try {
    orgOptions.value = await DeptAPI.getOptions();
  } catch {
    orgOptions.value = [];
  }
});
onBeforeUnmount(() => window.clearInterval(poll));
</script>

<style scoped>
.box-table :deep(.el-table__row) {
  cursor: pointer;
}
.name-cell {
  display: flex;
  gap: 8px;
  align-items: flex-start;
}
.dot {
  flex-shrink: 0;
  width: 8px;
  height: 8px;
  margin-top: 7px;
  border-radius: 50%;
}
.dot.on {
  background: var(--el-color-success);
  box-shadow: 0 0 0 3px var(--el-color-success-light-8);
}
.dot.off {
  background: var(--el-text-color-placeholder);
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.ml {
  margin-left: 4px;
}
.mr {
  margin-right: 6px;
}
.danger {
  color: var(--el-color-danger);
}
.name-text {
  min-width: 0;
}
.alert-line {
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 12px;
  white-space: nowrap;
}
.offline {
  color: var(--el-text-color-placeholder);
}
.ops {
  display: flex;
  gap: 4px;
  align-items: center;
}
.lead {
  margin: 0 0 8px;
  font-weight: 600;
}
.filter-bar {
  margin-bottom: 12px;
}
:deep(.is-danger) {
  color: var(--el-color-danger);
}
</style>
