<template>
  <div class="page-container page-flow">
    <PageHeader
      title="采样箱默认策略"
      subtitle="只用于没有单箱、任务或批量设置的箱子；开关箱、上电、插拔充电器仍然马上上报。建议 60 秒，并只在充电时定时上报。"
    />
    <div class="policy-main">
      <BoxPolicySettings
        ref="policyCard"
        :value="settings?.box"
        :can="can"
        :loading="loading"
        @dirty="dirty = $event"
        @saved="onSaved"
      />
    </div>
    <div v-if="dirty" class="save-bar">
      <span class="save-bar-text">默认策略未保存</span>
      <el-button size="small" @click="discard">放弃更改</el-button>
      <el-button size="small" type="primary" @click="policyCard?.save()">保存</el-button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onBeforeRouteLeave } from "vue-router";
import SettingsAPI, { type BoxSettings, type TcpSettings } from "@/api/system/settings";
import BoxPolicySettings from "@/components/biz/BoxPolicySettings.vue";
import PageHeader from "@/components/biz/PageHeader.vue";
import { refreshBoxFeatures } from "@/composables/useBoxFeatures";

/**
 * 采样箱 › 默认策略（IA 迁移：原系统设置「采样箱默认策略与任务」分区独立成页）。
 * 菜单对 device:box:policyDefault / sys:settings:battery-reserve / sys:settings:arrive-radius
 * 三码 some 可见（server/menus.js）；表单字段级 gating 在 BoxPolicySettings 内。
 * 脏标记/保存条/放弃/离开守卫复用系统设置口径：放弃＝重新 load，离开前确认，关页前 beforeunload。
 */
defineOptions({ name: "SampleBoxPolicy" });

const loading = ref(false);
const settings = ref<TcpSettings | null>(null);
const dirty = ref(false);
const policyCard = ref<InstanceType<typeof BoxPolicySettings> | null>(null);
/** 各字段能不能改，服务端按权限给（三码各自授权）。 */
const can = computed(() => ({
  box: false,
  batteryReserve: false,
  arriveRadius: false,
  ...(settings.value?.can || {}),
}));

async function load() {
  loading.value = true;
  try {
    settings.value = await SettingsAPI.get();
  } finally {
    loading.value = false;
  }
}
async function onSaved(v: BoxSettings) {
  if (settings.value) settings.value.box = v;
  // 让全站徽标/菜单立刻按新宽限与新开关走
  await refreshBoxFeatures();
}
function discard() {
  load();
}

function warnUnsaved(e: BeforeUnloadEvent) {
  if (dirty.value) {
    e.preventDefault();
    e.returnValue = "";
  }
}
onMounted(() => {
  window.addEventListener("beforeunload", warnUnsaved);
  load();
});
onBeforeUnmount(() => {
  window.removeEventListener("beforeunload", warnUnsaved);
});
onBeforeRouteLeave(() => {
  if (!dirty.value) return true;
  return ElMessageBox.confirm("有未保存的修改，离开将丢失修改。", "未保存的修改", {
    confirmButtonText: "放弃修改离开",
    cancelButtonText: "留下保存",
    type: "warning",
  })
    .then(() => true)
    .catch(() => false);
});
</script>

<style lang="scss" scoped>
/* 超宽屏内容约束：沿系统设置 settings-main 口径，内容封顶 1280 居中 */
.policy-main {
  width: 100%;
  max-width: 1280px;
  margin-inline: auto;
}
/* 脏状态 sticky 保存条（与系统设置同款） */
.save-bar {
  position: fixed;
  bottom: 16px;
  left: 50%;
  z-index: 60;
  display: flex;
  gap: 12px;
  align-items: center;
  padding: 10px 16px;
  background: var(--el-bg-color-overlay, #fff);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 10px;
  box-shadow: 0 4px 16px rgb(0 0 0 / 12%);
  transform: translateX(-50%);
}
.save-bar-text {
  flex: 1;
  font-size: 13px;
  color: var(--el-color-warning);
}
</style>
