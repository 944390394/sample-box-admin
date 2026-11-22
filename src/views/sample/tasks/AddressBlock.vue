<template>
  <div class="address-block" :data-test="`address-block-${variant}`">
    <!-- 双模式 seg（寄出/收货）：公司地址默认；计划地点只读，无 seg -->
    <div v-if="variant !== 'plan'" class="seg">
      <el-radio-group v-model="mode" size="small" :data-test="`address-mode-${variant}`">
        <el-radio-button value="company">{{ companyLabel }}</el-radio-button>
        <el-radio-button value="custom">{{ customLabel }}</el-radio-button>
      </el-radio-group>
    </div>

    <!-- 公司/检测站地址（只读）或计划地点（只读） -->
    <template v-if="mode === 'company'">
      <template v-if="companySet">
        <div class="addr-card" data-test="address-company-card">
          <el-icon class="pin"><Location /></el-icon>
          <div class="addr-text">
            <div>{{ companyLocation!.address || "已定位，未填地址文字" }}</div>
            <div class="muted">
              <template v-if="companyLocation!.inherited">
                沿用上级「{{ companyLocation!.fromName }}」 ·
              </template>
              <template v-if="companyLocation!.contact">
                {{ companyLocation!.contact }} {{ companyLocation!.phone }} ·
              </template>
              {{
                modelValue?.lng == null
                  ? "没有坐标，不能自动判断是否到达"
                  : `坐标 ${modelValue.lng.toFixed(5)}, ${modelValue.lat!.toFixed(5)}`
              }}
            </div>
          </div>
          <el-tag size="small" type="info" effect="plain">只读</el-tag>
        </div>
        <PlacePreview
          v-if="modelValue?.lng != null"
          :lng="modelValue.lng"
          :lat="modelValue.lat"
          :radius-m="modelValue.radiusM ?? defaultRadius"
        />
      </template>
      <template v-else>
        <div class="addr-empty" data-test="address-unset-card">
          <el-icon class="warn"><WarningFilled /></el-icon>
          <div class="addr-text">
            <div>{{ unsetTitle }}</div>
            <div class="muted">{{ unsetDesc }}</div>
          </div>
          <div class="addr-actions">
            <el-link
              v-if="setupVisible"
              type="primary"
              :href="setupHref"
              target="_blank"
              :underline="false"
              data-test="address-setup-link"
            >
              去设置
            </el-link>
            <el-button
              v-if="variant !== 'plan'"
              link
              type="primary"
              data-test="address-use-custom"
              @click="mode = 'custom'"
            >
              改用{{ customLabel }}
            </el-button>
            <el-button
              link
              type="primary"
              :loading="refreshing"
              data-test="address-refresh"
              @click="onRefresh"
            >
              {{ refreshLabel }}
            </el-button>
          </div>
        </div>
      </template>
      <!-- 计划地点无坐标灰字注（不拦截）：开箱录像只在采样中触发 -->
      <p
        v-if="variant === 'plan' && modelValue?.lng == null"
        class="tip"
        data-test="address-plan-note"
      >
        未设置计划地点：开箱录像仅在采样中触发
      </p>
    </template>

    <!-- 自定义地址：地图选点＋地址文字＋误差范围 -->
    <template v-else>
      <div :data-test="`address-custom-${variant}`">
        <LocationPicker
          :model-value="modelValue"
          :radius-m="radius"
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
  </div>
</template>

<script setup lang="ts">
import { Location, WarningFilled } from "@element-plus/icons-vue";
import LocationPicker, { type PickedPlace } from "@/components/LocationPicker/index.vue";
import PlacePreview from "./PlacePreview.vue";
import RadiusSelect from "./RadiusSelect.vue";
import type { Place, TaskOrg } from "@/api/sample/report-policy";

/**
 * #88 建单地址三块（用户四条拍板）：
 * - ship（step3 寄出地址）：双模式「公司地址」默认／「自定义地址」；公司已设置＝只读卡＋只读地图，
 *   未设置＝提示卡＋去设置（新标签部门页 ?edit=）＋改用自定义＋刷新；必填（checkStep 在父级拦）。
 * - plan（step4 计划地点）：只读，不允许修改地址；公司只读卡＋只读地图；未设置＝提示＋去设置＋刷新；
 *   无坐标灰字注「未设置计划地点：开箱录像仅在采样中触发」，不拦截。
 * - receive（step5 收货地址）：双模式「检测站地址」默认／「自定义收货地址」；未设置＝提醒＋可切自定义；
 *   去设置仅 STATION_ADMIN/ADMIN 可见（父级 showSetup gate）；不新增必填。
 * 公司模式恒把单位有效地址（effectiveDeptLocation）作为最终 Place 下发（custom:false），
 * 与「前端传最终 address 字符串、服务端仅校验非空」口径一致。
 */
