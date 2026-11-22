<template>
  <el-dialog
    :model-value="modelValue"
    :title="title"
    width="520px"
    style="max-width: 94vw"
    :close-on-click-modal="false"
    append-to-body
    @update:model-value="(v: boolean) => emit('update:modelValue', v)"
    @open="onOpen"
  >
    <template v-if="detail">
      <!-- 接受确认（R25①）：归属立即转移＋不可撤销警示＋接受人＝当前登录 -->
      <template v-if="mode === 'accept'">
        <div class="summary">
          <b>{{ detail.boxCount }} 台采样箱</b>
          <span>{{ fromText }}</span>
          <span class="arrow">→</span>
          <b>{{ detail.toOrg.name || "目标公司" }}</b>
        </div>
        <dl class="sum-row">
          <div>
            <dt>快递单号</dt>
            <dd class="mono">{{ detail.trackingNo || "未填写" }}</dd>
          </div>
          <div>
            <dt>接受后单号</dt>
            <dd>只读展示</dd>
          </div>
          <div>
            <dt>创建人</dt>
            <dd>{{ detail.createdBy || "—" }}</dd>
          </div>
        </dl>
        <div class="box-mini">
          <div class="bm-head">
            将转移归属的箱子
            <span class="n">
              共 {{ detail.boxCount }} 台{{ detail.boxes.length > 3 ? " · 示例 3" : "" }}
            </span>
          </div>
          <div v-for="b in detail.boxes.slice(0, 3)" :key="b.boxId" class="bm-row">
            <b>{{ b.name }}</b>
            <span class="code mono">{{ b.code }}</span>
          </div>
        </div>
        <el-alert type="warning" :closable="false" class="warn-alert">
          <b>接受后归属立即转移：</b>
          {{ detail.boxCount }} 台箱子归属转到 {{ detail.toOrg.name }}（保管人清空，待目标方指派）；
          <b>接受后不可撤销</b>
          ，如需调整请发起新划拨单。
        </el-alert>
        <div class="acceptor">
          <span class="avatar">{{ acceptorInitial }}</span>
          <span class="who">
            接受人＝当前登录分公司管理员：
            <b>{{ acceptorName }}</b>
            <small>接受时间将记入动态与详情</small>
          </span>
        </div>
      </template>

      <!-- 拒收（R25②接收方出口）：原因必填＋红字恒定占位 -->
      <template v-else-if="mode === 'reject'">
        <div class="summary">
          <b>{{ detail.boxCount }} 台采样箱</b>
          <span>{{ fromText }}</span>
          <span class="arrow">→</span>
          <b>{{ detail.toOrg.name || "目标公司" }}</b>
        </div>
        <el-alert type="info" :closable="false" class="warn-alert">
          拒收后单据终止为
          <b>已拒收</b>
          ，箱子归属
          <b>不动</b>
          （仍属 {{ fromText }}）；创建方可重新发起划拨。
        </el-alert>
        <el-form label-width="90px" @submit.prevent>
          <el-form-item label="拒收原因" required>
            <el-input
              v-model="reason"
              type="textarea"
              :rows="3"
              maxlength="100"
              show-word-limit
              placeholder="必填，记入审计（100 字以内），如：暂不需要箱子"
            />
          </el-form-item>
        </el-form>
        <p class="err-slot" :class="{ on: mode === 'reject' || reasonError }">
          {{ reasonError || "拒收原因必填，请填写后再提交" }}
        </p>
      </template>

      <!-- 取消（R25②创建方出口）：箱不动单作废＋备注选填 -->
      <template v-else-if="mode === 'cancel'">
        <el-alert type="error" :closable="false" class="warn-alert">
          <b>取消后本划拨单作废，箱子归属不动</b>
          （仍属 {{ fromText }}）；如仍需划拨请新建划拨单。
        </el-alert>
        <div class="summary">
          <b>{{ detail.boxCount }} 台采样箱</b>
          <span>{{ fromText }}</span>
          <span class="arrow">→</span>
          <b>{{ detail.toOrg.name || "目标公司" }}</b>
        </div>
        <dl class="sum-row">
          <div>
            <dt>快递单号</dt>
            <dd class="mono">{{ detail.trackingNo || "未填写" }}</dd>
          </div>
          <div>
            <dt>取消后单号</dt>
            <dd>随单只读保留</dd>
          </div>
          <div>
            <dt>创建人</dt>
            <dd>{{ detail.createdBy || "—" }}（当前登录）</dd>
          </div>
        </dl>
        <el-form label-width="90px" @submit.prevent>
          <el-form-item label="取消备注">
            <el-input
              v-model="note"
              type="textarea"
              :rows="2"
              maxlength="100"
              show-word-limit
              placeholder="选填，记入审计，如：误建单"
            />
          </el-form-item>
        </el-form>
        <p class="err-slot muted">备注选填，不填也可取消</p>
      </template>
    </template>

    <template #footer>
      <span class="footer-hint text-muted">{{ footerHint }}</span>
      <el-button @click="emit('update:modelValue', false)">
        {{ mode === "cancel" ? "再想想" : "取消" }}
      </el-button>
      <el-button
        :type="mode === 'accept' ? 'primary' : 'danger'"
        :loading="saving"
        :disabled="confirmDisabled"
        @click="confirm"
      >
        {{ confirmLabel }}
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { ElMessage } from "element-plus";
import TransferAPI, { type TransferDetail } from "@/api/sample/transfer";
import { useUserStore } from "@/stores/user";
import type { ApiError } from "@/utils/request";

