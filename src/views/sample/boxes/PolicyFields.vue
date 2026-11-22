<template>
  <div class="policy-fields" :class="{ 'is-grid': grid }">
    <div class="period frow">
      <span class="period-label flab">
        上报周期
        <el-tooltip
          v-if="grid"
          effect="light"
          popper-class="policy-help-popper"
          placement="top"
          :content="TIP.period"
        >
          <span class="policy-qmark" tabindex="0">?</span>
        </el-tooltip>
      </span>
      <div class="fctl">
        <DurationInput
          v-model="model.reportPeriodSec"
          :min="5"
          :max="3600"
          :disabled="disabled"
          :inline-chips="grid"
        />
      </div>
    </div>
    <div class="module frow">
      <span class="flab">
        卫星定位
        <el-tooltip
          v-if="grid"
          effect="light"
          popper-class="policy-help-popper"
          placement="top"
          :content="gpsTip"
        >
          <span class="policy-qmark" tabindex="0">?</span>
        </el-tooltip>
      </span>
      <div class="fctl">
        <el-radio-group
          :model-value="model.periodicGps"
          :disabled="disabled"
          @update:model-value="
            (v) => {
              model.periodicGps = v === true;
            }
          "
        >
          <el-radio-button :value="true">随定时上报定位</el-radio-button>
          <el-radio-button :value="false">关闭卫星定位</el-radio-button>
        </el-radio-group>
        <span v-if="grid && model.periodicGps === undefined" class="fnote">
          尚未指定，随任务模板默认
        </span>
      </div>
    </div>
    <p v-if="!grid && model.periodicGps === undefined">
      尚未指定。使用 1.0.17 专用任务模板时，{{
        task ? "任务期间默认随定时上报定位" : "有任务时默认随定时上报定位，空闲时默认关闭卫星定位"
      }}。只改周期会保留此默认行为。
    </p>
    <div class="frow">
      <span class="flab">
        定时上报
        <el-tooltip
          v-if="grid"
          effect="light"
          popper-class="policy-help-popper"
          placement="top"
          :content="TIP.charge"
        >
          <span class="policy-qmark" tabindex="0">?</span>
        </el-tooltip>
      </span>
      <div class="fctl">
        <el-switch
          v-model="model.reportOnlyWhenCharging"
          :disabled="disabled"
          active-text="仅充电时定时上报"
          inactive-text="持续定时上报"
        />
        <span v-if="grid" class="fnote">开＝仅充电时；事件恒立即上报</span>
      </div>
    </div>
    <p v-if="!grid">
      开箱、关箱、上电和插拔充电器仍立即上报（充电中、已充满之间的切换随下一条定时上报带上）。仅充电模式下，电池供电下定时心跳至少间隔
      10 分钟。
    </p>
    <div class="frow">
      <span class="flab">
        {{ labels.led.stm }}
        <el-tooltip
          v-if="grid"
          effect="light"
          popper-class="policy-help-popper"
          placement="top"
          :content="TIP.stm"
        >
          <span class="policy-qmark" tabindex="0">?</span>
        </el-tooltip>
      </span>
      <div class="fctl">
        <el-switch
          :model-value="model.indicators !== false"
          :disabled="disabled"
          :active-text="grid ? '日常亮' : `${labels.led.stm}日常亮`"
          :inactive-text="grid ? '日常灭' : `${labels.led.stm}日常灭`"
          @update:model-value="
            (value: string | number | boolean) => {
              model.indicators = Boolean(value);
            }
          "
        />
        <span v-if="grid" class="fnote">只管开盖 / 充电 / 就绪三灯</span>
      </div>
    </div>
    <p v-if="!grid">
      只管 STM 的开盖、充电、就绪三个灯，需固件 1.0.7 及以上，旧固件会忽略。长按 PB5
      恢复出厂和远程抹除时的进度灯照常点亮。
    </p>
    <div class="module frow">
      <span class="flab">
        {{ labels.led.module }}
        <el-tooltip
          v-if="grid"
          effect="light"
          popper-class="policy-help-popper"
          placement="top"
          :content="TIP.module"
        >
          <span class="policy-qmark" tabindex="0">?</span>
        </el-tooltip>
      </span>
      <div class="fctl">
        <el-radio-group
          :model-value="model.moduleLed === undefined ? 'keep' : model.moduleLed ? 'on' : 'off'"
          :disabled="disabled"
          @update:model-value="
            (value: string | number | boolean | undefined) => {
              model.moduleLed = value === 'keep' ? undefined : value === 'on';
            }
          "
        >
          <el-radio-button value="keep">不管</el-radio-button>
          <el-radio-button value="on">日常亮</el-radio-button>
          <el-radio-button value="off">日常灭</el-radio-button>
        </el-radio-group>
        <span v-if="grid" class="fnote">需固件 1.0.8＋链路 rn=1</span>
      </div>
    </div>
    <p v-if="!grid">
      模块灯需要 STM 固件 1.0.8 及以上，并收到设备链路标记 rn=1。使用 1.0.17
      专用任务模板时，接收和发送数据模板均留空，由任务模板控制模块灯。选“不管”会保留模块自身的灯设置。
    </p>
  </div>