const props = defineProps<{
  modelValue: Place | null;
  org: TaskOrg | null;
  variant: "ship" | "plan" | "receive";
  companyLabel?: string;
  customLabel?: string;
  /** 去设置可见性：receive 由父级按角色 gate；ship/plan 默认可见 */
  showSetup?: boolean;
  defaultRadius?: number;
}>();
const emit = defineEmits<{
  "update:modelValue": [value: Place | null];
  refresh: [];
}>();

const router = useRouter();
const mode = ref<"company" | "custom">("company");
const refreshing = ref(false);
const defaultRadius = computed(() => props.defaultRadius ?? 2000);
const radius = computed(() => props.modelValue?.radiusM ?? defaultRadius.value);
const companyLabel = computed(
  () => props.companyLabel ?? (props.variant === "receive" ? "检测站地址" : "公司地址")
);
const customLabel = computed(
  () => props.customLabel ?? (props.variant === "receive" ? "自定义收货地址" : "自定义地址")
);
const refreshLabel = computed(() =>
  props.variant === "receive" ? "刷新检测站地址" : "刷新公司地址"
);
const companyLocation = computed(() => props.org?.location ?? null);
const companySet = computed(() => Boolean(companyLocation.value));
const orgName = computed(() => props.org?.name || "该单位");
// 去设置可见性：ship/plan 恒可见；receive 由父级按角色 gate（showSetup）。
// 注意 Vue boolean prop 缺省铸造为 false（非 undefined），不能用 ?? 兜底，按 variant 显式判定。
const setupVisible = computed(() =>
  props.variant === "receive" ? Boolean(props.showSetup) : true
);
const setupHref = computed(
  () => router.resolve({ path: "/system/dept", query: { edit: String(props.org?.id || "") } }).href
);
const unsetTitle = computed(() =>
  props.variant === "receive"
    ? "检测站未设置地址，请联系检测站管理员设置"
    : `${orgName.value}未设置地址`
);
const unsetDesc = computed(() =>
  props.variant === "plan"
    ? "设置公司地址后自动带出计划地点，也可在部门页补地址。"
    : "设置公司地址后可直接选用，或改用自定义地址。"
);

/** 公司模式最终地址：单位有效地址原样带出（custom:false），误差范围沿用已选值。 */
function companyPlace(): Place | null {
  const loc = companyLocation.value;
  if (!loc || !props.org) return null;
  return {
    address: loc.address,
    lng: loc.lng,
    lat: loc.lat,
    orgId: props.org.id,
    custom: false,
    radiusM: props.modelValue?.radiusM,
  };
}
function syncCompany() {
  if (mode.value === "company") emit("update:modelValue", companyPlace());
}

function setCustom(value: PickedPlace | null) {
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
async function onRefresh() {
  refreshing.value = true;
  try {
    emit("refresh");
    // 父级刷新是异步重拉单位列表；稍等让 org.location 落定再回到公司模式带出新地址
    await new Promise((r) => setTimeout(r, 600));
    syncCompany();
  } finally {
    refreshing.value = false;
  }
}

// 换单位：回到公司模式并带出新单位地址（计划地点只读，同样带出）
watch(
  () => props.org?.id,
  () => {
    mode.value = "company";
    syncCompany();
  }
);
// 刷新后单位地址落定（org.location 变化）：公司模式重新带出
watch(companyLocation, () => syncCompany());
// 切模式：公司＝带出单位地址；自定义＝以当前地址为起点（标 custom），无则空待选点
watch(mode, (next) => {
  if (next === "company") {
    syncCompany();
  } else {
    const base = props.modelValue;
    emit("update:modelValue", base ? { ...base, custom: true } : null);
  }
});
onMounted(() => syncCompany());
</script>

<style scoped>
.address-block {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
}
.seg {
  display: flex;
}
.addr-card,
.addr-empty {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  padding: 10px 12px;
  line-height: 1.6;
  background: var(--el-fill-color-lighter);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 6px;
}
.addr-empty {
  background: var(--el-color-warning-light-9);
  border-color: var(--el-color-warning-light-5);
}
.pin {
  margin-top: 2px;
  font-size: 18px;
  color: var(--el-color-primary);
}
.warn {
  margin-top: 2px;
  font-size: 18px;
  color: var(--el-color-warning);
}
.addr-text {
  flex: 1;
  min-width: 0;
  word-break: break-all;
}
.addr-actions {
  display: flex;
  flex-shrink: 0;
  flex-wrap: wrap;
  gap: 4px 12px;
  align-items: center;
}
.muted {
  margin: 0;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.tip {
  width: 100%;
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--el-text-color-placeholder);
}
.radius {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 8px;
  align-items: center;
  margin-top: 8px;
  font-size: 13px;
}
</style>
