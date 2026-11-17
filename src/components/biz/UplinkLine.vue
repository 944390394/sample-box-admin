<template>
  <div
    class="uplink-line"
    :class="{
      open: highlight && item.kind === 'pad',
      event: highlight && item.kind && !['timer', 'pad'].includes(item.kind),
    }"
  >
    <div class="main">
      <span class="clock" :title="fullTime(item.time)">
        {{ fullTime(item.time).slice(11, 19) }}
      </span>
      <el-tag
        size="small"
        :type="kindTone(item.kind)"
        :effect="item.kind === 'timer' ? 'plain' : 'light'"
      >
        {{ kindLabel(item.kind) }}
      </el-tag>
      <span v-if="showBox" class="box">{{ boxName }}</span>
      <span v-if="facts.volts != null" class="fact">{{ facts.volts.toFixed(2) }} V</span>
      <span v-if="facts.lid" class="fact" :class="{ warn: /开/.test(facts.lid) }">
        {{ facts.lid }}
      </span>
      <span v-if="facts.source" class="fact">{{ facts.source }}定位</span>
      <span v-for="part in facts.rest" :key="part" class="fact">{{ part }}</span>
      <span v-if="facts.seq != null" class="fact mono">seq {{ facts.seq }}</span>
      <span
        v-if="facts.clockDriftSec != null"
        class="fact warn"
        title="设备时钟和服务器收到时间相差较大，可能是离线补传"
      >
        设备时间 {{ fullTime(item.deviceTime).slice(5, 19) }}
      </span>
      <span class="spacer" />
      <el-button v-if="item.id && rawAllowed" link type="primary" size="small" @click="emit('raw')">
        {{ raw ? "收起原文" : "原文" }}
      </el-button>
    </div>
    <pre v-if="raw" class="raw">{{ formatRaw(raw) }}</pre>
  </div>
</template>

<script setup lang="ts">
import type { BoxLogItem } from "@/api/sample/box";
import { kindLabel } from "@/utils/labels";
import { fullTime } from "@/utils/time";
import { kindTone } from "@/utils/tone";
import { formatRaw, type UplinkFacts } from "@/views/sample/boxes/uplink";

/** 上报记录里的一条：时间、类型、电压、箱盖、定位来源、seq；原文点开才显示。 */
defineProps<{
  item: BoxLogItem;
  facts: UplinkFacts;
  showBox?: boolean;
  boxName?: string;
  raw?: string;
  highlight?: boolean;
  rawAllowed?: boolean;
}>();
const emit = defineEmits<{ raw: [] }>();
</script>

<style scoped>
.uplink-line {
  padding: 6px 4px;
  font-size: 13px;
}
.uplink-line.open {
  background: var(--el-color-danger-light-9);
}
.uplink-line.event {
  background: var(--el-fill-color-lighter);
}
.main {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  align-items: center;
}
.clock {
  min-width: 64px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.box {
  font-weight: 600;
}
.fact {
  color: var(--el-text-color-secondary);
}
.fact.warn {
  color: var(--el-color-warning-dark-2);
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.spacer {
  flex: 1;
}
.raw {
  max-height: 320px;
  padding: 10px;
  margin: 6px 0 0;
  overflow: auto;
  font-size: 12px;
  line-height: 1.5;
  background: var(--el-fill-color-light);
  border-radius: 6px;
}
</style>
