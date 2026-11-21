<template>
  <SectionCard v-loading="loading" class="box-policy">
    <el-form label-width="140px">
      <div class="form-pair">
        <el-form-item label="上报周期">
          <el-input-number
            v-model="form.reportPeriodSec"
            :min="5"
            :max="3600"
            :step="5"
            :disabled="!can.box"
          />
          <span class="unit">秒</span>
        </el-form-item>
        <el-form-item label="定时上报">
          <el-switch v-model="form.reportOnlyWhenCharging" :disabled="!can.box" />
          <span class="unit">只在充电时</span>
        </el-form-item>
      </div>
      <div class="form-pair">
        <el-form-item>
          <template #label>
            <span class="label-help">
              电量预留
              <el-tooltip :content="HELP.batteryReserve" placement="top">
                <el-icon class="help-icon"><QuestionFilled /></el-icon>
              </el-tooltip>
            </span>
          </template>
          <el-input-number
            v-model="form.batteryReserve"
            :min="0"
            :max="80"
            :disabled="!can.batteryReserve"
          />
          <span class="unit">%</span>
        </el-form-item>
        <el-form-item>
          <template #label>
            <span class="label-help">
              任务到达半径
              <el-tooltip :content="HELP.arriveRadius" placement="top">
                <el-icon class="help-icon"><QuestionFilled /></el-icon>
              </el-tooltip>
            </span>
          </template>
          <el-input-number
            v-model="form.arriveRadiusM"
            :min="100"
            :max="50000"
            :step="500"
            :disabled="!can.arriveRadius"
          />
          <span class="unit">米</span>
        </el-form-item>
      </div>
      <el-form-item label="建单后未上线宽限">
        <el-input-number
          v-model="form.taskOfflineGraceMin"
          :min="1"
          :max="1440"
          :step="5"
          :disabled="!can.box"
        />
        <span class="unit">分钟</span>
        <div class="form-extra">
          （1–1440，默认
          60）。被任务占用、从未上报的箱子，建单后这段时间内算中性「待上线」，不计离线；超过才计离线。一旦上报过回落「超过
          3 个上报周期」口径。
        </div>
      </el-form-item>
      <el-form-item label="划拨/送检功能">
        <el-switch v-model="form.enableTransferInspect" :disabled="!can.box" />
        <div class="form-extra">
          开启后启用「调拨单（批量划拨）」「送检单」两个独立页与建单入口；任务单页只放采样。关闭时新端点报未开通，旧流程不受影响。
        </div>
      </el-form-item>
      <el-form-item label="唯一检测站">
        <el-select
          v-model="form.stationDeptId"
          :disabled="!can.box"
          clearable
          placeholder="未指定（总公司下恰一个启用检测站时自动认定）"
        >
          <el-option
            v-for="opt in stationOptions"
            :key="opt.value"
            :label="opt.label"
            :value="opt.value"
          />
        </el-select>
        <div class="form-extra">
          合并采样单（任务单）的接收方固定为该检测站，建单页不再手选接收方。未指定时，总公司下恰有一个启用的检测站会自动认定；零个或多个时建单会提示先在这里指定。
        </div>
        <div v-if="!stationCandidates.length" class="form-extra">
          还没有可选的检测站：先到部门管理把某部门类型改为检测站（须属总公司）。
        </div>
      </el-form-item>
      <el-form-item v-if="canSetPolicy">
        <el-button type="primary" :loading="saving" @click="save">保存</el-button>
      </el-form-item>
    </el-form>
  </SectionCard>
</template>

<script setup lang="ts">
import { QuestionFilled } from "@element-plus/icons-vue";
import SettingsAPI, { type BoxSettings } from "@/api/system/settings";
import DeptAPI, { type DeptItem } from "@/api/system/dept";
import SectionCard from "@/components/biz/SectionCard.vue";

