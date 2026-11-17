<template>
  <div class="box-picker">
    <div class="chosen">
      <span class="label">已选 {{ chosen.length }} 台</span>
      <el-tag v-for="box in chosen" :key="box.id" closable size="small" @close="remove(box.id)">
        {{ box.name || box.id }}
      </el-tag>
      <span v-if="!chosen.length" class="muted">在下面的表格里勾选，最多 100 台</span>
      <el-button v-if="chosen.length" link type="danger" size="small" @click="clearAll">
        清空
      </el-button>
    </div>

    <div class="tools">
      <el-input
        v-model="query.q"
        :prefix-icon="Search"
        placeholder="名称或 IMEI，回车搜索"
        clearable
        style="width: 260px"
        @keyup.enter="reload"
        @clear="reload"
      />
      <el-radio-group v-model="query.life" @change="reload">
        <el-radio-button value="未使用">可用</el-radio-button>
        <el-radio-button value="在途">任务中</el-radio-button>
        <el-radio-button value="">全部</el-radio-button>
      </el-radio-group>
      <span class="muted">共 {{ total }} 台</span>
    </div>

    <el-table
      ref="tableRef"
      v-loading="loading"
      :data="rows"
      row-key="id"
      empty-text="没有符合条件的采样箱"
      @select="onSelect"
      @select-all="onSelectAll"
    >
      <el-table-column type="selection" width="48" :selectable="selectable" />
      <el-table-column label="采样箱" min-width="180">
        <template #default="{ row }">
          <b>{{ row.name || row.id }}</b>
          <div class="muted">{{ row.id }}</div>
        </template>
      </el-table-column>
      <el-table-column label="所属单位" min-width="140">
        <template #default="{ row }">
          <template v-if="row.orgId">{{ row.org }}</template>
          <el-tooltip v-else content="还没分配单位，默认算总公司" placement="top">
            <span>
              {{ row.org || "总公司" }}
              <el-tag size="small" type="info">未分配</el-tag>
            </span>
          </el-tooltip>
        </template>
      </el-table-column>
      <el-table-column label="保管人" min-width="100">
        <template #default="{ row }">{{ row.owner || "—" }}</template>
      </el-table-column>
      <el-table-column label="状态" width="96">
        <template #default="{ row }">
          <el-tooltip
            v-if="row.life === '在途'"
            content="已在一张没结束的任务单里，那张单结束或取消后才能再选"
            placement="top"
          >
            <el-tag size="small" :type="lifeType(row.life)">任务中</el-tag>
          </el-tooltip>
          <el-tag v-else size="small" :type="lifeType(row.life)">{{ row.life }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="电量" width="80">
        <template #default="{ row }">
          {{ row.batteryUsable != null ? `${row.batteryUsable}%` : row.battery || "—" }}
        </template>
      </el-table-column>
      <el-table-column label="最近上报" width="120">
        <template #default="{ row }">{{ ago(row.last) }}</template>
      </el-table-column>
      <el-table-column label="位置" min-width="220" show-overflow-tooltip>
        <template #default="{ row }">{{ row.gpsAddress || row.lbsAddress || "—" }}</template>
      </el-table-column>
    </el-table>
    <el-pagination
      v-if="total > query.pageSize"
      v-model:current-page="query.page"
      class="pager"
      small
      :page-size="query.pageSize"
      :total="total"
      layout="prev, pager, next"
      @current-change="load"
    />
  </div>
</template>

<script setup lang="ts">
import type { TableInstance } from "element-plus";
import { Search } from "@element-plus/icons-vue";
import BoxAPI from "@/api/sample/box";
import type { SampleBox } from "../data";

/**
 * 采样箱选择表：带单位、状态、电量和位置，可以跨页勾选。
 * v-model 是箱号列表，v-model:boxes 回传选中箱子的完整信息，父组件用来判断归属、带出寄出单位。
 */
const props = defineProps<{ modelValue: string[]; boxes: SampleBox[] }>();
const emit = defineEmits<{
  "update:modelValue": [ids: string[]];
  "update:boxes": [boxes: SampleBox[]];
}>();

const MAX = 100;
const tableRef = ref<TableInstance>();
const rows = ref<SampleBox[]>([]);
const total = ref(0);
const loading = ref(false);
const query = reactive({ q: "", life: "未使用", page: 1, pageSize: 10 });
/** 选中的箱子按勾选顺序存着；翻页后表格的勾选状态从这里恢复。 */
const chosen = ref<SampleBox[]>([...props.boxes]);
let seq = 0;

function sync() {
  emit(
    "update:modelValue",
    chosen.value.map((box) => box.id)
  );
  emit("update:boxes", [...chosen.value]);
}
/** 停用的、已在没结束任务单里的（在途）不能选，服务端也会拦。 */
function selectable(row: SampleBox) {
  return row.life !== "停用" && row.life !== "在途";
}
function lifeType(life: string) {
  return life === "未使用"
    ? "success"
    : life === "在途"
      ? "primary"
      : life === "停用"
        ? "info"
        : "warning";
}
function ago(time?: string) {
  if (!time) return "—";
  const ms = Date.now() - new Date(time.replace(" ", "T")).getTime();
  if (!Number.isFinite(ms)) return time;
  if (ms < 60000) return "刚刚";
  if (ms < 3600000) return `${Math.floor(ms / 60000)} 分钟前`;
  if (ms < 86400000) return `${Math.floor(ms / 3600000)} 小时前`;
  return time.slice(0, 10);
}

function onSelect(_selection: SampleBox[], row: SampleBox) {
  const index = chosen.value.findIndex((box) => box.id === row.id);
  if (index >= 0) chosen.value.splice(index, 1);
  else if (chosen.value.length >= MAX) {
    ElMessage.warning(`一张任务单最多 ${MAX} 台`);
    tableRef.value?.toggleRowSelection(row, false);
    return;
  } else chosen.value.push(row);
  sync();
}
function onSelectAll(selection: SampleBox[]) {
  const onPage = new Set(rows.value.map((row) => row.id));
  if (selection.length) {
    for (const row of selection) {
      if (chosen.value.length >= MAX) break;
      if (!chosen.value.some((box) => box.id === row.id)) chosen.value.push(row);
    }
  } else chosen.value = chosen.value.filter((box) => !onPage.has(box.id));
  sync();
  void nextTick(restore);
}
function remove(id: string) {
  chosen.value = chosen.value.filter((box) => box.id !== id);
  const row = rows.value.find((item) => item.id === id);
  if (row) tableRef.value?.toggleRowSelection(row, false);
  sync();
}
function clearAll() {
  chosen.value = [];
  tableRef.value?.clearSelection();
  sync();
}

/** 当前页里已经选过的行打勾。 */
function restore() {
  const ids = new Set(chosen.value.map((box) => box.id));
  tableRef.value?.clearSelection();
  for (const row of rows.value) if (ids.has(row.id)) tableRef.value?.toggleRowSelection(row, true);
}

async function load() {
  const mine = ++seq;
  loading.value = true;
  try {
    const result = await BoxAPI.page({
      page: query.page,
      pageSize: query.pageSize,
      q: query.q.trim(),
      life: query.life,
    });
    if (mine !== seq) return;
    rows.value = result.list;
    total.value = result.total;
    await nextTick();
    restore();
  } finally {
    if (mine === seq) loading.value = false;
  }
}
function reload() {
  query.page = 1;
  void load();
}

onMounted(load);
</script>

<style scoped>
.box-picker {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: 100%;
}
.chosen {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  min-height: 40px;
  padding: 8px 12px;
  background: var(--el-fill-color-lighter);
  border-radius: 6px;
}
.label {
  margin-right: 4px;
  font-weight: 600;
}
.tools {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
.muted {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.pager {
  justify-content: flex-end;
}
</style>
