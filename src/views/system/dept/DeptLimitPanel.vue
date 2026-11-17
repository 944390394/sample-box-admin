<template>
  <div v-loading="loading" class="limit-panel" data-test="dept-limit">
    <template v-if="data">
      <div class="chain">
        <span class="text-muted">上级：</span>
        <template v-if="data.parent.chain.length">
          <span v-for="(dept, i) in data.parent.chain" :key="dept.id">
            <span v-if="i" class="sep">/</span>
            {{ dept.name }}
            <em>{{ dept.limited ? "（单独限制）" : "（跟上级一样）" }}</em>
          </span>
        </template>
        <span v-else>无，这是顶级部门</span>
      </div>

      <el-alert type="info" :closable="false" class="intro">
        部门权限上限只封顶、不授权：这个部门（和它的下级部门）的人，角色里有的权限超出上限也用不了。下级只能在上级的范围里勾。
        本部门现在有 {{ data.users }} 个人直接挂在这里，下级部门也受影响。
      </el-alert>

      <div class="mode">
        <el-radio-group v-model="limited" :disabled="!data.editable" data-test="limit-mode">
          <el-radio-button :value="false">跟上级一样</el-radio-button>
          <el-radio-button :value="true">单独限制</el-radio-button>
        </el-radio-group>
        <div class="scope">
          <span>最大数据范围</span>
          <el-select
            v-model="maxScope"
            :disabled="!data.editable"
            style="width: 200px"
            data-test="limit-scope"
          >
            <el-option
              :value="0"
              :label="data.parent.maxScope ? `跟上级（${SCOPES[data.parent.maxScope]}）` : '不限'"
            />
            <el-option
              v-for="(label, value) in SCOPES"
              :key="value"
              :value="Number(value)"
              :label="label"
              :disabled="scopeDisabled(Number(value))"
            />
          </el-select>
        </div>
      </div>
      <p v-if="!data.editable" class="text-muted small">
        {{
          hasLimitPerm
            ? "这个部门不在你的管理范围里，只能查看。"
            : "没有「设置部门权限上限」，只能查看。"
        }}
      </p>

      <el-alert
        v-if="limited && revoked.length"
        type="warning"
        :closable="false"
        show-icon
        class="intro"
      >
        有 {{ revoked.length }} 项上级已收回，在这个部门不生效：{{
          revokedNames
        }}。保存时会一起去掉。
      </el-alert>

      <p class="summary">
        <template v-if="!limited">
          这个部门的人最多能用：{{
            parentPerms ? `上级允许的 ${parentPerms.size} 项` : `全部 ${allCount} 项（不限）`
          }}。下面是这个范围，只能看。
        </template>
        <template v-else>
          勾的是这个部门的人最多能用的权限，现在勾了 {{ codes.size }} 项（上级允许
          {{ parentPerms ? parentPerms.size : allCount }} 项）。
        </template>
      </p>

      <PermEditor
        v-model:codes="codes"
        :groups="groups"
        :tiers="tiers"
        :editable="data.editable && limited"
        :assignable="assignable"
        :reasons="data.reasons"
        :outside="outside"
        outside-reason="上级部门没有这一项，下级不能勾"
        :original="limited && originalLimited ? originalSet : null"
      />

      <div v-if="data.editable" class="save-bar">
        <span v-if="dirty" class="diff">
          <span v-if="modeChanged">{{ limited ? "改成单独限制" : "改成跟上级一样" }}</span>
          <span v-if="limited && diff.added.length" class="add">
            放开 {{ diff.added.length }} 项
          </span>
          <span v-if="limited && diff.removed.length" class="del">
            收回 {{ diff.removed.length }} 项
          </span>
          <span v-if="scopeChanged">
            最大数据范围改成「{{ maxScope ? SCOPES[maxScope] : "跟上级" }}」
          </span>
        </span>
        <span v-else class="text-muted">没有改动</span>
        <el-button :disabled="!dirty" @click="reset">撤销</el-button>
        <el-button
          type="primary"
          :disabled="!dirty"
          :loading="saving"
          data-test="save-limit"
          @click="save"
        >
          保存上限
        </el-button>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import DeptAPI, { type DeptLimit } from "@/api/system/dept";
