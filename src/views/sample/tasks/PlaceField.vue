<template>
  <div class="place-field">
    <div class="head">
      <el-radio-group v-if="org?.location" v-model="mode" size="small">
        <el-radio-button value="org">单位地址</el-radio-button>
        <el-radio-button value="custom">自定义</el-radio-button>
      </el-radio-group>
      <span v-else-if="org" class="muted">「{{ org.name }}」还没设置位置，先自定义</span>
    </div>

    <div v-if="!mapOpen" class="card" :class="{ empty: !modelValue }">
      <el-icon class="pin"><Location /></el-icon>
      <div class="text">
        <template v-if="modelValue">
          <div>{{ modelValue.address || "已定位，未填地址文字" }}</div>
          <div class="muted">
            <template v-if="mode === 'org' && org?.location?.inherited">
              沿用上级「{{ org.location.fromName }}」 ·
            </template>
            <template v-if="mode === 'org' && org?.location?.contact">
              {{ org.location.contact }} {{ org.location.phone }} ·
            </template>
            {{
              modelValue.lng == null
                ? "没有坐标，不能自动判断是否到达"
                : `坐标 ${modelValue.lng.toFixed(5)}, ${modelValue.lat!.toFixed(5)}`
            }}
          </div>
        </template>
        <span v-else class="muted">还没有地址</span>
      </div>
      <el-button size="small" @click="mapOpen = true">
        {{ mode === "org" ? "看地图" : modelValue ? "修改位置" : "地图选点" }}
      </el-button>
    </div>
    <div v-else class="bar">
      <span class="muted">
        {{
          mode === "org"
            ? "在地图上改位置会变成自定义地址，不影响单位资料"
            : "搜索或在地图上点选，地址会自动填入"
        }}
      </span>
      <el-button size="small" @click="mapOpen = false">收起地图</el-button>
    </div>

    <LocationPicker
      v-if="mapOpen"
      :model-value="modelValue"
      :radius-m="modelValue?.lng != null ? radius : undefined"
      @update:model-value="setCustom"
    />

    <div v-if="modelValue?.lng != null" class="radius">
      <span>误差范围</span>
      <RadiusSelect
        :model-value="radius"
        :default-radius="defaultRadius"
        @update:model-value="setRadius"
      />
      <span class="muted">圈内算到达。GPS 一般十几米，基站 500 米到几公里</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { Location } from "@element-plus/icons-vue";
import LocationPicker, { type PickedPlace } from "@/components/LocationPicker/index.vue";
import type { Place, TaskOrg } from "@/api/sample/report-policy";
import RadiusSelect from "./RadiusSelect.vue";

const props = defineProps<{
  org: TaskOrg | null;
  modelValue: Place | null;
  defaultRadius?: number;
}>();
const emit = defineEmits<{ "update:modelValue": [value: Place | null] }>();

const mode = ref<"org" | "custom">(
  props.modelValue?.custom || !props.org?.location ? "custom" : "org"
);
const mapOpen = ref(false);
const defaultRadius = computed(() => props.defaultRadius ?? 2000);
const radius = computed(() => props.modelValue?.radiusM ?? defaultRadius.value);
/** 地图上改位置时由这里切到自定义，mode 的 watch 不再重复发一次。 */
let switching = false;

function fromOrg(org: TaskOrg | null): Place | null {
  if (!org?.location) return null;
  const { address, lng, lat } = org.location;
  return { address, lng, lat, orgId: org.id, custom: false, radiusM: props.modelValue?.radiusM };
}

function setCustom(value: PickedPlace | null) {
  if (mode.value === "org") {
    switching = true;
    mode.value = "custom";
  }
  emit(
    "update:modelValue",
    value
      ? { ...value, orgId: props.org?.id || "", custom: true, radiusM: props.modelValue?.radiusM }
      : null
  );
}

function setRadius(value: number) {
  if (!props.modelValue) return;
  emit("update:modelValue", {
    ...props.modelValue,
    radiusM: value === defaultRadius.value ? undefined : value,
  });
}

// 换单位：有位置就回到「单位地址」，没有就自定义并打开地图
watch(
  () => props.org?.id,
  () => {
    mode.value = props.org?.location ? "org" : "custom";
    mapOpen.value = !props.org?.location;
    emit("update:modelValue", fromOrg(props.org));
  }
);

// 切到自定义时以单位地址为起点并打开地图，切回来恢复单位地址
watch(mode, (next) => {
  if (switching) {
    switching = false;
    return;
  }
  if (next === "org") {
    mapOpen.value = false;
    emit("update:modelValue", fromOrg(props.org));
  } else {
    mapOpen.value = true;
    if (props.modelValue) emit("update:modelValue", { ...props.modelValue, custom: true });
  }
});

onMounted(() => {
  if (mode.value === "org" && !props.modelValue) emit("update:modelValue", fromOrg(props.org));
  if (mode.value === "custom" && !props.modelValue) mapOpen.value = true;
});
</script>

<style scoped>
.place-field {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
}
.head:empty {
  display: none;
}
.card {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 8px 10px;
  line-height: 1.6;
  background: var(--el-fill-color-lighter);
  border-radius: 4px;
}
.card.empty {
  background: none;
  border: 1px dashed var(--el-border-color);
}
.pin {
  color: var(--el-color-primary);
}
.text {
  flex: 1;
  min-width: 0;
  word-break: break-all;
}
.bar {
  display: flex;
  gap: 8px;
  align-items: center;
  justify-content: space-between;
}
.radius {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 8px;
  align-items: center;
  font-size: 13px;
}
.muted {
  margin: 0;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
</style>
