<template>
  <div class="box-info" data-test="box-info">
    <SectionCard title="身份">
      <InfoList :items="identity" />
    </SectionCard>

    <SectionCard title="归属">
      <InfoList :items="belong" />
    </SectionCard>

    <SectionCard title="运行">
      <InfoList :items="run">
        <template #storage>
          <div v-if="box.storageFree != null" class="meter">
            <div class="meter__bar"><i :style="{ width: `${storageUsedPct}%` }" /></div>
            <span>剩余 {{ (box.storageFree / 1048576).toFixed(2) }} MB / 4.00 MB</span>
          </div>
          <span v-else class="muted">—</span>
        </template>
      </InfoList>
    </SectionCard>

    <SectionCard v-if="canPower" title="电池">
      <template v-if="box.batteryUsable != null && box.batterySoc != null">
        <div class="battery">
          <strong :style="{ color: usableColor }">{{ box.batteryUsable }}%</strong>
          <span class="text-muted">可用</span>
        </div>
        <div
          class="battery-bar"
          :title="`总电量 ${box.batterySoc}%，其中最底下 ${reserve}% 预留不计入可用`"
        >
          <i class="reserve" :style="{ width: `${reserve}%` }" />
          <i
            class="usable"
            :style="{
              left: `${reserve}%`,
              width: `${Math.max(0, box.batterySoc - reserve)}%`,
              background: usableColor,
            }"
          />
        </div>
        <div class="battery-scale">
          <span>预留 {{ reserve }}%</span>
          <span>总电量 {{ box.batterySoc }}%</span>
        </div>
      </template>
      <InfoList :items="battery" />
    </SectionCard>

    <SectionCard v-if="canLocation" title="定位" class="span-2">
      <InfoList :items="location" label-width="72px">
        <template #gps>
          <div v-if="pos.gps" class="fix">
            <div class="fix__line">
              <span class="mono">{{ coordText(pos.gps.lng, pos.gps.lat) }}</span>
              <FreshTag :time="pos.gps.at" :period-sec="box.reportPeriodSec" />
              <el-tag
                v-if="pos.current?.source === 'GPS'"
                size="small"
                type="primary"
                effect="plain"
              >
                当前使用
              </el-tag>
              <button type="button" class="copy" @click="copy(coordText(pos.gps.lng, pos.gps.lat))">
                复制
              </button>
            </div>
            <div v-if="pos.gps.address" class="fix__addr">{{ pos.gps.address }}</div>
            <div v-if="pos.gpsStale" class="fix__hint">
              定位时间 {{ fullTime(pos.gps.at) }}，之后一直没定到卫星，现在按基站位置算
            </div>
          </div>
          <span v-else class="muted">
            {{ box.gps === "未定位" ? "上报过，但还没定到卫星" : "—" }}
          </span>
        </template>
        <template #lbs>
          <div v-if="pos.lbs" class="fix">
            <div class="fix__line">
              <span class="mono">{{ coordText(pos.lbs.lng, pos.lbs.lat) }}</span>
              <FreshTag v-if="pos.lbs.at" :time="pos.lbs.at" :period-sec="box.reportPeriodSec" />
              <el-tag
                v-if="pos.current?.source === '基站'"
                size="small"
                type="warning"
                effect="plain"
              >
                当前使用
              </el-tag>
              <button type="button" class="copy" @click="copy(coordText(pos.lbs.lng, pos.lbs.lat))">
                复制
              </button>
            </div>
            <div v-if="pos.lbs.address" class="fix__addr">{{ pos.lbs.address }}</div>
            <div class="fix__hint">基站定位误差可能有一两公里</div>
          </div>
          <span v-else class="muted">—</span>
        </template>
      </InfoList>
    </SectionCard>
  </div>
</template>

<script setup lang="ts">
import FreshTag from "@/components/biz/FreshTag.vue";
import InfoList, { type InfoItem } from "@/components/biz/InfoList.vue";
import SectionCard from "@/components/biz/SectionCard.vue";
import { usePerm } from "@/composables/usePerm";
import { lifeLabel } from "@/utils/labels";
import { boxPositions, coordText, round } from "@/utils/position";
import { fullTime } from "@/utils/time";
import { BOX_PERM, type SampleBox } from "../data";

/**
 * 采样箱详情 · 设备：它是什么、硬件状况。分五块：身份、归属、运行、电池、定位。
 * 定位里 GPS 和基站各一行，写清各自多久前、哪个是现在用的；数字统一取整，坐标 6 位小数。
 */
const props = defineProps<{ box: SampleBox }>();
const can = usePerm();
const canPower = computed(() => can(BOX_PERM.power));
const canLocation = computed(() => can(BOX_PERM.location));

const pos = computed(() => boxPositions(props.box));
const timeOrDash = (t?: string | null) => (t ? fullTime(t) : "—");

const identity = computed<InfoItem[]>(() => {
  const b = props.box;
  const list: InfoItem[] = [
    { label: "IMEI", value: b.id, mono: true, copy: true, tip: "设备编号，贴在箱体上" },
    { label: "名称", value: b.name || "—" },
  ];
  // ICCID、IMSI、固件版本各要各的权限
  if (can(BOX_PERM.iccid))
    list.push({ label: "ICCID", value: b.iccid || "—", mono: true, copy: true, tip: "SIM 卡号" });
  if (can(BOX_PERM.imsi)) list.push({ label: "IMSI", value: b.imsi || "—", mono: true });
  if (can(BOX_PERM.firmware)) list.push({ label: "固件", value: b.firmware || "—", mono: true });
  return list;
});

