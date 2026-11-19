<template>
  <el-dialog
    :model-value="modelValue"
    title="批量划拨箱子"
    width="860px"
    style="max-width: 96vw"
    :close-on-click-modal="false"
    @update:model-value="(v: boolean) => emit('update:modelValue', v)"
    @open="onOpen"
  >
    <p class="lead">
      选目标公司，再勾选一批箱子。
      <b>提交即生效</b>
      ：箱子归属立刻转到目标公司，不寄出、不签收。
    </p>

    <el-form label-width="90px" @submit.prevent>
      <el-form-item label="目标公司" required>
        <el-tree-select
          v-model="toOrgId"
          :data="orgOptions"
          check-strictly
          filterable
          clearable
          placeholder="箱子归属要转到的公司"
          style="width: 320px"
          :render-after-expand="false"
          @change="onTargetChange"
        />
      </el-form-item>
      <el-form-item label="划拨单名称" required>
        <el-input
          v-model="name"
          maxlength="120"
          placeholder="比如：华南区开工补给"
          style="width: 420px"
        />
      </el-form-item>
      <el-form-item label="备注">
        <el-input
          v-model="note"
          type="textarea"
          :rows="2"
          maxlength="1000"
          placeholder="选填，记进操作记录"
          style="width: 560px"
        />
      </el-form-item>
    </el-form>

    <div class="picker-bar">
      <el-input
        v-model="q"
        :prefix-icon="Search"
        placeholder="箱名 / 编号 / 保管人"
        clearable
        style="width: 220px"
        @input="debouncedLoad"
        @clear="loadCandidates"
      />
      <el-tree-select
        v-model="orgId"
        :data="orgOptions"
        check-strictly
        filterable
        clearable
        placeholder="来源公司"
        style="width: 180px"
        :render-after-expand="false"
        @change="loadCandidates"
      />
      <el-select
        v-model="life"
        clearable
        placeholder="生命周期"
        style="width: 130px"
        @change="loadCandidates"
      >
        <el-option v-for="l in LIVES" :key="l" :value="l" :label="l" />
      </el-select>
      <span class="spacer" />
      <el-button link type="primary" :disabled="!pageSelectable.length" @click="selectPage">
        全选本页
      </el-button>
      <el-button link type="primary" :disabled="!selectableCount" @click="selectAll">
        选择全部 {{ selectableCount }} 台可选
      </el-button>
      <el-button link :disabled="!selected.size" @click="selected.clear()">清空</el-button>
    </div>

    <el-table
      v-loading="loading"
      :data="rows"
      height="300"
      row-key="boxId"
      class="picker-table"
      empty-text="没有符合条件的箱子"
      @row-click="toggleRow"
    >
      <el-table-column width="44">
        <template #default="{ row }">
          <el-checkbox
            :model-value="selected.has(row.boxId)"
            :disabled="!row.selectable"
            @change="toggle(row as CandidateBox)"
            @click.stop
          />
        </template>
      </el-table-column>
      <el-table-column label="采样箱" min-width="180">
        <template #default="{ row }">
          <b>{{ row.name }}</b>
          <div class="text-muted mono">{{ row.code }}</div>
        </template>
      </el-table-column>
      <el-table-column label="所属 · 保管人" min-width="150">
        <template #default="{ row }">
          <div>{{ row.org || "总公司" }}</div>
          <div class="text-muted">
            {{ row.owner && row.owner !== "—" ? row.owner : "无保管人" }}
          </div>
        </template>
      </el-table-column>
      <el-table-column label="生命周期" width="90">
        <template #default="{ row }">
          <el-tag size="small" :type="lifeTone(row.life)">{{ row.life }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="可选 / 占用" min-width="200">
        <template #default="{ row }">
          <span v-if="row.selectable" class="ok">可划拨</span>
          <el-tooltip v-else :content="row.reason" placement="top">
            <span class="blocked">{{ reasonLabel(row.reasonCode) }}</span>
          </el-tooltip>
          <div v-if="row.boundTask" class="text-muted bound">
            {{ row.boundTask.name }}（{{ row.boundTask.status }}）
          </div>
        </template>
      </el-table-column>
    </el-table>
    <DataPager v-model:page="page" v-model:page-size="pageSize" :total="total" :sizes="[50, 100]" />

    <div v-if="selected.size" class="chips">
      <span class="text-muted">已选 {{ selected.size }} 台：</span>
      <el-tag
        v-for="id in [...selected]"
        :key="id"
        closable
        size="small"
        class="chip"
        @close="selected.delete(id)"
      >
        {{ nameOf(id) }}
      </el-tag>
    </div>

    <el-alert
      v-if="blocked.length"
      type="error"
      :closable="false"
      class="blocked-alert"
      :title="`有 ${blocked.length} 台箱子被拦下，整单未提交（共 ${blockedTotal} 台）。请移除被拦箱子或先处理后再试。`"
    >
      <ul class="blocked-list">
        <li v-for="b in blocked" :key="b.boxId">
          <b>{{ b.name || b.code }}</b>
          <span class="mono text-muted">{{ b.code }}</span>
          {{ b.reason }}
        </li>
      </ul>
    </el-alert>

    <template #footer>
      <span class="footer-hint text-muted">
        {{
          selected.size
            ? `提交后 ${selected.size} 台箱子立刻归属 ${targetName || "目标公司"}`
            : "请先选择至少 1 台箱子"
        }}
      </span>
      <el-button @click="emit('update:modelValue', false)">取消</el-button>
      <el-button
        type="primary"
        :loading="saving"
        :disabled="!selected.size || !toOrgId || !name.trim()"
        @click="submit"
      >
        提交划拨{{ selected.size ? `（${selected.size} 台）` : "" }}
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { ElMessage } from "element-plus";
import { Search } from "@element-plus/icons-vue";
import TransferAPI, { type CandidateBox, type CreateBlocked } from "@/api/sample/transfer";
import DeptAPI from "@/api/system/dept";
import type { OptionItem } from "@/api/common";
import DataPager from "@/components/biz/DataPager.vue";
import { lifeTone } from "@/utils/tone";
import type { ApiError } from "@/utils/request";

defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{ "update:modelValue": [value: boolean]; saved: [] }>();

const LIVES = ["待激活", "未使用", "在途", "停用"];
const orgOptions = ref<OptionItem[]>([]);
const toOrgId = ref("");
const name = ref("");
const note = ref("");
const q = ref("");
const orgId = ref("");
const life = ref("");
const rows = ref<CandidateBox[]>([]);
const total = ref(0);
const selectableCount = ref(0);
const page = ref(1);
const pageSize = ref(50);
const loading = ref(false);
const saving = ref(false);
const selected = ref<Set<string>>(new Set());
/** 名字查表：跨页选中的箱子也能显示名称。 */
const nameMap = ref<Record<string, string>>({});
const blocked = ref<CreateBlocked["blocked"]>([]);
const blockedTotal = ref(0);
/** 打开向导时生成一次，重复提交幂等（服务端 transfer_request 唯一约束）。 */
let clientToken = "";

const targetName = computed(() => findLabel(orgOptions.value, toOrgId.value));
function findLabel(list: OptionItem[], value: string): string {
  for (const item of list) {
    if (String(item.value) === value) return item.label;
    if (item.children) {
      const hit = findLabel(item.children, value);
      if (hit) return hit;
    }
  }
  return "";
}
const pageSelectable = computed(() => rows.value.filter((r) => r.selectable));
function nameOf(id: string) {
  return nameMap.value[id] || id;
}
function reasonLabel(code?: string) {
  if (code === "IN_ACTIVE_TASK") return "任务中";
  if (code === "BOX_DISABLED") return "已停用";
  if (code === "ALREADY_TARGET") return "已属目标";
  if (code === "BOX_MISSING") return "已删除";
  if (code === "OUT_OF_SCOPE") return "范围外";
  return "不可选";
}

let seq = 0;
async function loadCandidates() {
  const mine = ++seq;
  loading.value = true;
  try {
    const result = await TransferAPI.candidates({
      q: q.value.trim() || undefined,
      orgId: orgId.value || undefined,
      life: life.value || undefined,
      toOrgId: toOrgId.value || undefined,
      page: page.value,
      pageSize: pageSize.value,
    });
    if (mine !== seq) return;
    rows.value = result.list;
    total.value = result.total;
    selectableCount.value = result.selectableCount;
    for (const r of result.list) nameMap.value[r.boxId] = r.name;
  } finally {
    if (mine === seq) loading.value = false;
  }
}
let typing = 0;
function debouncedLoad() {
  window.clearTimeout(typing);
  typing = window.setTimeout(() => {
    page.value = 1;
    void loadCandidates();
  }, 300);
}
function onTargetChange() {
  page.value = 1;
  // 目标公司变了，ALREADY_TARGET 结论要重算；已选里若含已属目标的箱子，提交时服务端会整单拦下
  void loadCandidates();
}
function toggle(row: CandidateBox) {
  if (!row.selectable) return;
  if (selected.value.has(row.boxId)) selected.value.delete(row.boxId);
  else selected.value.add(row.boxId);
}
function toggleRow(row: CandidateBox) {
  toggle(row);
}
function selectPage() {
  for (const r of pageSelectable.value) selected.value.add(r.boxId);
}
/** 选择全部可选：逐页取回所有 selectable 的 boxId（服务端 pageSize 上限 100）。 */
async function selectAll() {
  loading.value = true;
  try {
    let p = 1;
    for (;;) {
      const result = await TransferAPI.candidates({
        q: q.value.trim() || undefined,
        orgId: orgId.value || undefined,
        life: life.value || undefined,
        toOrgId: toOrgId.value || undefined,
        page: p,
        pageSize: 100,
      });
      for (const r of result.list) {
        nameMap.value[r.boxId] = r.name;
        if (r.selectable) selected.value.add(r.boxId);
      }
      if (p * 100 >= result.total || !result.list.length) break;
      p += 1;
    }
  } finally {
    loading.value = false;
  }
}

async function submit() {
  if (!selected.value.size || !toOrgId.value || !name.value.trim()) return;
  saving.value = true;
  blocked.value = [];
  try {
    const result = await TransferAPI.create({
      name: name.value.trim(),
      toOrgId: toOrgId.value,
      boxIds: [...selected.value],
      note: note.value.trim() || undefined,
      clientToken,
    });
    ElMessage.success(
      result.idempotent
        ? "已提交过，返回原划拨单"
        : `已提交，${result.boxCount} 台箱子归属已转到 ${result.toOrg.name}`
    );
    emit("saved");
    emit("update:modelValue", false);
  } catch (error) {
    const err = error as ApiError;
    const data = err.data as CreateBlocked | undefined;
    if (data?.blocked?.length) {
      blocked.value = data.blocked;
      blockedTotal.value = data.totalCount ?? selected.value.size;
    } else {
      ElMessage.error(err.message || "提交失败");
    }
  } finally {
    saving.value = false;
  }
}

async function onOpen() {
  clientToken =
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : `t-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  name.value = "";
  note.value = "";
  q.value = "";
  orgId.value = "";
  life.value = "";
  toOrgId.value = "";
  page.value = 1;
  selected.value = new Set();
  nameMap.value = {};
  blocked.value = [];
  if (!orgOptions.value.length) {
    try {
      orgOptions.value = await DeptAPI.getOptions();
    } catch {
      orgOptions.value = [];
    }
  }
  void loadCandidates();
}
watch(
  () => [page.value, pageSize.value],
  () => void loadCandidates()
);
onBeforeUnmount(() => window.clearTimeout(typing));
</script>

<style scoped>
.lead {
  margin: 0 0 12px;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}
.picker-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  margin-bottom: 10px;
}
.spacer {
  flex: 1;
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
}
.picker-table :deep(.el-table__row) {
  cursor: pointer;
}
.ok {
  color: var(--el-color-success);
}
.blocked {
  color: var(--el-text-color-placeholder);
  text-decoration: line-through;
}
.bound {
  font-size: 12px;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  margin-top: 10px;
}
.blocked-alert {
  margin-top: 12px;
}
.blocked-list {
  padding-left: 18px;
  margin: 6px 0 0;
}
.blocked-list li {
  margin: 2px 0;
}
.footer-hint {
  float: left;
  font-size: 12px;
  line-height: 32px;
}
</style>
