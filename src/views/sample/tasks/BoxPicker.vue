<template>
  <div class="box-picker">
    <div class="chosen">
      <span class="label">已选 {{ chosen.length }} 台</span>
      <el-tag v-for="box in chosen" :key="box.id" closable size="small" @close="remove(box.id)">
        {{ box.name || box.id }}
      </el-tag>
      <span v-if="!chosen.length" class="muted">勾选，或导入箱号。一张单最多 100 台</span>
      <el-button v-if="chosen.length" link type="danger" size="small" @click="clearAll">
        清空
      </el-button>
    </div>

    <div class="tools">
      <el-input
        v-model="query.q"
        :prefix-icon="Search"
        placeholder="名称或编号，回车搜索"
        clearable
        style="width: 260px"
        @keyup.enter="reload"
        @clear="reload"
      />
      <el-button @click="importOpen = true">导入箱号</el-button>
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
      layout="prev, pager, next, total"
      @current-change="load"
    />

    <el-dialog v-model="importOpen" title="导入箱号" width="520px" style="max-width: 94vw">
      <p class="muted">
        每行一个编号，也可以用空格或逗号分隔。csv
        只读第一列。编号对不上时会再按名称精确匹配。一张单最多 100 台。
      </p>
      <el-input
        v-model="importText"
        type="textarea"
        :rows="8"
        placeholder="例如：&#10;860000000000001&#10;860000000000002"
      />
      <div class="file-row">
        <el-button link type="primary" @click="fileRef?.click()">从 txt / csv 读取</el-button>
        <input ref="fileRef" type="file" accept=".txt,.csv,text/plain" hidden @change="onFile" />
      </div>
      <div v-if="importReport" class="report">
        <p>这次加入 {{ importReport.added }} 台，已选共 {{ chosen.length }} 台。</p>
        <p v-if="importReport.missing.length">找不到：{{ importReport.missing.join("、") }}</p>
        <p v-if="importReport.skipped.length">
          未加入：{{
            importReport.skipped
              .map((item) => `${item.name || item.key}（${item.reason}）`)
              .join("、")
          }}
        </p>
        <p v-if="importReport.truncated">超过 100 个编号，只处理了前 100 个。</p>
        <p v-if="importReport.capped">已经到 100 台上限，多出来的没有加入。</p>
      </div>
      <template #footer>
        <el-button @click="importOpen = false">关闭</el-button>
        <el-button type="primary" :loading="importing" @click="runImport">加入已选</el-button>
      </template>
    </el-dialog>
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
const fileRef = ref<HTMLInputElement>();
const rows = ref<SampleBox[]>([]);
const total = ref(0);
const loading = ref(false);
const query = reactive({ q: "", life: "未使用", page: 1, pageSize: 20 });
const importOpen = ref(false);
const importText = ref("");
const importing = ref(false);
const importReport = ref<{
  added: number;
  missing: string[];
  skipped: { key: string; name?: string; reason: string }[];
  truncated: boolean;
  capped: boolean;
} | null>(null);
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

/** 一行一个，或空格/逗号分隔。csv 只取第一列，表头「编号」丢掉。 */
function parseBoxIds(text: string) {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const comma = /[,，;\t]/.test(line);
    const parts = comma ? [line.split(/[,，;\t]/)[0] || ""] : line.split(/\s+/);
    for (const raw of parts) {
      const id = raw.trim().replace(/^["']|["']$/g, "");
      if (!id || seen.has(id) || /^(id|imei|箱号|编号|名称)$/i.test(id)) continue;
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

async function onFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  if (file.size > 256 * 1024) {
    ElMessage.warning("文件太大，请只放箱号");
    return;
  }
  importText.value = await file.text();
}

async function runImport() {
  const all = parseBoxIds(importText.value);
  if (!all.length) {
    ElMessage.warning("没有读到箱号");
    return;
  }
  const ids = all.slice(0, MAX);
  importing.value = true;
  try {
    const result = await BoxAPI.lookup(ids);
    let added = 0;
    let capped = false;
    for (const box of result.list) {
      if (chosen.value.some((item) => item.id === box.id)) continue;
      if (chosen.value.length >= MAX) {
        capped = true;
        break;
      }
      chosen.value.push(box);
      added += 1;
    }
    importReport.value = {
      added,
      missing: result.missing,
      skipped: result.skipped,
      truncated: all.length > MAX || result.truncated,
      capped,
    };
    if (added) {
      sync();
      await nextTick();
      restore();
    }
  } finally {
    importing.value = false;
  }
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
  max-height: 132px;
  padding: 8px 12px;
  overflow: auto;
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
.file-row {
  margin-top: 8px;
}
.report {
  margin-top: 12px;
  font-size: 13px;
  line-height: 1.6;
}
.report p {
  margin: 0 0 4px;
}
.muted {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.pager {
  justify-content: flex-end;
}
</style>
