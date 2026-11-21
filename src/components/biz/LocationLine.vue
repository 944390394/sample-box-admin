<template>
  <div class="location-line" :class="{ 'is-compact': compact }">
    <template v-if="pos.current">
      <div class="location-line__main">
        <span class="src" :class="pos.current.source === 'GPS' ? 'is-gps' : 'is-lbs'">
          {{ pos.current.source }}
        </span>
        <span class="addr" :title="addressOf(pos.current)">{{ addressOf(pos.current) }}</span>
        <FreshTag
          class="age"
          :time="pos.current.at"
          :period-sec="periodSec"
          :now="now"
          empty-text="无定位时间"
        />
      </div>
      <!-- 位置卡（详情、抽屉）用双行：GPS 和基站各写各自的时效，当前没用上的那个徽章置灰 -->
      <div v-if="dual" class="location-line__ages" data-test="location-ages">
        <div class="ages__row" :class="{ 'is-off': pos.current.source !== 'GPS' }">
          <span class="src" :class="pos.current.source === 'GPS' ? 'is-gps' : 'is-mute'">GPS</span>
          <span class="ages__text">
            {{ pos.lastGpsAt ? ageText(pos.lastGpsAt, now) : "无记录" }}
          </span>
        </div>
        <div class="ages__row" :class="{ 'is-off': pos.current.source !== '基站' }">
          <span class="src" :class="pos.current.source === '基站' ? 'is-lbs' : 'is-mute'">
            基站
          </span>
          <span class="ages__text">
            {{ pos.lastLbsAt ? ageText(pos.lastLbsAt, now) : "无记录" }}
          </span>
        </div>
        <div v-if="pos.current.source === '基站'" class="location-line__sub">
          现在按基站位置算{{
            pos.gpsStale ? "，之后一直没定到卫星" : ""
          }}；基站定位误差可能有一两公里
        </div>
      </div>
      <div
        v-else-if="pos.gpsStale && pos.gps && !hideStaleGps"
        class="location-line__sub"
        data-test="gps-stale-hint"
      >
        {{ staleGpsText }}
      </div>
      <div
        v-else-if="pos.gpsTimeUnknown && pos.current.source === 'GPS'"
        class="location-line__sub"
        data-test="gps-time-unknown-hint"
      >
        GPS 无定位时间记录，按历史位置展示，可能已过期
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
 * dual 给位置卡：GPS、基站各一行时效，当前没用上的来源徽章置灰；没有定位记录写「无记录」，
 * 不留一个看着像「数据没加载」的空白。地址、时效都跟着当前用的那个来源。
 */
const props = withDefaults(
  defineProps<{
    box: PositionFields;
    periodSec?: number | null;
    compact?: boolean;
    hideStaleGps?: boolean;
    dual?: boolean;
    emptyText?: string;
    now?: number;
  }>(),
  {
    periodSec: null,
    compact: false,
    hideStaleGps: false,
    dual: false,
    emptyText: "未定位",
    now: undefined,
  }
);
const pos = computed(() => boxPositions(props.box));
const addressOf = (fix: PositionFix) => fix.address || coordText(fix.lng, fix.lat);
/**
 * GPS 过时、当前用基站时的说明：最后一次 GPS 多久前、什么时候定的位。
 * 写成计算属性而不是模板里拼两段，是为了不让模板换行在中间留出一个多余空格
 * （「3 天前 （11-16 11:24）」这种）。compact 表格里只留相对时效。
 */
const staleGpsText = computed(() => {
  const gps = pos.value.gps;
  if (!gps) return "";
  const age = ageText(gps.at, props.now);
  return props.compact
    ? `最后一次 GPS：${age}`
    : `最后一次 GPS：${age}（${shortTime(gps.at)}）· 之后没定到卫星，可能在室内或箱内遮挡`;
});
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
.location-line__ages {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: 4px;
}
.ages__row {
  display: flex;
  gap: 6px;
  align-items: center;
  font-size: 12px;
}
.ages__text {
  font-variant-numeric: tabular-nums;
  color: var(--el-text-color-regular);
}
/* 当前没用上的那个来源：徽章和时效一起压成灰色，一眼看出这台现在信的是谁 */
.src.is-mute {
  color: var(--el-text-color-placeholder);
  background: var(--el-fill-color-light);
}
.ages__row.is-off .ages__text {
  color: var(--el-text-color-placeholder);
}
.none {
  color: var(--el-text-color-placeholder);
}
</style>
