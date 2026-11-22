<template>
  <el-dialog
    :model-value="modelValue"
    width="560px"
    style="max-width: 94vw"
    @update:model-value="emit('update:modelValue', $event)"
    @open="onOpen"
  >
    <template #header>
      <span class="dlg-title">{{ actionLabel }} · {{ task?.name }}</span>
      <span class="mono muted">{{ task?.id }}</span>
    </template>
    <p class="hint">{{ hintText }}</p>
    <el-checkbox v-if="showBack" v-model="back" class="back">
      退回寄出单位（{{ task?.fromOrg || "寄出方" }}）：任务加上返程，寄出方扫码接收后结束
    </el-checkbox>
    <div class="f-label">
      {{ reasonLabel }}
      <span v-if="required" class="req">*</span>
      <span class="muted">{{ required ? "（必填，服务端强制）" : "（选填）" }}</span>
    </div>
    <el-input
      v-model="note"
      type="textarea"
      :rows="3"
      maxlength="1000"
      show-word-limit
      :placeholder="placeholder"
      :class="{ 'ta-err': required && !note.trim() }"
    />
    <!-- 恒定 error 槽：红字占位不跳动（预览③），必填未填时确认按钮禁用 -->
    <div class="err-slot">{{ errorText }}</div>
    <div v-if="quickReasons.length" class="quick">
      <button v-for="q in quickReasons" :key="q" type="button" class="q" @click="note = q">
        {{ q }}
      </button>
    </div>
    <template #footer>
      <span class="muted foot-note">与详情页推进同口径：原因校验沿用服务端</span>
      <el-button @click="emit('update:modelValue', false)">取消</el-button>
      <el-button
        :type="buttonType"
        :loading="busy"
        :disabled="required && !note.trim()"
        @click="confirm"
      >
        {{ actionLabel }}
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { ElMessage } from "element-plus";
import API, { type PolicyTask } from "@/api/sample/report-policy";
import { imeiText } from "@/utils/boxLabel";
import { isLocalSample, isMergedSample, NEEDS_REASON, TASK_ACTIONS } from "./status";

/**
 * 列表行内推进弹窗（D6/批6）：按钮入口来自服务端 task.actions，这里只做同一套原因校验与提交。
 * 必填口径＝NEEDS_REASON（拒收/退回/强制签收，服务端 transition 同样强制）；取消选填。
 * 红字恒定 error 槽＋确认禁用态（预览③）；拒收可勾退回（与详情页同逻辑：勾了推进到「退回中」）。
 * 距离/签收核验明细不在列表弹窗重复拉取：服务端 transition 会做同一套核验，异常时拒签并给友好报错。
 */
const props = defineProps<{ modelValue: boolean; task: PolicyTask | null; to: string }>();
const emit = defineEmits<{
  "update:modelValue": [value: boolean];
  /** 推进成功：父页静默刷新列表（不重置滚动/筛选）。 */
  done: [];
}>();

const note = ref("");
const busy = ref(false);
const back = ref(true);

const actionLabel = computed(() => TASK_ACTIONS[props.to] || props.to || "确认");
const required = computed(() => Boolean(NEEDS_REASON[props.to]));
const reasonLabel = computed(() =>
  props.to === "强制签收"
    ? "强制签收原因"
    : props.to === "退回中"
      ? "退回原因"
      : props.to === "已拒收"
        ? "拒收原因"
        : "备注"
);
const placeholder = computed(
  () =>
    NEEDS_REASON[props.to] ||
    (["运送中", "在途"].includes(props.to) ? "备注（选填），如快递单号、外箱情况" : "备注（选填）")
);
const errorText = computed(() =>
  required.value && !note.value.trim() ? `请填写${reasonLabel.value}` : ""
);
const quickReasons = computed(() =>
  props.to === "退回中" || props.to === "已拒收" ? ["样品不合格", "开箱超限", "封条破损"] : []
);
/** 拒收且服务端允许退回：与详情页同逻辑，勾退回则推进到「退回中」。 */
const showBack = computed(
  () => props.to === "已拒收" && Boolean(props.task?.actions?.includes("退回中"))
);
const effectiveTo = computed(() => (showBack.value && back.value ? "退回中" : props.to));
const buttonType = computed(() => {
  const to = effectiveTo.value;
  if (to === "已取消" || to === "已拒收" || to === "退回中") return "danger";
  return to === "强制签收" ? "warning" : "primary";
});