/**
 * 采样箱默认策略与任务表单（IA 迁移：原系统设置 sec-box 分区整体迁入，现挂采样箱 › 默认策略页）。
 * 字段级授权：上报周期/定时上报/宽限/划拨送检开关/唯一检测站走 can.box（device:box:policyDefault），
 * 电量预留、到达半径各自授权；有任意一项就能保存（服务端按改了哪样再查）。
 * 脏状态向父级 emit（dirty），保存成功 emit saved（父级刷新全站开关/宽限缓存）；expose save 供保存条调用。
 * 放弃更改由父级重新 load() 后 value 变化触发回填（与设置页 discardDirty 同口径）。不含任何密钥字段。
 */
const props = defineProps<{
  value?: BoxSettings;
  can: { box: boolean; batteryReserve: boolean; arriveRadius: boolean };
  loading?: boolean;
}>();
const emit = defineEmits<{
  (e: "dirty", v: boolean): void;
  (e: "saved", v: BoxSettings): void;
}>();

/** inline 帮助文案：取自原设置页 hint，不新造口径。 */
const HELP = {
  batteryReserve: "从总电量底部扣掉，不计入可用电量",
  arriveRadius: "箱子离寄出、收货地址或计划地点在这个范围内算到达；基站定位误差常有一两公里",
} as const;

const form = reactive({
  reportPeriodSec: 60,
  reportOnlyWhenCharging: false,
  batteryReserve: 20,
  arriveRadiusM: 2000,
  /** 建单后未上线宽限，UI 以分钟展示（1–1440），保存时 ×60 存秒。 */
  taskOfflineGraceMin: 60,
  /** 划拨/送检功能开关。 */
  enableTransferInspect: false,
  /** 唯一检测站部门 id（组织简化 P5/review-org M1）：空串＝未配置，服务端自动认定。 */
  stationDeptId: "",
});
const saving = ref(false);
/** 已保存快照：回填/保存成功时刷新，判脏＝当前表单与之比对（秒→分钟换算后口径稳定）。 */
const savedSnap = ref("");
const canSetPolicy = computed(() =>
  Boolean(props.can.box || props.can.batteryReserve || props.can.arriveRadius)
);

/** 服务端 box 块 → 表单（宽限秒→分钟，默认 3600s=60 分钟），并刷新快照、清脏。 */
function fill(source?: BoxSettings) {
  form.reportPeriodSec = source?.reportPeriodSec || 60;
  form.reportOnlyWhenCharging = Boolean(source?.reportOnlyWhenCharging);
  form.batteryReserve = source?.batteryReserve ?? 20;
  form.arriveRadiusM = source?.arriveRadiusM ?? 2000;
  const graceSec = Number(source?.taskOfflineGraceSec);
  form.taskOfflineGraceMin =
    Number.isFinite(graceSec) && graceSec > 0 ? Math.round(graceSec / 60) : 60;
  form.enableTransferInspect = Boolean(source?.enableTransferInspect);
  form.stationDeptId = source?.stationDeptId || "";
  savedSnap.value = JSON.stringify(form);
  emit("dirty", false);
}
watch(
  () => props.value,
  (value) => fill(value),
  { immediate: true }
);
watch(form, () => emit("dirty", JSON.stringify(form) !== savedSnap.value), { deep: true });