const belong = computed<InfoItem[]>(() => {
  const b = props.box;
  return [
    { label: "所属单位", value: b.org || "总公司" },
    { label: "保管人", value: b.owner && b.owner !== "—" ? b.owner : "未指定" },
    { label: "状态", value: lifeLabel(b.life) },
    { label: "建档时间", value: timeOrDash(b.poweredAt) },
  ];
});

const run = computed<InfoItem[]>(() => {
  const b = props.box;
  const list: InfoItem[] = [
    {
      label: "上报周期",
      value: b.reportPeriodSec
        ? `${b.reportPeriodSec} 秒${b.reportOnlyWhenCharging ? "（只在充电时）" : ""}`
        : "—",
    },
    { label: "最近上报", value: timeOrDash(b.last) },
  ];
  if (can(BOX_PERM.powerLog))
    list.push(
      { label: "最近上电", value: timeOrDash(b.bootedAt) },
      { label: "上次掉电", value: timeOrDash(b.lastPowerOff) }
    );
  if (can(BOX_PERM.storage))
    list.push({
      label: "剩余存储",
      value: b.storageFree == null ? "—" : "x",
      slot: "storage",
      tip: "设备离线时上报先存在这里，联网后补传",
    });
  return list;
});
const storageUsedPct = computed(() => {
  const free = props.box.storageFree;
  if (free == null) return 0;
  return Math.min(100, Math.max(0, Math.round((1 - free / 4194304) * 100)));
});

const reserve = computed(() => props.box.batteryReserve ?? 20);
const usableColor = computed(() => {
  const v = props.box.batteryUsable ?? 100;
  return v < 20 ? "var(--status-danger)" : v < 50 ? "var(--status-warn)" : "var(--status-ok)";
});
const battery = computed<InfoItem[]>(() => {
  const b = props.box;
  const basis =
    b.batteryBasis === "charge"
      ? "充电中，已扣掉充电时端电压抬高"
      : b.batteryBasis === "full"
        ? "充电器已报充满"
        : b.batteryDevice
          ? `设备已学习 ${b.batteryCycles ?? 0} 次充放电`
          : b.batteryLearned
            ? `已学习 ${b.batteryCycles ?? 0} 次充放电`
            : "还没完整充放过电，按锂电池默认曲线估算";
  return [
    { label: "电压", value: b.battery || "—" },
    { label: "估算依据", value: basis },
  ];
});

const location = computed<InfoItem[]>(() => {
  const info = props.box.gpsInfo;
  const list: InfoItem[] = [
    { label: "GPS", value: "x", slot: "gps", test: "loc-gps" },
    { label: "基站", value: "x", slot: "lbs", test: "loc-lbs" },
  ];
  if (info && pos.value.gps) {
    const parts = [
      info.speed != null ? `速度 ${round(info.speed, 1)} km/h` : "",
      info.course != null ? `航向 ${round(info.course, 0)}°` : "",
      info.alt != null ? `海拔 ${round(info.alt, 0)} m` : "",
      info.sats != null ? `卫星 ${info.sats} 颗` : "",
      info.hdop != null ? `精度因子 ${round(info.hdop, 1)}` : "",
    ].filter(Boolean);
    if (parts.length)
      list.push({
        label: "GPS 细节",
        value: parts.join(" · "),
        tip: "最后一次 GPS 定位时的速度、航向等。精度因子越小越准，2 以下算好",
      });
  }
  return list;
});

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    ElMessage.success("已复制");
  } catch {
    ElMessage.warning("复制失败，请手动选择");
  }
}
</script>

<style scoped>
.box-info {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--page-gap);
  align-items: start;
}
.span-2 {
  grid-column: span 2;
}
.meter {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.meter__bar {
  height: 6px;
  overflow: hidden;
  background: var(--el-fill-color-light);
  border-radius: 3px;
}
.meter__bar i {
  display: block;
  height: 100%;
  background: var(--el-color-primary);
}
.battery {
  display: flex;
  gap: 6px;
  align-items: baseline;
}
.battery strong {
  font-size: 24px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.battery-bar {
  position: relative;
  height: 10px;
  margin: 8px 0 4px;
  overflow: hidden;
  background: var(--el-fill-color-light);
  border-radius: 5px;
}
.battery-bar i {
  position: absolute;
  top: 0;
  bottom: 0;
}
.battery-bar .reserve {
  left: 0;
  background: repeating-linear-gradient(
    45deg,
    var(--el-border-color),
    var(--el-border-color) 3px,
    transparent 3px,
    transparent 6px
  );
}
.battery-scale {
  display: flex;
  justify-content: space-between;
  margin-bottom: 12px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.fix__line {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  align-items: center;
}
.fix__addr {
  margin-top: 2px;
}
.fix__hint {
  margin-top: 2px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12.5px;
}
.muted {
  color: var(--el-text-color-placeholder);
}
.copy {
  padding: 0;
  font: inherit;
  font-size: 12px;
  color: var(--el-color-primary);
  cursor: pointer;
  background: none;
  border: 0;
}
@media (max-width: 1280px) {
  .box-info {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
@media (max-width: 760px) {
  .box-info {
    grid-template-columns: minmax(0, 1fr);
  }
  .span-2 {
    grid-column: auto;
  }
}
</style>
