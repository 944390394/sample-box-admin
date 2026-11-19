<template>
  <el-drawer
    :model-value="modelValue"
    :title="roleName ? `授权审计 · ${roleName}` : '授权审计'"
    size="560px"
    class="audit-drawer"
    data-test="role-audit"
    @update:model-value="(v: boolean) => emit('update:modelValue', v)"
  >
    <div v-loading="loading" class="audit">
      <template v-if="data">
        <el-alert
          v-if="data.role.code === 'ADMIN'"
          type="success"
          :closable="false"
          show-icon
          class="block"
        >
          系统管理员：固定拥有全部权限、全部数据，全部可转授，不受部门上限约束。
        </el-alert>

        <section class="block">
          <h4>现在的授权</h4>
          <p class="scope">
            数据范围：
            <b class="hl">{{ scopeText(data.role.dataScope) }}</b>
            <template v-if="data.role.dataScope === 5">
              <template v-if="data.role.deptIds.length">
                （{{ data.role.deptIds.map((d) => d.name).join("、") }}，含其下级）
              </template>
              <template v-else>（没勾选任何单位，看不到任何单位的数据）</template>
            </template>
          </p>
          <p class="text-muted small">
            共 {{ data.current.total }} 项权限，其中 {{ data.current.grantable.length }}
            项开了「可转授」。
          </p>
          <div v-if="data.current.grantable.length" class="chips">
            <span v-for="p in data.current.grantable" :key="p.code" class="chip">
              {{ p.label }}
            </span>
          </div>
        </section>

        <section class="block">
          <h4>谁在何时授的</h4>
          <p class="text-muted small">
            只读。来自操作日志（按你的数据范围裁剪），最多显示最近 200 条。
          </p>
          <ol v-if="data.entries.length" class="timeline">
            <li v-for="e in data.entries" :key="e.id" :class="{ failed: e.result === '失败' }">
              <div class="line">
                <b>{{ e.actorName || e.actorId || "未知" }}</b>
                <span v-if="e.orgName" class="org">{{ e.orgName }}</span>
                <el-tag
                  size="small"
                  :type="e.result === '失败' ? 'danger' : 'success'"
                  effect="plain"
                >
                  {{ e.action }}{{ e.result === "失败" ? " · 失败" : "" }}
                </el-tag>
                <time class="text-muted">{{ e.createdAt }}</time>
              </div>
              <div v-if="e.detail" class="detail">
                <div v-if="e.detail.scopeBefore != null" class="row range">
                  数据范围：{{ scopeText(e.detail.scopeBefore) }} →
                  <b>{{ scopeText(e.detail.scopeAfter) }}</b>
                </div>
                <div v-if="e.detail.scope != null" class="row range">
                  初始数据范围：
                  <b>{{ scopeText(e.detail.scope) }}</b>
                </div>
                <div v-if="deptDiff(e).added.length" class="row add">
                  ＋ 自定义部门：{{
                    deptDiff(e)
                      .added.map((d) => d.name)
                      .join("、")
                  }}
                </div>
                <div v-if="deptDiff(e).removed.length" class="row del">
                  － 自定义部门：{{
                    deptDiff(e)
                      .removed.map((d) => d.name)
                      .join("、")
                  }}
                </div>
                <div v-if="e.detail.deptIds?.length" class="row add">
                  自定义部门：{{ e.detail.deptIds.map((d) => d.name).join("、") }}
                </div>
                <div v-for="p in e.detail.added || []" :key="'a' + p.code" class="row add">
                  ＋ {{ p.label }}
                </div>
                <div v-for="p in e.detail.removed || []" :key="'r' + p.code" class="row del">
                  － {{ p.label }}
                </div>
                <div v-for="p in e.detail.grantOn || []" :key="'on' + p.code" class="row pass">
                  ⇄ {{ p.label }} 开可转授
                </div>
                <div v-for="p in e.detail.grantOff || []" :key="'off' + p.code" class="row pass">
                  ⇄ {{ p.label }} 关可转授
                </div>
              </div>
              <p v-else class="text-muted small nodetail">这次操作没有权限/范围变化明细。</p>
            </li>
          </ol>
          <el-empty v-else description="还没有这个角色的授权记录" :image-size="60" />
        </section>
      </template>
    </div>
  </el-drawer>
</template>

<script setup lang="ts">
import RoleAPI, { type RoleGrantAudit, type GrantAuditEntry } from "@/api/system/role";

/**
 * #26 B4：角色的授权审计抽屉（只读）——谁在何时把哪些权限/可转授/范围授给该角色。
 * 数据源：sys_operation_log（target_type=role，服务端按操作日志同一范围口径裁剪）
 * + sys_role_perm.grantable 现状。视觉沿用 EffectivePermDrawer 的块/chips/行风格，独立组件。
 */
const props = defineProps<{ modelValue: boolean; roleId: string; roleName?: string }>();
const emit = defineEmits<{ "update:modelValue": [boolean] }>();

const loading = ref(false);
const data = ref<RoleGrantAudit | null>(null);

const SCOPES: Record<number, string> = {
  1: "全部数据",
  2: "本单位及下级",
  3: "本单位",
  4: "仅本人",
  5: "自定义部门数据",
};
const scopeText = (value?: number) => SCOPES[Number(value)] || "—";

/** 自定义部门 diff：改前改后对比；新建（只有 deptIds）不算 diff。 */
function deptDiff(e: GrantAuditEntry) {
  const before = e.detail?.deptBefore || [];
  const after = e.detail?.deptAfter || [];
  if (!before.length && !after.length) return { added: [], removed: [] };
  const beforeIds = new Set(before.map((d) => d.id));
  const afterIds = new Set(after.map((d) => d.id));
  return {
    added: after.filter((d) => !beforeIds.has(d.id)),
    removed: before.filter((d) => !afterIds.has(d.id)),
  };
}

async function load() {
  if (!props.roleId) return;
  loading.value = true;
  try {
    data.value = await RoleAPI.getGrantAudit(props.roleId);
  } finally {
    loading.value = false;
  }
}
watch(
  () => [props.modelValue, props.roleId],
  ([open]) => {
    if (open) {
      data.value = null;
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
.scope {
  margin: 0 0 4px;
  font-size: 13px;
}
.hl {
  color: var(--el-color-primary);
}
.small {
  font-size: 12px;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  max-height: 180px;
  overflow: auto;
}
.chip {
  padding: 2px 8px;
  font-size: 13px;
  background: var(--el-color-primary-light-9);
  border-radius: 4px;
}
.timeline {
  padding: 0;
  margin: 8px 0 0;
  list-style: none;
}
.timeline li {
  padding: 8px 0;
  border-top: 1px solid var(--el-border-color-extra-light);
}
.line {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 8px;
  align-items: center;
  font-size: 13px;
}
.line .org {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.line time {
  margin-left: auto;
  font-size: 12px;
}
.detail {
  margin-top: 4px;
}
.row {
  padding: 1px 0;
  font-size: 13px;
}
.row.add {
  color: var(--el-color-success-dark-2);
}
.row.del {
  color: var(--el-color-danger);
}
.row.pass {
  color: var(--el-color-primary);
}
.row.range {
  color: var(--el-text-color-regular);
}
.nodetail {
  margin: 4px 0 0;
}
.timeline li.failed .line b {
  color: var(--el-color-danger);
}
</style>