import RoleAPI, { type PermGroup } from "@/api/system/role";
import PermEditor from "@/components/biz/PermEditor.vue";
import { usePerm } from "@/composables/usePerm";
import { namesOf, buildIndex } from "@/utils/permDeps";

/**
 * 部门「权限上限」页签：二选一「跟上级一样」/「单独限制」，单独限制时用授权编辑器勾最多能用的项，
 * 上级没有的项默认收起（可以展开看）；另设最大数据范围，比上级宽的选项灰掉。
 */
const props = defineProps<{ deptId: string }>();
const emit = defineEmits<{ saved: [] }>();

const SCOPES: Record<number, string> = {
  1: "全部数据",
  2: "本单位及下级",
  3: "本单位",
  4: "仅本人",
};
const can = usePerm();
const hasLimitPerm = computed(() => can("sys:dept:limit"));

const loading = ref(false);
const saving = ref(false);
const data = ref<DeptLimit | null>(null);
const groups = ref<PermGroup[]>([]);
const tiers = ref<Record<string, string>>({});
const limited = ref(false);
const maxScope = ref(0);
const codes = ref(new Set<string>());
const originalLimited = ref(false);
const original = ref<string[]>([]);
const originalScope = ref(0);

const index = computed(() => buildIndex(groups.value));
const allCount = computed(() => index.value.items.length);
const parentPerms = computed(() =>
  data.value?.parent.perms ? new Set(data.value.parent.perms) : null
);
const originalSet = computed(() => new Set(original.value));
/** 上级没有的项：编辑器里默认收起、不能勾。 */
const outside = computed(() =>
  parentPerms.value
    ? new Set(index.value.items.map((i) => i.code).filter((code) => !parentPerms.value!.has(code)))
    : new Set<string>()
);
/** 自己存着、但上级已经收回的项。 */
const revoked = computed(() =>
  limited.value && parentPerms.value
    ? [...codes.value].filter((code) => !parentPerms.value!.has(code))
    : []
);
const revokedNames = computed(() => namesOf(revoked.value, index.value, 6));
/**
 * 能动的项：管理员全部；其他人能放开自己可转授的，原来就能用的随便收回、再勾回来。
 */
const assignable = computed(() => {
  if (!data.value || data.value.assignable === null) return null;
  const set = new Set(data.value.assignable);
  const usable = originalLimited.value
    ? original.value
    : parentPerms.value
      ? [...parentPerms.value]
      : index.value.items.map((i) => i.code);
  for (const code of usable) if (!parentPerms.value || parentPerms.value.has(code)) set.add(code);
  return set;
});

const diff = computed(() => {
  const before = originalLimited.value
    ? originalSet.value
    : parentPerms.value || new Set(index.value.items.map((i) => i.code));
  const added = [...codes.value].filter((code) => !before.has(code));
  const removed = [...before].filter((code) => !codes.value.has(code));
  return { added, removed };
});
const modeChanged = computed(() => limited.value !== originalLimited.value);
const scopeChanged = computed(() => maxScope.value !== originalScope.value);
const dirty = computed(
  () =>
    modeChanged.value ||
    scopeChanged.value ||
    (limited.value && Boolean(diff.value.added.length || diff.value.removed.length))
);

function scopeDisabled(value: number) {
  if (!data.value) return true;
  // 1 最宽、4 最窄：比上级宽、比自己宽的都不能选
  if (data.value.parent.maxScope && value < data.value.parent.maxScope) return true;
  return data.value.assignable !== null && value < data.value.myScope;
}

