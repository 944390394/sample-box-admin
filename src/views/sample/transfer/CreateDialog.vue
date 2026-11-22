<template>
  <el-dialog
    :model-value="modelValue"
    title="批量划拨箱子"
    width="1000px"
    style="max-width: 96vw"
    :close-on-click-modal="false"
    @update:model-value="(v: boolean) => emit('update:modelValue', v)"
    @open="onOpen"
  >
    <!-- #84 弹框精修：四行规则长段→一行灰字短句＋行尾 info 气泡承载原文全文（RULES_FULL 单点常量） -->
    <p class="lead" data-test="transfer-lead">
      {{ RULES_SHORT }}
      <el-tooltip
        placement="top"
        effect="light"
        :content="RULES_FULL"
        :popper-style="{ maxWidth: '360px' }"
      >
        <el-icon class="lead-info" tabindex="0" data-test="transfer-lead-info">
          <QuestionFilled />
        </el-icon>
      </el-tooltip>
    </p>

    <el-form label-width="100px" class="form-grid" @submit.prevent>
      <el-form-item label="目标公司" required>
        <el-tree-select
          v-model="toOrgId"
          :data="orgOptions"
          check-strictly
          filterable
          clearable
          placeholder="箱子归属要转到的公司"
          style="width: 100%"
          :render-after-expand="false"
          @change="onTargetChange"
        />
      </el-form-item>
      <el-form-item label="划拨单名称" required>
        <el-input
          v-model="name"
          maxlength="120"
          placeholder="比如：华南区开工补给"
          style="width: 100%"
        />
      </el-form-item>
      <el-form-item label="快递单号">
        <el-input
          v-model="trackingNo"
          maxlength="64"
          placeholder="选填，接受前可补填/修改，接受后只读"
          style="width: 100%"
        />
      </el-form-item>
      <el-form-item label="备注" class="span-2">
        <el-input
          v-model="note"
          type="textarea"
          :rows="2"
          maxlength="1000"
          placeholder="选填，记进操作记录"
          style="width: 100%"
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
      <span class="picker-links">
        <el-button link type="primary" :disabled="!pageSelectable.length" @click="selectPage">
          全选本页
        </el-button>
        <el-button link type="primary" :disabled="!selectableCount" @click="selectAll">
          选择全部 {{ selectableCount }} 台可选
        </el-button>
        <el-button link :disabled="!selected.size" @click="selected.clear()">清空</el-button>
      </span>
    </div>

    <el-table
      v-loading="loading"
      :data="rows"
      :max-height="320"
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

    <!-- #84：已选 chips 紧贴表底（表→chips→翻页），单行自适应后不再隔翻页留白 -->
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

    <DataPager v-model:page="page" v-model:page-size="pageSize" :total="total" :sizes="[50, 100]" />

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
            ? `提交后 ${selected.size} 台箱子待 ${targetName || "目标公司"} 管理员接受`
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

  <!-- R24（#70）二次确认：摘要 N 台·来源→目标·不可撤销提示＋登录密码。
       红字占位恒定高度（visibility 切换），出错前后布局不跳动（R18 登录页同款口径）。 -->
  <el-dialog
    v-model="confirmOpen"
    title="二次确认：提交划拨"
    width="480px"
    style="max-width: 94vw"
    :close-on-click-modal="false"
    append-to-body
  >
    <div class="confirm-summary">
      <p>
        即将划拨
        <b>{{ selected.size }}</b>
        台采样箱：
      </p>
      <p class="route-line">
        <b>{{ sourceText }}</b>
        <span class="arrow">→</span>
        <b>{{ targetName || "目标公司" }}</b>
      </p>
      <p v-if="trackingNo.trim()" class="route-line mono">快递单号：{{ trackingNo.trim() }}</p>
      <p class="warn-line">{{ RULES_SHORT }}</p>
    </div>
    <el-form label-width="100px" @submit.prevent>
      <el-form-item label="登录密码" required>
        <el-input
          v-model="password"
          type="password"
          show-password
          autocomplete="new-password"
          placeholder="当前登录账号的密码"
          style="width: 280px"
          @keyup.enter="confirmSubmit"
        />
      </el-form-item>
    </el-form>
    <p class="pw-error" :class="{ on: pwError }">{{ pwError || " " }}</p>
    <template #footer>
      <el-button @click="confirmOpen = false">取消</el-button>
      <el-button type="primary" :loading="saving" :disabled="!password" @click="confirmSubmit">
        确认提交
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { ElMessage } from "element-plus";
import { Search, QuestionFilled } from "@element-plus/icons-vue";
import TransferAPI, { type CandidateBox, type CreateBlocked } from "@/api/sample/transfer";
import DeptAPI from "@/api/system/dept";
import type { OptionItem } from "@/api/common";
import DataPager from "@/components/biz/DataPager.vue";
import { lifeTone } from "@/utils/tone";
import type { ApiError } from "@/utils/request";