/** 部门平铺（检测站候选用）：无部门读权限时静默降级为空，表单给灰字引导。 */
const deptFlat = ref<DeptItem[]>([]);
/** 候选＝type=检测站 且启用的部门（全局唯一，正常至多一个）。 */
const stationCandidates = computed(() =>
  deptFlat.value.filter((d) => d.type === "检测站" && Number(d.status) === 1)
);
/** 下拉选项：候选之外，已配置但失效的部门也列出来（标注原因），避免只显示裸 id。 */
const stationOptions = computed(() => {
  const opts = stationCandidates.value.map((d) => ({
    value: String(d.id),
    label: String(d.name || d.id),
  }));
  const configured = form.stationDeptId;
  if (configured && !opts.some((o) => o.value === configured)) {
    const row = deptFlat.value.find((d) => String(d.id) === configured);
    const suffix = !row
      ? "（部门不存在，请重新指定）"
      : Number(row.status) !== 1
        ? "（已停用，请重新指定）"
        : "（类型已不是检测站，请重新指定）";
    opts.push({ value: configured, label: `${row?.name || configured}${suffix}` });
  }
  return opts;
});
async function loadStations() {
  try {
    const tree = await DeptAPI.getList(undefined, { silent: true });
    const flat: DeptItem[] = [];
    const walk = (nodes: DeptItem[]) => {
      for (const node of nodes || []) {
        flat.push(node);
        if (node.children?.length) walk(node.children);
      }
    };
    walk(tree || []);
    deptFlat.value = flat;
  } catch {
    deptFlat.value = [];
  }
}
onMounted(loadStations);

async function save() {
  // #settings-refactor audit-5：功能开关影响全局流程，变更时二次确认（取消＝不保存、不算错误）
  const flagBefore = Boolean(props.value?.enableTransferInspect);
  if (form.enableTransferInspect !== flagBefore) {
    try {
      await ElMessageBox.confirm(
        form.enableTransferInspect
          ? "开启后启用「调拨单/送检单」独立页与建单入口，任务单页只放采样。确认开启？"
          : "关闭后调拨/送检新端点报未开通，仅旧流程可用。确认关闭？",
        "划拨/送检功能开关",
        { confirmButtonText: "确认", cancelButtonText: "取消", type: "warning" }
      );
    } catch {
      return;
    }
  }
  saving.value = true;
  try {
    const saved = await SettingsAPI.saveBox({
      reportPeriodSec: form.reportPeriodSec,
      reportOnlyWhenCharging: form.reportOnlyWhenCharging,
      batteryReserve: form.batteryReserve,
      arriveRadiusM: form.arriveRadiusM,
      // 分钟 → 秒（服务端 taskOfflineGraceSec 校验 60–86400）
      taskOfflineGraceSec: Math.round(form.taskOfflineGraceMin * 60),
      enableTransferInspect: form.enableTransferInspect,
      // 唯一检测站（P5/M1）：空串＝清空配置（服务端不校验清空，回退 DB 自动认定）
      stationDeptId: form.stationDeptId || "",
    });
    // 成功：按服务端回读回填并清脏；失败：请求层按码弹错（权限/检测站校验友好报错），
    // 快照不动、脏标记保留，finally 只收 loading——错误分流与原设置页 saveBox 一致。
    fill(saved);
    emit("saved", saved);
    ElMessage.success("已保存");
  } finally {
    saving.value = false;
  }
}
defineExpose({ save });
</script>

<style lang="scss" scoped>
/* 表单栅格沿系统设置口径：label 140 右对齐，control 弹性封顶 480，行距 16，stepper 统一宽 */
.box-policy :deep(.el-form-item) {
  margin-bottom: 16px;
}
.box-policy :deep(.el-form > .el-form-item:last-child) {
  margin-bottom: 0;
}
.box-policy :deep(.el-form-item__content > .el-input),
.box-policy :deep(.el-form-item__content > .el-select) {
  width: 100%;
  max-width: 480px;
}
.box-policy :deep(.el-input-number) {
  width: 180px;
}
/* 短字段成对双列，窄屏回落单列 */
.form-pair {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  column-gap: 24px;
}
.label-help {
  display: inline-flex;
  gap: 4px;
  align-items: center;
}
.help-icon {
  font-size: 14px;
  color: var(--el-text-color-secondary);
  cursor: help;
}
/* form-item 内容换行的一行灰字帮助 */
.form-extra {
  flex-basis: 100%;
  margin-top: 4px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--el-text-color-secondary);
}
.unit {
  margin-left: 8px;
  color: var(--el-text-color-secondary);
}
@media (max-width: 900px) {
  .form-pair {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