const hintText = computed(() => {
  const t = props.task;
  if (!t) return "";
  const n = t.boxIds?.length ?? 0;
  const to = props.to;
  if (to === "退回中")
    return `拒收并退回：${n} 台箱子退回 ${t.fromOrg || "寄出方"}，任务加上返程；退回途中不能取消。`;
  if (to === "已拒收")
    return showBack.value
      ? `拒收后箱子仍属 ${t.fromOrg || "寄出方"}。勾选退回时任务加上返程，寄出方扫码接收后结束；不勾任务直接结束。`
      : `拒收后箱子仍属 ${t.fromOrg || "寄出方"}，任务结束。`;
  if (to === "强制签收")
    return `指定签收人是 ${t.signer || "签收人"}。你代为签收 ${n} 台采样箱，流转记录里记为「强制签收」并写明原因；箱子改归 ${t.toOrg || "接收方"}。`;
  if (to === "已取消") return "取消后任务结束，箱子恢复原来的上报设置；已经发生的流转记录会保留。";
  if (to === "采样中")
    return `开始采样：${n} 台箱子进入采样阶段${t.recordVideo ? "，在计划地点开箱会自动请求录像" : ""}。`;
  if (to === "已封箱")
    return isLocalSample(t)
      ? `确认样品已装好、${n} 台箱子已封箱。仅本地采样：封箱后任务结束，箱子留在 ${t.org || "采样单位"}。`
      : `确认样品已装好、${n} 台箱子已封箱。封箱后再开箱会记入开箱次数。`;
  if (to === "在途")
    return isMergedSample(t)
      ? `确认 ${n} 台箱子已封箱寄出，寄往 ${t.toOrg || "检测站"}，等待检测站签收。`
      : `确认 ${n} 台箱子已寄回${t.trip ? ` ${t.fromOrg || "寄出单位"}` : ""}。`;
  if (to === "运送中") return `确认 ${n} 台箱子已从 ${t.fromOrg || "寄出方"} 寄出。`;
  if (to === "待签收") return `确认箱子已到达 ${t.toOrg || "接收方"}，等待签收。`;
  if (to === "待采样")
    return t.trip === "双向"
      ? `确认 ${n} 台箱子已送到 ${t.org || "采样单位"}（首腿签收）：箱子归属交采样单位，可以开始采样。`
      : `确认 ${n} 台箱子已送到 ${t.org || "采样单位"}，可以开始采样。`;
  if (to === "待检测")
    return `签收 ${n} 台采样箱${t.toOrg ? `，箱子改归 ${t.toOrg}` : ""}。签收后开箱次数不再累计，开箱检测时每台扫码点「开始检测」。`;
  if (to === "已检测")
    return "整张单的箱子一起开始检测，全部开始后任务结束。也可以在箱子列表里逐台扫码开始检测。";
  if (to === "已退回")
    return `确认退回的 ${n} 台箱子已回到 ${t.fromOrg || "寄出方"}，任务结束，箱子回到在仓库。`;
  return `确认将任务推进到「${to}」？`;
});

function onOpen() {
  note.value = "";
  back.value = true;
  busy.value = false;
}

async function confirm() {
  if (!props.task || (required.value && !note.value.trim())) return;
  busy.value = true;
  try {
    const to = effectiveTo.value;
    const result = await API.transition(props.task.id, to, note.value.trim());
    // R-5：签收交接有跳过的箱子时明确警示，不让成功文案盖住「归属未全移」（与详情页同口径）
    const skipped = result.handOver?.skipped || [];
    if (skipped.length)
      ElMessage.warning({
        message: `签收成功，但 ${skipped.length} 台箱子未随单交接：${skipped
          .slice(0, 3)
          .map((s) => `${imeiText({ id: s.boxId })} ${s.reason}`)
          .join("；")}${skipped.length > 3 ? "等" : ""}。详见详情页顶部警示`,
        duration: 8000,
      });
    else ElMessage.success(`已${TASK_ACTIONS[to] || "更新"}`);
    emit("update:modelValue", false);
    emit("done");
  } finally {
    busy.value = false;
  }
}
</script>

<style scoped>
:deep(.el-dialog__footer) {
  display: flex;
  gap: 8px;
  align-items: center;
}
.dlg-title {
  font-weight: 600;
}
.mono {
  margin-left: 8px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
}
.muted {
  color: var(--el-text-color-secondary);
}
.hint {
  padding: 6px 10px;
  margin: 0 0 10px;
  font-size: 12px;
  color: var(--el-text-color-regular);
  background: var(--el-fill-color-lighter);
  border-radius: 6px;
}
.back {
  margin-bottom: 8px;
}
.f-label {
  margin-bottom: 4px;
  font-size: 12px;
  font-weight: 600;
}
.f-label .req {
  color: var(--el-color-danger);
}
.f-label .muted {
  font-weight: 400;
}
.ta-err :deep(.el-textarea__inner) {
  border-color: var(--el-color-danger);
}
/* 恒定高度 error 槽：有无红字都不跳动（预览③） */
.err-slot {
  height: 18px;
  font-size: 12px;
  line-height: 18px;
  color: var(--el-color-danger);
}
.quick {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.quick .q {
  padding: 1px 8px;
  font-size: 12px;
  color: var(--el-text-color-regular);
  cursor: pointer;
  background: var(--el-fill-color-lighter);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 10px;
}
.quick .q:hover {
  color: var(--el-color-primary);
  border-color: var(--el-color-primary);
}
.foot-note {
  margin-right: auto;
  font-size: 11px;
}
</style>
