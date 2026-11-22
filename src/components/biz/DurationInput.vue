<template>
  <div class="duration-input" :class="{ 'is-inline': inlineChips }">
    <!-- 只读态（无权限/继承）：归一文本，不可编辑 -->
    <div v-if="disabled" class="duration-line">
      <span class="duration-readonly">{{ formatDuration(whole) }}</span>
      <span v-if="whole >= 60" class="duration-equals">＝ {{ whole }} 秒</span>
    </div>
    <template v-else>
      <div class="duration-line">
        <el-tooltip :visible="hintVisible" :content="hintText" placement="top">
          <div
            class="duration-parts"
            role="group"
            aria-label="上报周期（时/分/秒）"
            @mouseenter="showRangeHint"
            @mouseleave="hideRangeHint"
            @focusin="showRangeHint"
            @focusout="onPartsFocusOut"
          >
            <el-input-number
              :model-value="parts.hours"
              class="duration-part"
              :min="0"
              :max="23"
              :step="1"
              :precision="0"
              controls-position="right"
              aria-label="上报周期·时"
              @change="(v) => onPart('hours', v)"
            />
            <span class="duration-unit">时</span>
            <el-input-number
              :model-value="parts.minutes"
              class="duration-part"
              :min="0"
              :max="max"
              :step="1"
              :precision="0"
              controls-position="right"
              aria-label="上报周期·分"
              @change="(v) => onPart('minutes', v)"
            />
            <span class="duration-unit">分</span>
            <el-input-number
              :model-value="parts.seconds"
              class="duration-part"
              :min="0"
              :max="max"
              :step="1"
              :precision="0"
              controls-position="right"
              aria-label="上报周期·秒"
              @change="(v) => onPart('seconds', v)"
            />
            <span class="duration-unit">秒</span>
          </div>
        </el-tooltip>
        <span class="duration-equals" aria-live="polite">{{ durationEquals(whole) }}</span>
      </div>
      <div class="duration-chips" role="group" aria-label="上报周期快捷值">
        <el-button
          v-for="chip in chips"
          :key="chip.value"
          size="small"
          :round="inlineChips"
          :type="whole === chip.value ? 'primary' : 'default'"
          :aria-pressed="whole === chip.value"
          @click="pick(chip.value)"
        >
          {{ chip.label }}
        </el-button>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import {
  applyDurationPart,
  clampDuration,
  durationChips,
  durationEquals,
  formatDuration,
  joinDuration,
  splitDuration,
} from "@/utils/duration";
import type { DurationPartKey } from "@/utils/duration";

/**
 * 上报周期时分秒联动输入（R14）。
 * - v-model＝总秒数整数（存储口径不变，服务端仍校验 5–3600）；
 * - 任一分量变化 → 重算总量 → 自动进位归一显示（输入 90 秒 → 0时1分30秒）；
 * - 灰字恒写「＝ X 秒」，≥60 秒附自适应归一括号（分秒/时分）；
 * - 超范围输入 clamp 到 [min, max] 并弹范围 tooltip；chips 按 min/max 过滤；
 * - disabled（无权限/继承态）只显示归一文本。
 * 分量上限：时 0–23；分/秒 stepper 放宽到总量 max 以接受进位输入（90 秒/60 分），
 * 超量统一由 applyDurationPart clamp；分量清空（null）忽略，el-input-number 回弹显示。
 * 只监听 @change（blur/Enter/步进提交）不监听逐键 update:modelValue：归一会改变分量绑定值，
 * 逐键应用＋提交再应用会把同一输入叠算两次（600+90→690 再 +90→750）；提交时应用一次则无此问题。
 * inlineChips（opt-in，#90 公司策略中心网格版式）：stepper＋＝X 秒＋chips 同行单行排布，
 * 分量收窄 64px、chips 改 round 小按钮；默认 false 两行版式不变（BoxPolicySettings 等调用点零回归）。
 */
defineOptions({ name: "DurationInput" });

const props = withDefaults(
  defineProps<{
    /** 总秒数（整数）。 */
    modelValue: number;
    min?: number;
    max?: number;
    disabled?: boolean;
    /** chips 与 stepper 同行（公司策略中心网格版式 opt-in）。 */
    inlineChips?: boolean;
  }>(),
  { min: 5, max: 3600, disabled: false, inlineChips: false }
);
const emit = defineEmits<{ (e: "update:modelValue", value: number): void }>();

const parts = computed(() => splitDuration(props.modelValue));
/** 归一后的总秒数（modelValue 非法/小数时兜底为非负整数）。 */
const whole = computed(() => joinDuration(parts.value));
const chips = computed(() => durationChips(props.min, props.max));

function onPart(key: DurationPartKey, value: number | null | undefined) {
  if (value == null || Number.isNaN(Number(value))) return;
  const { total, clamped } = applyDurationPart(
    parts.value,
    key,
    Number(value),
    props.min,
    props.max
  );
  if (clamped) showClampHint(total);
  if (total !== props.modelValue) emit("update:modelValue", total);
}

function pick(value: number) {
  const total = clampDuration(value, props.min, props.max);
  if (total !== value) showClampHint(total);
  emit("update:modelValue", total);
}

/* ── 范围 tooltip：hover/键盘聚焦显示范围；clamp 时显示调整结果，2.6s 后自动收起 ── */
const hintVisible = ref(false);
const hintText = ref("");
let hintTimer: ReturnType<typeof setTimeout> | undefined;
let clampHold = false;

function showRangeHint() {
  if (clampHold) return;
  hintText.value = `范围 ${props.min}–${props.max} 秒`;
  hintVisible.value = true;
}
function hideRangeHint() {
  if (clampHold) return;
  hintVisible.value = false;
}
/** 焦点在三个分量间移动不算离开组（focusout 冒泡）。 */
function onPartsFocusOut(e: FocusEvent) {
  const root = e.currentTarget as HTMLElement | null;
  if (root && e.relatedTarget instanceof Node && root.contains(e.relatedTarget)) return;
  hideRangeHint();
}
function showClampHint(total: number) {
  clampHold = true;
  hintText.value = `超出范围（${props.min}–${props.max} 秒），已调整为 ${formatDuration(total)}`;
  hintVisible.value = true;
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => {
    clampHold = false;
    hintVisible.value = false;
  }, 2600);
}
onBeforeUnmount(() => clearTimeout(hintTimer));
</script>

<style lang="scss" scoped>
.duration-input {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.duration-line {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 12px;
  align-items: center;
}
.duration-parts {
  display: inline-flex;
  gap: 6px;
  align-items: center;
}
.duration-part {
  width: 92px;
}
.duration-unit {
  margin-right: 2px;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}
.duration-equals {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.duration-readonly {
  font-size: 13px;
  color: var(--el-text-color-regular);
}
.duration-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.duration-chips .el-button + .el-button {
  margin-left: 0;
}
/* opt-in 同行版式（#90）：stepper＋＝X 秒＋chips 单行；默认两行版式不受影响 */
.duration-input.is-inline {
  flex-direction: row;
  gap: 8px;
  align-items: center;
}
.duration-input.is-inline .duration-line {
  flex-shrink: 0;
  flex-wrap: nowrap;
  gap: 6px 8px;
}
.duration-input.is-inline .duration-part {
  width: 64px;
}
.duration-input.is-inline .duration-equals {
  font-size: 11px;
  white-space: nowrap;
}
.duration-input.is-inline .duration-chips {
  flex-wrap: nowrap;
  gap: 4px;
  min-width: 0;
}
.duration-input.is-inline .duration-chips .el-button {
  height: 24px;
  padding: 0 8px;
  font-size: 12px;
}
</style>
