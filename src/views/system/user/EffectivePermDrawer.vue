<template>
  <el-drawer
    :model-value="modelValue"
    :title="data ? `实际权限 · ${data.user.name || data.user.username}` : '实际权限'"
    size="560px"
    class="eff-drawer"
    data-test="effective-perms"
    @update:model-value="(v: boolean) => emit('update:modelValue', v)"
  >
    <div v-loading="loading" class="eff">
      <template v-if="data">
        <el-alert v-if="data.admin" type="success" :closable="false" show-icon class="block">
          系统管理员：固定拥有全部权限、全部数据，不受部门上限约束。
        </el-alert>

        <section class="block">
          <h4>角色</h4>
          <div v-if="data.roles.length" class="chips">
            <span
              v-for="role in data.roles"
              :key="role.id"
              class="chip"
              :class="{ off: !role.active }"
            >
              {{ role.name }}
              <em>{{ role.active ? role.scope : "已停用，不生效" }}</em>
            </span>
          </div>
          <p v-else class="text-muted">没有角色，什么都做不了。</p>
        </section>

        <section class="block">
          <h4>所在部门这条线的上限</h4>
          <ol class="chain">
            <li v-for="dept in data.chain" :key="dept.id" :class="{ limited: dept.limited }">
              <b>{{ dept.name }}</b>
              <span>{{ dept.limited ? `单独限制，最多 ${dept.count} 项` : "跟上级一样" }}</span>
              <span v-if="dept.maxScope">最大数据范围：{{ dept.maxScope }}</span>
            </li>
          </ol>
        </section>

        <section class="block">
          <h4>数据范围</h4>
          <p class="scope">
            角色里最宽：
            <b>{{ data.scope.roles }}</b>
            <template v-if="data.scope.cap">
              → 部门封顶：
              <b>{{ data.scope.cap }}</b>
            </template>
            → 实际：
            <b class="hl">{{ data.scope.effective }}</b>
          </p>
        </section>

        <section class="block">
          <div class="items-head">
            <h4>逐项权限</h4>
            <span class="text-muted">
              能用 {{ counts.has }} 项
              <template v-if="counts.cut">· 被部门上限挡住 {{ counts.cut }} 项</template>
              · 能转授 {{ counts.grant }} 项
            </span>
          </div>
          <div class="tools">
            <el-input
              v-model="word"
              :prefix-icon="Search"
              placeholder="搜权限"
              clearable
              style="width: 200px"
            />
            <el-radio-group v-model="filter" size="small">
              <el-radio-button value="related">有关的</el-radio-button>
              <el-radio-button value="has">能用的</el-radio-button>
              <el-radio-button value="cut">被挡住的</el-radio-button>
              <el-radio-button value="all">全部</el-radio-button>
            </el-radio-group>
          </div>
          <div v-for="mod in shown" :key="mod.key" class="mod">
            <h5>
              {{ mod.label }}
              <span class="text-muted">{{ mod.has }}/{{ mod.total }}</span>
            </h5>
            <div
              v-for="row in mod.rows"
              :key="row.code"
              class="row"
              :class="row.state"
              :data-code="row.code"
            >
              <el-icon class="state">
                <component
                  :is="row.state === 'has' ? Check : row.state === 'cut' ? WarningFilled : Minus"
                />
              </el-icon>
              <div class="text">
                <div>
                  {{ row.label }}
                  <el-tag v-if="row.grantable" size="small" effect="plain" class="tag">
                    可转授
                  </el-tag>
                </div>
                <p class="src">{{ row.source }}</p>
              </div>
            </div>
          </div>
          <el-empty v-if="!shown.length" description="没有符合的权限" :image-size="60" />
        </section>
      </template>
    </div>
  </el-drawer>
</template>

<script setup lang="ts">
import { Check, Minus, Search, WarningFilled } from "@element-plus/icons-vue";
import RoleAPI, { type PermGroup } from "@/api/system/role";
import UserAPI, { type EffectivePerms } from "@/api/system/user";

/**
 * 人员的实际权限：角色之和 ∩ 部门这条线的上限。逐项写清来源（来自哪些角色），
 * 或者「角色里有，但被某部门的上限挡住」；数据范围怎么算出来的也写出来。排查「他为什么能 / 不能做某事」用。
 */
