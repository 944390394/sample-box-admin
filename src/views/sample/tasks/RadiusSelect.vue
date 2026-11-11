<template>
  <el-select
    :model-value="modelValue"
    filterable
    allow-create
    default-first-option
    :reserve-keyword="false"
    placeholder="选择或输入，如 800 或 1.5km"
    style="width: 180px"
    @update:model-value="pick"
  >
    <el-option
      v-for="m in options"
      :key="m"
      :value="m"
      :label="radiusText(m) + (m === defaultRadius ? '（默认）' : '')"
    />
  </el-select>
</template>

<script setup lang="ts">
import { ElMessage } from "element-plus";
import { radiusText } from "./radius";

const props = defineProps<{ modelValue: number; defaultRadius: number }>();
const emit = defineEmits<{ "update:modelValue": [value: number] }>();

const PRESETS = [100, 200, 500, 1000, 2000, 3000, 5000, 10000];
const options = computed(() =>
  [...new Set([...PRESETS, props.defaultRadius, props.modelValue])].sort((a, b) => a - b)
);

/** 下拉选中是数字；自己输入的是文字：「800」「800米」「1.5km」「1.5公里」都认，统一换成米。 */
function pick(value: number | string) {
  if (typeof value === "number") return emit("update:modelValue", value);
  const found = String(value)
    .trim()
    .toLowerCase()
    .match(/^(\d+(?:\.\d+)?)\s*(km|公里|千米|m|米)?$/);
  const meters = found
    ? Math.round(Number(found[1]) * (["km", "公里", "千米"].includes(found[2] || "") ? 1000 : 1))
    : NaN;
  if (!Number.isInteger(meters) || meters < 50 || meters > 50000) {
    ElMessage.warning("误差范围要在 50 米到 50 公里之间，例如 800 或 1.5km");
    return;
  }
  emit("update:modelValue", meters);
}
</script>