/**
 * #84 弹框精修（仅呈现）：可见层只留一行灰字短句，规则原文全文收进行尾 info 气泡。
 * 两个常量单点维护防漂移；短句与二次确认弹框 warn-line 共用同一来源。
 */
const RULES_SHORT = "提交后待目标分公司管理员接受；接受前可取消/拒收。";
const RULES_FULL =
  "选目标公司，再勾选一批箱子。创建后待目标分公司管理员接受：接受时箱子归属才转到目标公司（保管人清空）。接受前创建方可取消、接收方可拒收（原因必填）；接受后不可撤销（退回/改派请用列表的「重新划拨」）。提交前需输入登录密码二次确认。";

/**
 * R24（#70）prefill：列表「重新划拨」带进来的原单箱集（重放语义）。
 * 箱集先整体选中，名称用原单快照兜底；当前归属/可选性仍由服务端候选集逐页回填判定，
 * 已属目标/被占用的箱子提交时会被服务端同一守卫整单拦下——预填不是绕过守卫。
 */
const props = defineProps<{
  modelValue: boolean;
  prefill?: { boxIds: string[]; names: Record<string, string>; fromName: string } | null;
}>();
const emit = defineEmits<{ "update:modelValue": [value: boolean]; saved: [] }>();

const LIVES = ["待激活", "未使用", "在途", "停用"];
const orgOptions = ref<OptionItem[]>([]);
const toOrgId = ref("");
const name = ref("");
const note = ref("");
/** R25③ 快递单号选填 ≤64（接受前创建方可补填/修改，接受后只读）。 */
const trackingNo = ref("");
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
/** 当前归属查表（候选集回填）：二次确认摘要的「来源」按箱子当前归属聚合，不是原单快照。 */
const orgMap = ref<Record<string, string>>({});
const blocked = ref<CreateBlocked["blocked"]>([]);
const blockedTotal = ref(0);
/** R24（#70）二次确认弹框：密码每次打开清空；红字只在这个弹框里呈现。 */
const confirmOpen = ref(false);
const password = ref("");
const pwError = ref("");
/** 打开向导时生成一次，重复提交幂等（服务端 transfer_request 唯一约束）。 */
let clientToken = "";

const targetName = computed(() => findLabel(orgOptions.value, toOrgId.value));
/** 摘要来源：已选箱子的当前归属去重聚合；候选集还没回填到的显示「原公司」兜底。 */
const sourceText = computed(() => {
  const names = new Set<string>();
  for (const id of selected.value) {
    const org = orgMap.value[id];
    if (org) names.add(org);
  }
  return names.size ? [...names].join("、") : "原公司";
});
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
    for (const r of result.list) {
      nameMap.value[r.boxId] = r.name;
      orgMap.value[r.boxId] = r.org || "总公司";
    }
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
        orgMap.value[r.boxId] = r.org || "总公司";
        if (r.selectable) selected.value.add(r.boxId);
      }
      if (p * 100 >= result.total || !result.list.length) break;
      p += 1;
    }
  } finally {
    loading.value = false;
  }
}

/**
 * R24（#70）：主弹框「提交划拨」不再直接发请求，先开二次确认弹框（摘要＋登录密码）。
 * 真正提交在 confirmSubmit；clientToken 沿用打开向导时生成的那一个，
 * 确认弹框里重试（含输错密码后重输）不会重复建单——服务端幂等命中前仍会再验密码。
 */
function submit() {
  if (!selected.value.size || !toOrgId.value || !name.value.trim()) return;
  password.value = "";
  pwError.value = "";
  confirmOpen.value = true;
}