const props = defineProps<{ modelValue: boolean; userId: string }>();
const emit = defineEmits<{ "update:modelValue": [boolean] }>();

const loading = ref(false);
const data = ref<EffectivePerms | null>(null);
const groups = ref<PermGroup[]>([]);
const word = ref("");
const filter = ref<"related" | "has" | "cut" | "all">("related");

const byCode = computed(() => new Map((data.value?.items || []).map((item) => [item.code, item])));
const counts = computed(() => {
  const items = data.value?.items || [];
  return {
    has: items.filter((i) => i.has).length,
    cut: items.filter((i) => i.cutBy).length,
    grant: items.filter((i) => i.grantable).length,
  };
});
const shown = computed(() => {
  const key = word.value.trim();
  return groups.value
    .map((group) => {
      const rows = group.items
        .map((perm) => {
          const item = byCode.value.get(perm.code);
          const state = item?.has ? "has" : item?.cutBy ? "cut" : "none";
          const source = data.value?.admin
            ? "系统管理员"
            : item?.has
              ? `来自 ${item.roles.join("、")}`
              : item?.cutBy
                ? `角色里有（${item.roles.join("、")}），但被「${item.cutBy}」的上限挡住`
                : "没有";
          return {
            code: perm.code,
            label: perm.label,
            hint: perm.hint || "",
            state,
            source,
            grantable: Boolean(item?.grantable),
          };
        })
        .filter((row) => {
          if (filter.value === "has" && row.state !== "has") return false;
          if (filter.value === "cut" && row.state !== "cut") return false;
          if (filter.value === "related" && row.state === "none") return false;
          return !key || `${group.label}${row.label}${row.hint}`.includes(key);
        });
      const all = group.items.map((perm) => byCode.value.get(perm.code));
      return {
        key: group.key,
        label: group.label,
        rows,
        total: all.length,
        has: all.filter((i) => i?.has).length,
      };
    })
    .filter((mod) => mod.rows.length);
});

async function load() {
  if (!props.userId) return;
  loading.value = true;
  try {
    if (!groups.value.length) groups.value = (await RoleAPI.permCatalog()).groups;
    data.value = await UserAPI.getEffectivePerms(props.userId);
  } finally {
    loading.value = false;
  }
}
watch(
  () => [props.modelValue, props.userId],
  ([open]) => {
    if (open) {
      data.value = null;
      word.value = "";
      filter.value = "related";
      void load();
    }
  },
  { immediate: true }
);
</script>

<style scoped>
.block {
  margin-bottom: 16px;
}
.block h4 {
  margin: 0 0 8px;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.chip {
  padding: 2px 8px;
  font-size: 13px;
  background: var(--el-color-primary-light-9);
  border-radius: 4px;
}
.chip em {
  margin-left: 6px;
  font-size: 12px;
  font-style: normal;
  color: var(--el-text-color-secondary);
}
.chip.off {
  color: var(--el-text-color-placeholder);
  background: var(--el-fill-color-light);
}
.chain {
  padding-left: 20px;
  margin: 0;
}
.chain li {
  padding: 2px 0;
  font-size: 13px;
}
.chain li span {
  margin-left: 8px;
  color: var(--el-text-color-secondary);
}
.chain li.limited span:first-of-type {
  color: var(--el-color-warning-dark-2);
}
.scope {
  margin: 0;
  font-size: 13px;
}
.hl {
  color: var(--el-color-primary);
}
.items-head {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  align-items: baseline;
  justify-content: space-between;
}
.items-head span {
  font-size: 12px;
}
.tools {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  margin-bottom: 8px;
}
.mod h5 {
  margin: 12px 0 4px;
  font-size: 13px;
}
.row {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  padding: 5px 0;
  border-top: 1px solid var(--el-border-color-extra-light);
}
.row .state {
  margin-top: 3px;
}
.row.has .state {
  color: var(--el-color-success);
}
.row.cut .state {
  color: var(--el-color-warning);
}
.row.none {
  color: var(--el-text-color-placeholder);
}
.text {
  font-size: 13px;
}
.src {
  margin: 0;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.row.cut .src {
  color: var(--el-color-warning-dark-2);
}
.tag {
  margin-left: 6px;
}
</style>
