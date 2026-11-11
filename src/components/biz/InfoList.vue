<template>
  <dl class="info-list" :style="{ '--label-width': labelWidth }">
    <template v-for="item in items" :key="item.label">
      <dt :title="item.tip || undefined">
        {{ item.label }}
        <span v-if="item.tip" class="tip">?</span>
      </dt>
      <dd
        :class="{ mono: item.mono, muted: item.value === '—' || item.value === '' }"
        :data-test="item.test || undefined"
      >
        <slot :name="item.slot || '__none'" :item="item">
          <span class="value">{{ item.value === "" ? "—" : item.value }}</span>
        </slot>
        <button
          v-if="item.copy && item.value && item.value !== '—'"
          type="button"
          class="copy"
          @click="copy(item.copy === true ? item.value : item.copy)"
        >
          复制
        </button>
      </dd>
    </template>
  </dl>
</template>

<script setup lang="ts">
/**
 * 「名称：值」列表。名称列定宽、值左对齐；编号类用等宽字体（mono），可以一键复制（copy）。
 * 值要自己排版的，给 slot 名字，用同名插槽。tip 是悬停在名称上的解释。
 */
export interface InfoItem {
  label: string;
  value: string;
  copy?: boolean | string;
  mono?: boolean;
  tip?: string;
  slot?: string;
  test?: string;
}

withDefaults(defineProps<{ items: InfoItem[]; labelWidth?: string }>(), { labelWidth: "84px" });

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    ElMessage.success("已复制");
  } catch {
    ElMessage.warning("复制失败，请手动选择");
  }
}
</script>

<style scoped>
.info-list {
  display: grid;
  grid-template-columns: var(--label-width) minmax(0, 1fr);
  gap: 10px 12px;
  margin: 0;
  font-size: 13px;
  line-height: 20px;
}
dt {
  color: var(--el-text-color-secondary);
}
.tip {
  display: inline-block;
  width: 14px;
  height: 14px;
  margin-left: 3px;
  font-size: 10px;
  line-height: 14px;
  vertical-align: 1px;
  text-align: center;
  cursor: help;
  border: 1px solid var(--el-border-color);
  border-radius: 50%;
}
dd {
  min-width: 0;
  margin: 0;
  color: var(--el-text-color-primary);
  overflow-wrap: anywhere;
}
dd.mono .value {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12.5px;
}
dd.muted .value {
  color: var(--el-text-color-placeholder);
}
.copy {
  padding: 0;
  margin-left: 8px;
  font: inherit;
  font-size: 12px;
  color: var(--el-color-primary);
  cursor: pointer;
  background: none;
  border: 0;
}
.copy:hover {
  text-decoration: underline;
}
@media (max-width: 480px) {
  .info-list {
    grid-template-columns: 72px minmax(0, 1fr);
  }
}
</style>