</template>
<script setup lang="ts">
import { labels } from "@/utils/labels";
import type { Policy } from "@/api/sample/report-policy";
import DurationInput from "@/components/biz/DurationInput.vue";
const model = defineModel<Policy>({ required: true });
const props = withDefaults(defineProps<{ disabled?: boolean; task?: boolean; grid?: boolean }>(), {
  task: false,
  grid: false,
});

/**
 * grid（opt-in，#90 公司策略中心）：label 112px 定宽列网格＋行内控件＋≤20 字短说明＋? 气泡全文。
 * 默认 false 版式与文案一字不动（ReportPolicyDialog / tasks/create 调用点零回归）。
 * 气泡全文＝原 helper 段落原文；? 的限宽 360 单点常量在公司策略页全局样式（policy-help-popper）。
 */
const TIP = {
  period:
    "范围 5–3600 秒；时/分/秒联动自动进位归一（输入 90 秒 → 0时1分30秒），超范围自动调整并提示。灰字恒写「＝ X 秒」存储口径。",
  charge:
    "开箱、关箱、上电和插拔充电器仍立即上报（充电中、已充满之间的切换随下一条定时上报带上）。仅充电模式下，电池供电下定时心跳至少间隔 10 分钟。",
  stm: "只管 STM 的开盖、充电、就绪三个灯，需固件 1.0.7 及以上，旧固件会忽略。长按 PB5 恢复出厂和远程抹除时的进度灯照常点亮。",
  module:
    "模块灯需要 STM 固件 1.0.8 及以上，并收到设备链路标记 rn=1。使用 1.0.17 专用任务模板时，接收和发送数据模板均留空，由任务模板控制模块灯。选“不管”会保留模块自身的灯设置。",
} as const;
const gpsTip = computed(
  () =>
    `尚未指定。使用 1.0.17 专用任务模板时，${
      props.task
        ? "任务期间默认随定时上报定位"
        : "有任务时默认随定时上报定位，空闲时默认关闭卫星定位"
    }。只改周期会保留此默认行为。`
);
</script>
<style scoped>
.module {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
  margin-top: 6px;
}
.period {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: flex-start;
  margin-bottom: 14px;
}
.period-label {
  line-height: 32px;
}
p {
  font-size: 12px;
  line-height: 1.7;
  color: var(--el-text-color-secondary);
}
/* ── opt-in 网格版式（#90）：默认版式不受以下规则影响 ── */
.policy-fields:not(.is-grid) .fctl {
  display: contents;
}
.policy-fields.is-grid {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.policy-fields.is-grid .frow {
  display: grid;
  grid-template-columns: 112px minmax(0, 1fr);
  gap: 8px;
  align-items: center;
  min-height: 30px;
  margin: 0;
}
.policy-fields.is-grid .flab {
  display: inline-flex;
  gap: 5px;
  align-items: center;
  justify-content: flex-end;
  font-size: 13px;
  line-height: 1.4;
  color: var(--el-text-color-regular);
  text-align: right;
}
.policy-fields.is-grid .fctl {
  display: flex;
  flex-wrap: nowrap;
  gap: 8px;
  align-items: center;
  min-width: 0;
}
.policy-fields.is-grid .fnote {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  white-space: nowrap;
}
</style>