/**
 * R25（#71）划拨三态动作弹框：接受（目标方）/拒收（接收方，原因必填）/取消（创建方，备注选填）。
 * 三弹框均不加密码（口径⑤仅创建需密码）；只读展示当前快递单号。拒收红字走恒定高度占位（不跳动）。
 * 由列表行操作与详情 hero 操作区共用；动作门由服务端 abilities 决定，前端只按 mode 渲染。
 */
const props = defineProps<{
  modelValue: boolean;
  mode: "accept" | "reject" | "cancel" | "";
  detail: TransferDetail | null;
}>();
const emit = defineEmits<{ "update:modelValue": [value: boolean]; done: [] }>();

const user = useUserStore();
const saving = ref(false);
const reason = ref("");
const note = ref("");
const reasonError = ref("");

const acceptorName = computed(
  () => user.userInfo.nickname || user.userInfo.username || "当前管理员"
);
const acceptorInitial = computed(() => acceptorName.value.slice(0, 1));
const fromText = computed(() => {
  const from = props.detail?.from || [];
  if (!from.length) return "原公司";
  return from.map((f) => f.orgName).join("、");
});
const title = computed(() =>
  props.mode === "accept" ? "接受划拨" : props.mode === "reject" ? "拒收划拨" : "取消划拨"
);
const confirmLabel = computed(() =>
  props.mode === "accept"
    ? `确认接受（${props.detail?.boxCount ?? 0} 台）`
    : props.mode === "reject"
      ? "确认拒收"
      : "确认取消"
);
const footerHint = computed(() =>
  props.mode === "accept"
    ? "确认即 待接受 → 已完成"
    : props.mode === "reject"
      ? "原因空 → 确认禁用"
      : "箱不动 · 单作废"
);
const confirmDisabled = computed(() =>
  props.mode === "reject" ? !reason.value.trim() || saving.value : saving.value
);

function onOpen() {
  reason.value = "";
  note.value = "";
  reasonError.value = "";
}

async function confirm() {
  if (!props.detail || saving.value) return;
  if (props.mode === "reject" && !reason.value.trim()) {
    reasonError.value = "拒收原因必填，请填写后再提交";
    return;
  }
  saving.value = true;
  reasonError.value = "";
  try {
    if (props.mode === "accept") {
      const r = await TransferAPI.accept(props.detail.id);
      ElMessage.success(
        `已接受，${r.count ?? props.detail.boxCount} 台箱子归属已转到 ${props.detail.toOrg.name}`
      );
    } else if (props.mode === "reject") {
      await TransferAPI.reject(props.detail.id, reason.value.trim());
      ElMessage.success("已拒收，箱子归属未动");
    } else if (props.mode === "cancel") {
      await TransferAPI.cancel(props.detail.id, note.value.trim() || undefined);
      ElMessage.success("已取消，箱子归属未动");
    }
    emit("done");
    emit("update:modelValue", false);
  } catch (error) {
    const err = error as ApiError;
    if (props.mode === "reject") reasonError.value = err.message || "拒收失败";
    else ElMessage.error(err.message || "操作失败");
  } finally {
    saving.value = false;
  }
}
watch(
  () => props.modelValue,
  (open) => {
    if (!open) reasonError.value = "";
  }
);
</script>

<style scoped>
.summary {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  margin-bottom: 10px;
  font-size: 14px;
}
.summary .arrow {
  color: var(--el-color-primary);
}
.sum-row {
  display: flex;
  flex-wrap: wrap;
  gap: 18px;
  margin: 0 0 10px;
}
.sum-row dt {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.sum-row dd {
  margin: 0;
  font-size: 13px;
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.box-mini {
  padding: 8px 10px;
  margin-bottom: 10px;
  background: var(--el-fill-color-light);
  border-radius: 6px;
}
.bm-head {
  display: flex;
  justify-content: space-between;
  margin-bottom: 6px;
  font-size: 12px;
  font-weight: 600;
}
.bm-head .n {
  font-weight: 400;
  color: var(--el-text-color-secondary);
}
.bm-row {
  display: flex;
  gap: 8px;
  align-items: center;
  justify-content: space-between;
  padding: 2px 0;
  font-size: 12px;
}
.bm-row .code {
  color: var(--el-text-color-secondary);
}
.warn-alert {
  margin-bottom: 10px;
}
.acceptor {
  display: flex;
  gap: 8px;
  align-items: center;
}
.acceptor .avatar {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  font-weight: 700;
  color: var(--el-color-primary);
  background: var(--el-color-primary-light-9);
  border-radius: 50%;
}
.acceptor .who {
  font-size: 12px;
}
.acceptor .who small {
  display: block;
  color: var(--el-text-color-secondary);
}
/* 红字恒定占位：固定高度＋visibility 切换，出错前后 bbox 不变（不跳动） */
.err-slot {
  visibility: hidden;
  height: 20px;
  margin: 0 0 0 90px;
  font-size: 12px;
  line-height: 20px;
  color: var(--el-color-danger);
}
.err-slot.on {
  visibility: visible;
}
.err-slot.muted {
  visibility: visible;
  color: var(--el-text-color-placeholder);
}
.footer-hint {
  float: left;
  font-size: 12px;
  line-height: 32px;
}
</style>
