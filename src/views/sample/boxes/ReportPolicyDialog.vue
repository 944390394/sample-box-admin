<template>
  <el-dialog
    v-model="open"
    :title="boxId ? `${boxName || boxId} · 上报策略` : '批量设置上报策略'"
    width="600px"
    style="max-width: 94vw"
    destroy-on-close
  >
    <div v-loading="loading">
      <el-alert v-if="error" :title="error" type="error" :closable="false" />
      <template v-else-if="loaded">
        <el-descriptions v-if="state" :column="1" border class="summary">
          <el-descriptions-item label="有效策略">
            {{ state.effective.reportPeriodSec }} 秒 ·
            {{ state.effective.reportOnlyWhenCharging ? "仅充电时" : "持续定时" }} · 指示灯{{
              state.effective.indicators === false ? "日常灭" : "日常亮"
            }}{{
              state.effective.moduleLed === undefined
                ? ""
                : ` · 模块灯${state.effective.moduleLed ? "日常亮" : "日常灭"}`
            }}
          </el-descriptions-item>
          <el-descriptions-item label="卫星定位">
            {{
              (state.effective.periodicGps ?? Boolean(state.taskId))
                ? "随定时上报定位"
                : "关闭卫星定位"
            }}（1.0.17 配套设备）
          </el-descriptions-item>
          <el-descriptions-item label="配置来源">
            {{ state.effective.source }} {{ state.taskId ? `（${state.taskId}）` : "" }}
          </el-descriptions-item>
          <el-descriptions-item label="下发状态">
            <el-tag
              :type="
                state.status === '已生效'
                  ? 'success'
                  : state.status === '未生效'
                    ? 'danger'
                    : 'warning'
              "
            >
              {{ state.status }}
            </el-tag>
            <el-button link @click="load">刷新</el-button>
          </el-descriptions-item>
          <el-descriptions-item v-if="state.echo" label="设备回报">
            pv {{ state.echo.version }} · {{ state.echo.periodSec }} 秒 ·
            {{ state.echo.charging ? "仅充电时" : "持续定时" }}
          </el-descriptions-item>
        </el-descriptions>
        <el-alert
          v-if="boxId && !state"
          title="当前账号可以写入策略，无法查看原配置。请选择恢复继承，或填写完整单箱策略。"
          type="info"
          :closable="false"
          class="summary"
        />
        <el-alert
          v-if="preview"
          :title="`本次设置 ${preview.total} 台，其中 ${preview.overridden} 台受单箱配置或任务策略保护，本次修改不会改变其当前有效周期。`"
          type="info"
          :closable="false"
          class="summary"
        />
        <el-radio-group v-model="custom" :disabled="!editable" class="summary">
          <el-radio :value="false">{{ boxId ? "恢复继承" : "清除批量设置，恢复继承" }}</el-radio>
          <el-radio :value="true">{{ boxId ? "单独设置" : "统一设置" }}</el-radio>
        </el-radio-group>
        <PolicyFields v-if="custom" v-model="form" :disabled="!editable" />
        <p class="hint">
          任务内单箱 ＞ 长期单箱 ＞ 任务统一 ＞ 批量 ＞ 系统默认。1.0.17
          配套设备按派单时的策略执行，任务期间修改底层配置会在任务结束后使用。离线箱子下次上报时领取。
        </p>
      </template>
    </div>
    <template #footer>
      <el-button @click="open = false">关闭</el-button>
      <el-button
        v-if="editable"
        type="primary"
        :disabled="!loaded || !!error"
        :loading="saving"
        @click="save"
      >
        保存{{ boxId ? "" : ` ${preview?.total || 0} 台` }}
      </el-button>
    </template>
  </el-dialog>
</template>
<script setup lang="ts">
import { ElMessage } from "element-plus";
import API, { policyPerm, type Policy, type PolicyState } from "@/api/sample/report-policy";
import { useUserStore } from "@/stores/user";
import PolicyFields from "./PolicyFields.vue";
const open = defineModel<boolean>({ required: true });
const props = defineProps<{
  boxId?: string;
  boxName?: string;
  ids?: string[];
  filter?: Record<string, unknown>;
}>();
const emit = defineEmits<{ saved: [] }>();
const user = useUserStore();
const editable = computed(() =>
  user.userInfo.perms?.includes(props.boxId ? policyPerm.single : policyPerm.batch)
);
const state = ref<PolicyState | null>(null),
  preview = ref<{ ids: string[]; total: number; overridden: number } | null>(null);
const loading = ref(false),
  saving = ref(false),
  loaded = ref(false),
  error = ref(""),
  custom = ref(true);
const form = ref<Policy>({ reportPeriodSec: 60, reportOnlyWhenCharging: false, indicators: true });
let generation = 0;
async function load() {
  const ticket = ++generation;
  loading.value = true;
  loaded.value = false;
  error.value = "";
  state.value = null;
  preview.value = null;
  try {
    if (props.boxId && !user.userInfo.perms?.includes(policyPerm.read) && editable.value) {
      custom.value = true;
      form.value = { reportPeriodSec: 60, reportOnlyWhenCharging: false, indicators: true };
    } else if (props.boxId) {
      const result = await API.get(props.boxId);
      if (ticket !== generation) return;
      state.value = result;
      custom.value = Boolean(result.single);
      form.value = { ...(result.single || result.effective) };
    } else {
      const result = await API.preview(
        props.filter ? { filter: props.filter } : { ids: props.ids }
      );
      if (ticket !== generation) return;
      preview.value = result;
      form.value = { reportPeriodSec: 60, reportOnlyWhenCharging: false, indicators: true };
      custom.value = true;
    }
    loaded.value = true;
  } catch (e) {
    if (ticket === generation) error.value = e instanceof Error ? e.message : "策略加载失败";
  } finally {
    if (ticket === generation) loading.value = false;
  }
}
async function save() {
  if (saving.value || !loaded.value) return;
  const ticket = generation;
  saving.value = true;
  try {
    const { reportPeriodSec, reportOnlyWhenCharging, indicators, moduleLed, periodicGps } =
      form.value;
    const value = custom.value
      ? { reportPeriodSec, reportOnlyWhenCharging, indicators, moduleLed, periodicGps }
      : null;
    if (props.boxId) await API.save(props.boxId, value);
    else await API.batch(preview.value!.ids, value);
    ElMessage.success("策略已保存，等待设备确认");
    emit("saved");
    if (ticket === generation) open.value = false;
  } finally {
    saving.value = false;
  }
}
watch(
  () => [open.value, props.boxId, props.ids, props.filter],
  () => {
    if (open.value) void load();
    else generation++;
  },
  { immediate: true }
);
</script>
<style scoped>
.summary {
  margin-bottom: 18px;
}
.hint {
  font-size: 12px;
  line-height: 1.8;
  color: var(--el-text-color-secondary);
}
</style>
