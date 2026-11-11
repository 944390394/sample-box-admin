<template>
  <div class="location-line" :class="{ 'is-compact': compact }">
    <template v-if="pos.current">
      <div class="location-line__main">
        <span class="src" :class="pos.current.source === 'GPS' ? 'is-gps' : 'is-lbs'">
          {{ pos.current.source }}
        </span>
        <span class="addr" :title="addressOf(pos.current)">{{ addressOf(pos.current) }}</span>
        <FreshTag
          v-if="pos.current.at"
          class="age"
          :time="pos.current.at"
          :period-sec="periodSec"
          :now="now"
        />
      </div>
      <div
        v-if="pos.gpsStale && pos.gps && !hideStaleGps"
        class="location-line__sub"
        data-test="gps-stale-hint"
      >
        最后一次 GPS：{{ ageText(pos.gps.at, now) }}
        <template v-if="!compact">
          （{{ shortTime(pos.gps.at) }}）· 之后没定到卫星，可能在室内或箱内遮挡
        </template>
      </div>
      <div v-else-if="pos.current.source === '基站' && !compact" class="location-line__sub">
        基站定位误差可能有一两公里
      </div>
    </template>
    <span v-else class="none">{{ emptyText }}</span>
  </div>
</template>

<script setup lang="ts">
import FreshTag from "@/components/biz/FreshTag.vue";
import {
  ageText,
  boxPositions,
  coordText,
  type PositionFields,
  type PositionFix,
} from "@/utils/position";
import { shortTime } from "@/utils/time";

/**
 * 一行写清位置：来源（GPS / 基站）、地址、多久前。GPS 过时、当前用基站时，下面一行写最后一次 GPS 是多久前。
 * compact 用在表格里：地址一行省略，提示只写「最后一次 GPS：3 天前」。
 */
const props = withDefaults(
  defineProps<{
    box: PositionFields;
    periodSec?: number | null;
    compact?: boolean;
    hideStaleGps?: boolean;
    emptyText?: string;
    now?: number;
  }>(),
  {
    periodSec: null,
    compact: false,
    hideStaleGps: false,
    emptyText: "未定位",
    now: undefined,
  }
);
const pos = computed(() => boxPositions(props.box));
const addressOf = (fix: PositionFix) => fix.address || coordText(fix.lng, fix.lat);
</script>

<style scoped>
.location-line {
  min-width: 0;
  line-height: 1.5;
}
.location-line__main {
  display: flex;
  gap: 6px;
  align-items: center;
  min-width: 0;
}
.src {
  flex-shrink: 0;
  padding: 0 5px;
  font-size: 11px;
  font-weight: 600;
  line-height: 18px;
  border-radius: 4px;
}
.src.is-gps {
  color: var(--loc-gps);
  background: var(--loc-gps-bg);
}
.src.is-lbs {
  color: var(--loc-lbs);
  background: var(--loc-lbs-bg);
}
.addr {
  min-width: 0;
  color: var(--el-text-color-primary);
}
.is-compact .addr {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.age {
  flex-shrink: 0;
  font-size: 12px;
}
.location-line__sub {
  margin-top: 2px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.none {
  color: var(--el-text-color-placeholder);
}
</style>
