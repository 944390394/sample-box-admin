<template>
  <div class="policy-fields">
    <div class="period">
      <span>上报周期</span>
      <el-input-number
        v-model="model.reportPeriodSec"
        :min="5"
        :max="3600"
        :precision="0"
        :disabled="disabled"
      />
      <span>秒</span>
    </div>
    <div class="shortcuts">
      <el-button
        v-for="n in [5, 30, 60, 300, 600, 900]"
        :key="n"
        size="small"
        :disabled="disabled"
        @click="model.reportPeriodSec = n"
      >
        {{ n < 60 ? `${n} 秒` : `${n / 60} 分钟` }}
      </el-button>
    </div>
    <div class="module">
      <span>卫星定位</span>
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
    </div>
    <p v-if="model.periodicGps === undefined">
      尚未指定。使用 1.0.17 专用任务模板时，{{
        task ? "任务期间默认随定时上报定位" : "有任务时默认随定时上报定位，空闲时默认关闭卫星定位"
      }}。只改周期会保留此默认行为。
    </p>
    <el-switch
      v-model="model.reportOnlyWhenCharging"
      :disabled="disabled"
      active-text="仅充电时定时上报"
      inactive-text="持续定时上报"
    />
    <p>
      开箱、关箱、上电和插拔充电器仍立即上报（充电中、已充满之间的切换随下一条定时上报带上）。仅充电模式下，电池供电下定时心跳至少间隔
      10 分钟。
    </p>
    <el-switch
      :model-value="model.indicators !== false"
      :disabled="disabled"
      :active-text="`${labels.led.stm}日常亮`"
      :inactive-text="`${labels.led.stm}日常灭`"
      @update:model-value="
        (value: string | number | boolean) => {
          model.indicators = Boolean(value);
        }
      "
    />
    <p>
      只管 STM 的开盖、充电、就绪三个灯，需固件 1.0.7 及以上，旧固件会忽略。长按 PB5
      恢复出厂和远程抹除时的进度灯照常点亮。
    </p>
    <div class="module">
      <span>{{ labels.led.module }}</span>
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
    </div>
    <p>
      模块灯需要 STM 固件 1.0.8 及以上，并收到设备链路标记 rn=1。使用 1.0.17
      专用任务模板时，接收和发送数据模板均留空，由任务模板控制模块灯。选“不管”会保留模块自身的灯设置。
    </p>
  </div>
</template>
<script setup lang="ts">
import { labels } from "@/utils/labels";
import type { Policy } from "@/api/sample/report-policy";
const model = defineModel<Policy>({ required: true });
withDefaults(defineProps<{ disabled?: boolean; task?: boolean }>(), { task: false });
</script>
<style scoped>
.module {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
  margin-top: 6px;
}
.period,
.shortcuts {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
  margin-bottom: 14px;
}
p {
  font-size: 12px;
  line-height: 1.7;
  color: var(--el-text-color-secondary);
}
</style>