async function confirmSubmit() {
  if (!password.value || saving.value) return;
  saving.value = true;
  pwError.value = "";
  blocked.value = [];
  try {
    const result = await TransferAPI.create({
      name: name.value.trim(),
      toOrgId: toOrgId.value,
      boxIds: [...selected.value],
      note: note.value.trim() || undefined,
      trackingNo: trackingNo.value.trim() || undefined,
      clientToken,
      password: password.value,
    });
    ElMessage.success(
      result.idempotent
        ? "已提交过，返回原划拨单"
        : `已提交，${result.boxCount} 台箱子待 ${result.toOrg.name} 管理员接受`
    );
    confirmOpen.value = false;
    emit("saved");
    emit("update:modelValue", false);
  } catch (error) {
    const err = error as ApiError;
    const data = err.data as CreateBlocked | undefined;
    if (data?.blocked?.length) {
      // 逐台拦截：回主弹框渲染被拦清单（原口径），确认弹框收起
      blocked.value = data.blocked;
      blockedTotal.value = data.totalCount ?? selected.value.size;
      confirmOpen.value = false;
    } else {
      // 400 缺口令 / 403 口令错 / 其它：红字恒定占位呈现，不跳登录、不弹全局 toast
      pwError.value = err.message || "提交失败";
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
  trackingNo.value = "";
  q.value = "";
  orgId.value = "";
  life.value = "";
  toOrgId.value = "";
  page.value = 1;
  selected.value = new Set();
  nameMap.value = {};
  orgMap.value = {};
  blocked.value = [];
  confirmOpen.value = false;
  password.value = "";
  pwError.value = "";
  // R24（#70）重新划拨：原单箱集整体预选＋单名预填（可改）；名称先用原单快照兜底，
  // 当前归属由 harvestPrefill 逐页回填，摘要「来源」按箱子当前归属聚合。
  const prefill = props.prefill;
  if (prefill?.boxIds?.length) {
    name.value = prefill.fromName || "";
    selected.value = new Set(prefill.boxIds);
    for (const [id, label] of Object.entries(prefill.names || {})) nameMap.value[id] = label;
  }
  if (!orgOptions.value.length) {
    try {
      orgOptions.value = await DeptAPI.getOptions();
    } catch {
      orgOptions.value = [];
    }
  }
  void loadCandidates();
  if (prefill?.boxIds?.length) void harvestPrefill(prefill.boxIds);
}
/**
 * 预填箱集跨页补齐名称/当前归属：逐页取候选（服务端 pageSize 上限 100），
 * 找齐即停；用户改了筛选（seq 变化）就放弃，不与当前页加载抢状态。
 */
async function harvestPrefill(ids: string[]) {
  const want = new Set(ids);
  const mine = seq;
  let p = 1;
  for (;;) {
    const result = await TransferAPI.candidates({ page: p, pageSize: 100 });
    if (mine !== seq) return;
    for (const r of result.list) {
      nameMap.value[r.boxId] = r.name;
      orgMap.value[r.boxId] = r.org || "总公司";
      want.delete(r.boxId);
    }
    if (!want.size || p * 100 >= result.total || !result.list.length) break;
    p += 1;
  }
}
watch(
  () => props.modelValue,
  (open) => {
    if (!open) confirmOpen.value = false;
  }
);
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
/* #84：行尾 info 图标沿用 tasks/index.vue .qmark／create.vue .tip-info 字阶配色；气泡限宽走 popper-style */
.lead-info {
  margin-left: 4px;
  font-size: 14px;
  vertical-align: -2px;
  color: var(--el-text-color-placeholder);
  cursor: help;
}
/* #84：表单双列栅格撑满弹框内容列（目标公司｜划拨单名称／快递单号／备注跨列）；
   控件 100% 随列宽，消除固定 px 宽的右半空白；1280 档回落单列。间距走 4px 网格。 */
.form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0 16px;
  align-items: start;
}
.form-grid .span-2 {
  grid-column: 1 / -1;
}
@media (max-width: 1280px) {
  .form-grid {
    grid-template-columns: 1fr;
  }
}
.picker-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  margin-bottom: 10px;
}
/* #84：三链接收成一组的右对齐 flex，换行时整组落行不挤散 */
.picker-links {
  display: flex;
  gap: 4px;
  align-items: center;
  margin-left: auto;
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
  margin-top: 8px;
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
.confirm-summary p {
  margin: 0 0 8px;
  font-size: 13px;
}
.route-line {
  font-size: 14px;
}
.route-line .arrow {
  margin: 0 6px;
  color: var(--el-color-primary);
}
.warn-line {
  color: var(--el-color-warning);
}
/* 红字恒定占位：固定高度＋visibility 切换，出错前后 bbox 不变（不跳动） */
.pw-error {
  visibility: hidden;
  height: 20px;
  margin: 0 0 0 100px;
  font-size: 12px;
  line-height: 20px;
  color: var(--el-color-danger);
}
.pw-error.on {
  visibility: visible;
}
</style>
