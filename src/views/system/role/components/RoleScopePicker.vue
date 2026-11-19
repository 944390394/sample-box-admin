<template>
  <div class="scope-picker">
    <el-select
      :model-value="modelValue"
      :disabled="disabled || adminFixed"
      style="width: 100%"
      data-test="scope-select"
      @update:model-value="onScope"
    >
      <el-option
        v-for="(label, value) in SCOPES"
        :key="value"
        :label="`${label}：${SCOPE_HINTS[Number(value)]}`"
        :value="Number(value)"
        :disabled="optionDisabled(Number(value))"
      />
    </el-select>
    <!-- 自定义（5）：部门多选树。选项是后端 scoped options（manage 子树+祖先壳），
         壳节点 disabled:'readOnly' 禁选（镜像 B3 口径）；勾选的单位含其下级（后端子树并集）。 -->
    <el-tree-select
      v-if="Number(modelValue) === 5"
      :model-value="deptIds || []"
      :data="options"
      :props="{ label: 'label', children: 'children', disabled: 'readOnly' }"
      node-key="value"
      multiple
      show-checkbox
      check-strictly
      default-expand-all
      collapse-tags
      collapse-tags-tooltip
      :max-collapse-tags="3"
      :disabled="disabled || adminFixed"
      placeholder="勾选能看到的单位（含其下级）"
      style="width: 100%; margin-top: 8px"
      data-test="scope-dept-tree"
      @update:model-value="onDepts"
    >
      <template #default="{ data }">
        <span :class="{ shell: data.readOnly }">
          {{ data.label }}
          <el-tooltip v-if="data.readOnly" content="上级单位仅可见不可管" placement="top">
            <el-tag size="small" type="info" effect="plain">仅可见</el-tag>
          </el-tooltip>
        </span>
      </template>
    </el-tree-select>
    <p class="text-muted small">
      <template v-if="adminFixed">系统管理员固定是全部数据。</template>
      <template v-else-if="disabled">
        改数据范围要有「设置角色数据范围」。
        <template v-if="creating">新角色先是「仅本人」。</template>
      </template>
      <template v-else-if="Number(modelValue) === 5">
        勾选的单位含其下级；上级单位仅可见不可管。没勾选任何单位时，这个角色看不到任何单位的数据。
      </template>
      <template v-else>
        决定能看到哪些单位的采样箱、任务和人员；不能比你自己的宽，还会被所在部门的「最大数据范围」封顶。
      </template>
      <template v-if="!adminFixed && !disabled && myScope > 1">
        比你自己的数据范围（{{ SCOPES[myScope] }}）宽的选项不可选。
      </template>
    </p>
  </div>
</template>

<script setup lang="ts">
import type { OptionItem } from "@/api/common";

/**
 * #26 B4：角色数据范围选择器（1 全部 / 2 本单位及下级 / 3 本单位 / 4 仅本人 / 5 自定义）。
 * 选 5 时出部门多选树：选项用后端 scoped options，祖先壳节点禁选（disabled:'readOnly'，镜像 B3）。
 * D3 前端预校验：比我自己宽的范围禁选；仅 scope≤2 能授 5；自定义部门只能选 manage 内的
 * （options 已按 manage 裁剪+壳禁选，结构上保证；保存时父页再查一遍，服务端兜底）。
 */
const props = withDefaults(
  defineProps<{
    modelValue?: number;
    deptIds?: string[];
    options: OptionItem[];
    disabled?: boolean;
    /** 自己最宽的数据范围（permCatalog.myScope，管理员 1） */
    myScope?: number;
    /** 系统管理员角色：固定全部数据 */
    adminFixed?: boolean;
    /** 新建角色场景：无「设置角色数据范围」时提示新角色先是仅本人 */
    creating?: boolean;
  }>(),
  {
    modelValue: 4,
    deptIds: () => [],
    disabled: false,
    myScope: 4,
    adminFixed: false,
    creating: false,
  }
);
const emit = defineEmits<{
  "update:modelValue": [number];
  "update:deptIds": [string[]];
}>();

const SCOPES: Record<number, string> = {
  1: "全部数据",
  2: "本单位及下级",
  3: "本单位",
  4: "仅本人",
  5: "自定义部门数据",
};
const SCOPE_HINTS: Record<number, string> = {
  1: "所有单位的箱子、任务和人员",
  2: "自己单位和下属单位的",
  3: "只有自己单位的",
  4: "只有自己保管的箱子和经手的任务",
  5: "只看勾选的单位（含其下级）",
};

/** 比我自己宽的禁选；自定义 5 仅 scope≤2 可授（D3）。 */
function optionDisabled(value: number) {
  if (value === 5) return props.myScope > 2;
  return value < props.myScope;
}
function onScope(value: number) {
  emit("update:modelValue", Number(value));
}
function onDepts(value: (string | number)[]) {
  emit("update:deptIds", (value || []).map(String));
}
</script>

<style scoped>
.scope-picker .small {
  margin: 4px 0 0;
  font-size: 12px;
}
.shell {
  color: var(--el-text-color-placeholder);
}
.shell .el-tag {
  margin-left: 6px;
}
</style>