/** 切到「单独限制」时，先勾上上级允许的全部，再往下减；切回「跟上级一样」时编辑器显示上级的范围。 */
watch(limited, (on) => {
  if (!data.value) return;
  if (on)
    codes.value = new Set(
      originalLimited.value
        ? original.value
        : parentPerms.value || index.value.items.map((i) => i.code)
    );
  else codes.value = new Set(parentPerms.value || index.value.items.map((i) => i.code));
});

function fill(result: DeptLimit) {
  data.value = result;
  originalLimited.value = result.limited;
  original.value = result.perms;
  originalScope.value = result.maxScope || 0;
  maxScope.value = originalScope.value;
  limited.value = result.limited;
  // watch 在下一轮才跑，这里先填好
  codes.value = new Set(
    result.limited ? result.perms : result.parent.perms || index.value.items.map((i) => i.code)
  );
}
async function load() {
  loading.value = true;
  try {
    if (!groups.value.length) {
      const catalog = await RoleAPI.permCatalog();
      groups.value = catalog.groups;
      tiers.value = catalog.tiers || {};
    }
    fill(await DeptAPI.getLimit(props.deptId));
  } finally {
    loading.value = false;
  }
}
function reset() {
  if (data.value) fill(data.value);
}
async function save() {
  if (!data.value) return;
  const perms = limited.value
    ? [...codes.value].filter((code) => !parentPerms.value || parentPerms.value.has(code))
    : [];
  const lines: string[] = [];
  if (modeChanged.value)
    lines.push(
      limited.value ? "改成单独限制。" : "改成跟上级一样：这个部门的人最多能用上级允许的全部。"
    );
  if (limited.value && diff.value.removed.length)
    lines.push(
      `收回 ${diff.value.removed.length} 项：${namesOf(diff.value.removed, index.value, 6)}，这个部门和下级的人即使角色里有也用不了。`
    );
  if (limited.value && diff.value.added.length)
    lines.push(
      `放开 ${diff.value.added.length} 项：${namesOf(diff.value.added, index.value, 6)}。`
    );
  if (scopeChanged.value)
    lines.push(`最大数据范围改成「${maxScope.value ? SCOPES[maxScope.value] : "跟上级"}」。`);
  try {
    await ElMessageBox.confirm(lines.join("\n"), `保存「${data.value.name}」的权限上限`, {
      type: "warning",
      confirmButtonText: "保存",
      cancelButtonText: "再看看",
      customStyle: { whiteSpace: "pre-line" },
    });
  } catch {
    return;
  }
  saving.value = true;
  try {
    await DeptAPI.saveLimit(props.deptId, {
      limited: limited.value,
      perms,
      maxScope: maxScope.value || null,
    });
    ElMessage.success("已保存，这个部门的人下一次操作起按新上限");
    await load();
    emit("saved");
  } finally {
    saving.value = false;
  }
}

watch(() => props.deptId, load, { immediate: true });
</script>

<style scoped>
.chain {
  margin-bottom: 10px;
  font-size: 13px;
}
.chain em {
  font-size: 12px;
  font-style: normal;
  color: var(--el-text-color-secondary);
}
.chain .sep {
  margin: 0 6px;
  color: var(--el-text-color-placeholder);
}
.intro {
  margin-bottom: 12px;
}
.mode {
  display: flex;
  flex-wrap: wrap;
  gap: 10px 24px;
  align-items: center;
  margin-bottom: 8px;
}
.scope {
  display: flex;
  gap: 8px;
  align-items: center;
  font-size: 14px;
}
.summary {
  margin: 8px 0 12px;
  font-size: 13px;
  color: var(--el-text-color-regular);
}
.small {
  margin: 0 0 8px;
  font-size: 12px;
}
.save-bar {
  position: sticky;
  bottom: 0;
  z-index: 3;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  justify-content: flex-end;
  padding: 12px 0 4px;
  margin-top: 12px;
  background: var(--el-bg-color);
  border-top: 1px solid var(--el-border-color-lighter);
}
.diff {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  margin-right: auto;
  font-size: 13px;
}
.add {
  color: var(--el-color-success);
}
.del {
  color: var(--el-color-danger);
}
</style>
