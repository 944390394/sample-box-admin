<template>
  <el-dialog
    :model-value="modelValue"
    title="撤销划拨"
    width="680px"
    style="max-width: 96vw"
    :close-on-click-modal="false"
    @update:model-value="(v: boolean) => emit('update:modelValue', v)"
    @open="onOpen"
  >
    <el-skeleton v-if="loading" :rows="5" animated />
    <template v-else-if="detail">
      <p class="lead">
        {{ detail.name }}
        <span class="mono text-muted">{{ detail.id }}</span>
      </p>

      <!-- 整单禁撤横幅：任一箱子被拦下则整单不可撤销 -->
      <el-alert
        v-if="blockedCount"
        type="error"
        :closable="false"
        class="banner"
        :title="`存在 ${blockedCount} 台不可撤销箱子，整单禁止撤销。`"
      >
        先处理被拦箱子（结束占用任务、或改用新划拨单），再回来撤销。守卫结果以服务端撤销时实时校验为准。
      </el-alert>
      <el-alert
        v-else
        type="success"
        :closable="false"
        class="banner"
        :title="`全部 ${detail.boxCount} 台可撤销。确认后整单变「已撤销」，并记录：谁、何时、退回哪些箱子。`"
      />

      <ul class="guard-list">
        <li v-for="box in guardBoxes" :key="box.boxId" :class="{ off: !box.ok }">
          <span class="dot" :class="box.ok ? 'ok' : 'no'" />
          <div class="body">
            <div class="line">
              <b :class="{ strike: !box.ok }">{{ box.name }}</b>
              <span class="mono text-muted">{{ box.code }}</span>
            </div>
            <div v-if="box.ok" class="text-muted restore">
              退回 {{ box.restoreTo?.orgName || box.fromOrg }}
              <template v-if="box.restoreTo?.ownerName && box.restoreTo.ownerName !== '—'">
                · 保管人 {{ box.restoreTo.ownerName }}
              </template>
            </div>
            <div v-else class="reason">{{ box.reason }}</div>
          </div>
        </li>
      </ul>

      <el-form v-if="!blockedCount" label-width="90px" class="reason-form" @submit.prevent>
        <el-form-item label="撤销原因" required>
          <el-input
            v-model="reason"
            type="textarea"
            :rows="2"
            maxlength="100"
            show-word-limit
            placeholder="必填，记进审计（100 字以内），如：误划拨"
          />
        </el-form-item>
      </el-form>
    </template>
    <el-empty v-else description="没有这张划拨单" />

    <template #footer>
      <el-button @click="emit('update:modelValue', false)">取消</el-button>
      <el-button
        type="danger"
        :loading="saving"
        :disabled="loading || !detail || blockedCount > 0 || !reason.trim()"
        @click="confirm"
      >
        {{ blockedCount ? "整单不可撤销" : confirmLabel }}
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { ElMessage } from "element-plus";
import TransferAPI, { type RevokeBlocked, type TransferDetail } from "@/api/sample/transfer";
import type { ApiError } from "@/utils/request";

const props = defineProps<{ modelValue: boolean; id: string }>();
const emit = defineEmits<{ "update:modelValue": [value: boolean]; saved: [] }>();

const detail = ref<TransferDetail | null>(null);
const loading = ref(false);
const saving = ref(false);
const reason = ref("");
/** 撤销 409 回吐的实时逐台结论（优先于详情预览）。 */
const liveBoxes = ref<RevokeBlocked["boxes"] | null>(null);

/** 逐台守卫结果：详情里 revocable/reasonCode 是服务端实时评估；撤销 409 后用 liveBoxes 覆盖。 */
const guardBoxes = computed(() => {
  if (liveBoxes.value) {
    return liveBoxes.value.map((b) => ({
      boxId: b.boxId,
      code: b.code,
      name: b.name,
      ok: b.ok,
      reason: b.reason,
      restoreTo: b.restoreTo,
      fromOrg: "",
    }));
  }
  return (detail.value?.boxes || []).map((b) => ({
    boxId: b.boxId,
    code: b.code,
    name: b.name,
    ok: b.revocable,
    reason: b.reason,
    restoreTo: b.revocable
      ? { orgId: b.fromOrgId, orgName: b.fromOrg, ownerName: b.fromOwner || "—" }
      : undefined,
    fromOrg: b.fromOrg,
  }));
});
const blockedCount = computed(() => guardBoxes.value.filter((b) => !b.ok).length);
/** 确认文案：「确认撤销（N 台退回 X）」，X 是退回的原公司（跨公司时多值）。 */
const confirmLabel = computed(() => {
  const n = detail.value?.boxCount ?? guardBoxes.value.length;
  const orgs = [
    ...new Set(guardBoxes.value.map((b) => b.restoreTo?.orgName || b.fromOrg).filter(Boolean)),
  ];
  return `确认撤销（${n} 台退回 ${orgs.join("、") || "原公司"}）`;
});

async function onOpen() {
  reason.value = "";
  liveBoxes.value = null;
  detail.value = null;
  if (!props.id) return;
  loading.value = true;
  try {
    detail.value = await TransferAPI.detail(props.id);
  } catch (error) {
    ElMessage.error((error as ApiError).message || "划拨单读取失败");
  } finally {
    loading.value = false;
  }
}

async function confirm() {
  if (!detail.value || blockedCount.value || !reason.value.trim()) return;
  saving.value = true;
  try {
    const result = await TransferAPI.revoke(detail.value.id, reason.value.trim());
    const orgs = [...new Set(result.restored.map((r) => r.toOrg))].join("、");
    ElMessage.success(`已撤销，${result.restoredCount} 台箱子归属已退回 ${orgs}`);
    emit("saved");
    emit("update:modelValue", false);
  } catch (error) {
    const err = error as ApiError;
    const data = err.data as RevokeBlocked | undefined;
    if (data?.boxes?.length) {
      // 服务端撤销时实时校验：可能详情预览之后箱子又被占用/开箱，按最新结论渲染整单禁撤
      liveBoxes.value = data.boxes;
      ElMessage.warning(err.message || "整单禁止撤销");
    } else {
      ElMessage.error(err.message || "撤销失败");
    }
  } finally {
    saving.value = false;
  }
}
</script>

<style scoped>
.lead {
  margin: 0 0 12px;
  font-weight: 600;
}
.mono {
  margin-left: 8px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  font-weight: 400;
}
.banner {
  margin-bottom: 12px;
}
.guard-list {
  max-height: 320px;
  padding: 0;
  margin: 0;
  overflow: auto;
  list-style: none;
}
.guard-list li {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  padding: 8px 4px;
  border-bottom: 1px solid var(--el-border-color-lighter);
}
.guard-list li.off {
  opacity: 0.72;
}
.dot {
  flex-shrink: 0;
  width: 9px;
  height: 9px;
  margin-top: 6px;
  border-radius: 50%;
}
.dot.ok {
  background: var(--el-color-success);
}
.dot.no {
  background: var(--el-text-color-placeholder);
}
.body {
  flex: 1;
  min-width: 0;
}
.line {
  display: flex;
  gap: 8px;
  align-items: center;
}
.strike {
  text-decoration: line-through;
}
.restore {
  font-size: 12px;
}
.reason {
  font-size: 12px;
  color: var(--el-color-danger);
}
.reason-form {
  margin-top: 14px;
}
</style>
