<template>
  <div class="page-container page-flow">
    <PageHeader
      title="公司策略中心"
      subtitle="按公司设置箱子的默认策略：非任务期间与任务期间两份完整策略（双频），含指示灯、卫星定位与公司化判定阈值。只影响没有单箱、批量或任务设置的箱子；开关箱、上电、插拔充电器仍然马上上报。"
    />
    <div class="policy-main">
      <!-- 公司选择器：选项＝自己范围内的顶级公司（deptOptions 按 scope 裁剪）；只有一家公司时固定不可换 -->
      <SectionCard
        v-if="companyOptions.length"
        title="公司"
        sub="策略按顶级公司（分公司/总部）生效；箱子挂科室/班组时向上归到本公司"
      >
        <div class="picker-line">
          <el-select
            v-model="orgId"
            class="company-select"
            :disabled="companyOptions.length === 1"
            placeholder="选择公司"
            @change="onCompanyChange"
          >
            <el-option
              v-for="c in companyOptions"
              :key="c.value"
              :label="c.label"
              :value="c.value"
            />
          </el-select>
          <el-tag v-if="company" type="info" effect="plain">
            {{ company.boxCount }} 台箱子以本公司策略兜底
          </el-tag>
          <span v-if="company?.updatedAt" class="inherit-hint">
            最近保存：{{ company.updatedAt.slice(0, 19).replace("T", " ") }} ·
            {{ company.updatedBy || "—" }}
          </span>
        </div>
      </SectionCard>

      <el-alert
        v-if="companyError"
        :title="companyError"
        type="warning"
        :closable="false"
        class="group-gap"
      />
      <el-alert
        v-else-if="company && !canWrite"
        title="当前账号可查看本公司策略；修改需要「修改公司默认策略」权限，且只能改本公司（数据范围闸门）。"
        type="info"
        :closable="false"
        class="group-gap"
      />

      <template v-if="company">
        <!-- 分组一：上报策略（双频）。每份完整策略（周期/定时模式/指示灯/卫星定位），继承＝整层 NULL -->
        <div class="group-title">
          上报策略（双频）
          <span class="group-hint">
            每份是完整策略（含指示灯与卫星定位），不逐字段拼接；「继承」＝整层用系统默认。
          </span>
        </div>
        <SectionCard v-loading="companyLoading" sub="箱子没有单箱、批量或任务设置时生效">
          <template #title>
            非任务期间（idle）
            <el-tag :type="idleCustom ? 'success' : 'info'" size="small" effect="plain">
              {{ idleCustom ? "公司覆盖" : "继承系统默认" }}
            </el-tag>
          </template>
          <el-radio-group v-model="idleCustom" :disabled="!canWrite" class="mode-line">
            <el-radio :value="false">继承系统默认</el-radio>
            <el-radio :value="true">单独设置</el-radio>
          </el-radio-group>
          <p v-if="!idleCustom" class="inherit-line">
            当前系统默认：{{ company.system.reportPeriodSec }} 秒 ·
            {{ company.system.reportOnlyWhenCharging ? "仅充电时定时上报" : "持续定时上报" }} ·
            指示灯日常亮 · 卫星定位随任务默认（有任务定位、空闲关）
          </p>
          <PolicyFields v-else v-model="idleForm" :disabled="!canWrite" />
        </SectionCard>
        <SectionCard v-loading="companyLoading" sub="只影响新建任务单，进行中任务按建单快照执行">
          <template #title>
            任务期间默认（task）
            <el-tag :type="taskCustom ? 'success' : 'info'" size="small" effect="plain">
              {{ taskCustom ? "公司覆盖" : "继承系统默认" }}
            </el-tag>
          </template>
          <el-alert
            title="任务期间默认策略只影响新建任务单（作为「本任务统一」初始值/兜底）；进行中任务按建单快照执行，公司级后续修改不波及。长期单箱策略仍优先于它。"
            type="info"
            :closable="false"
            class="mode-line"
          />
          <el-radio-group v-model="taskCustom" :disabled="!canWrite" class="mode-line">
            <el-radio :value="false">继承系统默认</el-radio>
            <el-radio :value="true">单独设置</el-radio>
          </el-radio-group>
          <p v-if="!taskCustom" class="inherit-line">
            建单初始值用系统默认：{{ company.system.reportPeriodSec }} 秒 ·
            {{ company.system.reportOnlyWhenCharging ? "仅充电时定时上报" : "持续定时上报" }}
          </p>
          <PolicyFields v-else v-model="taskForm" :disabled="!canWrite" task />
        </SectionCard>

        <!-- 分组二：判定阈值（公司化，P1）。服务端生效不下发；留空＝继承系统默认 -->
        <div class="group-title">
          判定阈值（公司化）
          <span class="group-hint">
            服务端生效、不下发设备；勾选「继承」＝用系统默认。影响在线/低电/可调配与任务到达判定。
          </span>
        </div>
        <SectionCard v-loading="companyLoading">
          <el-form label-width="140px">
            <el-form-item label="电量预留">
              <el-checkbox v-model="reserveInherit" :disabled="!canWrite">继承系统默认</el-checkbox>
              <el-input-number
                v-model="reserveValue"
                :min="0"
                :max="80"
                :disabled="!canWrite || reserveInherit"
              />
              <span class="unit">%</span>
              <span class="inherit-hint">系统默认 {{ company.system.batteryReserve }}%</span>
            </el-form-item>
            <el-form-item label="任务到达半径">
              <el-checkbox v-model="radiusInherit" :disabled="!canWrite">继承系统默认</el-checkbox>
              <el-input-number
                v-model="radiusValue"
                :min="100"
                :max="50000"
                :step="500"
                :disabled="!canWrite || radiusInherit"
              />
              <span class="unit">米</span>
              <span class="inherit-hint">系统默认 {{ company.system.arriveRadiusM }} 米</span>
            </el-form-item>
            <el-form-item label="建单后未上线宽限">
              <el-checkbox v-model="graceInherit" :disabled="!canWrite">继承系统默认</el-checkbox>
              <el-input-number
                v-model="graceValue"
                :min="1"
                :max="1440"
                :step="5"
                :disabled="!canWrite || graceInherit"
              />
              <span class="unit">分钟</span>
              <span class="inherit-hint">
                系统默认 {{ Math.round(company.system.taskOfflineGraceSec / 60) }} 分钟
              </span>
            </el-form-item>
            <div class="form-extra">
              箱子在检测站期间，策略与判定阈值按寄出分公司生效（建单快照）；划拨/分配改挂后自动切换到新公司。
            </div>
          </el-form>
        </SectionCard>

        <!-- 分组三：只读说明（PM 裁决：深睡/在线低功耗只放说明；固件不支持项不做控件） -->
        <div class="group-title">只读说明（自动行为与不支持项）</div>
        <SectionCard>
          <ul class="readonly-list">
            <li>
              <b>休眠与低功耗（自动行为，无开关）</b>
              ：STM 空闲自动休眠、插电不休眠；DTU 深度休眠由 STM 按条件提议（周期≥600
              秒、电池供电、无任务、开箱 2 小时窗口外等），台架 IMEI 白名单默认空、生产未启用；DTU
              在线低功耗同为白名单制（需 DTU 固件 V2.0.9 及以上），生产未启用。
            </li>
            <li>
              <b>固定策略</b>
              ：搜星每轮≤60 秒、连续失败后降频；开箱后 2 小时在线窗口；电量曲线自动学习上报。
            </li>
            <li>
              <b>固件不支持（不做控件）</b>
              ：蜂鸣器、LED
              闪烁模式自定义（节拍固件写死）、采样间隔、设备侧电量阈值/开箱告警开关、远程重启指令。低电量/可调配判定在服务端（上方「判定阈值」），无需下发。
            </li>
            <li>
              <b>单箱操作引导</b>
              ：远程抹除、读设备本机日志在采样箱详情页逐台操作（各自授权），不放公司级；事件（开关箱/上电/插拔充电器）恒立即上报，不可关闭。
            </li>
          </ul>
        </SectionCard>
      </template>

      <!-- ADMIN 折叠区：系统默认（全局兜底）沿用 BoxPolicySettings，字段级三码 gating 不变 -->
      <el-collapse v-if="canSystem" v-model="systemOpen" class="system-collapse group-gap">
        <el-collapse-item name="system">
          <template #title>
            <span class="system-title">系统默认（全局兜底）</span>
            <el-tag type="warning" size="small" effect="plain">仅系统授权可改</el-tag>
            <span class="group-hint">公司层未设时的最终落点；唯一检测站/全局宽限在这里</span>
          </template>
          <BoxPolicySettings
            ref="policyCard"
            :value="settings?.box"
            :can="can"
            :loading="loading"
            @dirty="systemDirty = $event"
            @saved="onSaved"
          />
        </el-collapse-item>
      </el-collapse>
    </div>
    <div v-if="companyDirty || systemDirty" class="save-bar">
      <span class="save-bar-text">{{ saveBarText }}</span>
      <el-button size="small" @click="discard">放弃更改</el-button>
      <el-button size="small" type="primary" :loading="saving" @click="saveAll">保存</el-button>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { Ref } from "vue";
import { onBeforeRouteLeave } from "vue-router";
import SettingsAPI, { type BoxSettings, type TcpSettings } from "@/api/system/settings";
import DeptAPI from "@/api/system/dept";
import CompanyPolicyAPI, {
  type CompanyPolicy,
  type CompanyPolicyInput,
} from "@/api/sample/company-policy";
import type { Policy } from "@/api/sample/report-policy";
import BoxPolicySettings from "@/components/biz/BoxPolicySettings.vue";
import PageHeader from "@/components/biz/PageHeader.vue";
import SectionCard from "@/components/biz/SectionCard.vue";
import PolicyFields from "@/views/sample/boxes/PolicyFields.vue";
import { refreshBoxFeatures } from "@/composables/useBoxFeatures";

/**
 * 采样箱 › 默认策略 → 公司策略中心（R13，任务 #46）。
 * 菜单对 policyCompany/policyDefault/battery-reserve/arrive-radius 四码 some 可见（server/menus.js）。
 * 公司层：idle/task 两份完整策略（继承＝整层 NULL）＋判定阈值三列（null＝继承）；
 * 写闸门 device:box:policyCompany＋manageOrgIds（服务端 can.write 权威），无码只读。
 * ADMIN 折叠区沿用 BoxPolicySettings（系统默认全局兜底，字段级三码 gating）。
 * 脏标记/保存条/放弃/离开守卫复用原默认策略页口径：放弃＝重新 load，离开前确认，关页前 beforeunload。
 */
defineOptions({ name: "SampleBoxPolicy" });

/* ── 系统默认（ADMIN 折叠区） ── */
const loading = ref(false);
const settings = ref<TcpSettings | null>(null);
const systemDirty = ref(false);
const systemOpen = ref<string[]>([]);
const policyCard = ref<InstanceType<typeof BoxPolicySettings> | null>(null);
const can = computed(() => ({
  box: false,
  batteryReserve: false,
  arriveRadius: false,
  ...(settings.value?.can || {}),
}));
const canSystem = computed(() =>
  Boolean(can.value.box || can.value.batteryReserve || can.value.arriveRadius)
);

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
  // 继承态灰字跟着系统默认走（不重置公司表单，避免丢脏改动）
  if (company.value)
    company.value.system = {
      reportPeriodSec: v.reportPeriodSec,
      reportOnlyWhenCharging: v.reportOnlyWhenCharging,
      batteryReserve: v.batteryReserve,
      arriveRadiusM: v.arriveRadiusM ?? company.value.system.arriveRadiusM,
      taskOfflineGraceSec: v.taskOfflineGraceSec ?? company.value.system.taskOfflineGraceSec,
    };
}

/* ── 公司选择器 ── */
const companyOptions = ref<{ value: string; label: string }[]>([]);
const orgId = ref("");
async function loadOptions() {
  try {
    const tree = await DeptAPI.getOptions();
    // 顶级公司＝选项树的根（deptOptions 已按 scope 裁剪）；检测站不参与公司策略。
    // 旧服务端无 type 键时根都保留（检测站不是根，不误入）。
    companyOptions.value = (tree || [])
      .filter((node) => node.type !== "检测站")
      .map((node) => ({ value: String(node.value), label: node.label }));
  } catch {
    companyOptions.value = [];
  }
  if (!orgId.value && companyOptions.value.length) orgId.value = companyOptions.value[0].value;
}

/* ── 公司策略表单 ── */
const company = ref<CompanyPolicy | null>(null);
const companyLoading = ref(false);
const companyError = ref("");
const idleCustom = ref(false);
const taskCustom = ref(false);
const policyDefaults = (): Policy => ({
  reportPeriodSec: company.value?.system.reportPeriodSec ?? 60,
  reportOnlyWhenCharging: company.value?.system.reportOnlyWhenCharging ?? false,
  indicators: true,
});
const idleForm = ref<Policy>(policyDefaults());
const taskForm = ref<Policy>(policyDefaults());
/** 判定阈值三列：null＝继承系统默认（勾选「继承」）；UI 宽限以分钟展示。 */
const reserve = ref<number | null>(null);
const radius = ref<number | null>(null);
const graceMin = ref<number | null>(null);
const companySnap = ref("");
const saving = ref(false);

const canWrite = computed(() => Boolean(company.value?.can.write));

function snapshot() {
  return JSON.stringify({
    idleCustom: idleCustom.value,
    idle: idleForm.value,
    taskCustom: taskCustom.value,
    task: taskForm.value,
    reserve: reserve.value,
    radius: radius.value,
    graceMin: graceMin.value,
  });
}
const companyDirty = computed(() => Boolean(company.value) && snapshot() !== companySnap.value);
const dirty = computed(() => companyDirty.value || systemDirty.value);
const saveBarText = computed(() =>
  companyDirty.value && systemDirty.value
    ? "公司策略与系统默认未保存"
    : companyDirty.value
      ? "公司策略未保存"
      : "系统默认未保存"
);

/** 服务端读模型 → 表单（继承态用系统默认预填，切「单独设置」即可改），刷新快照清脏。 */
function fill(source: CompanyPolicy) {
  idleCustom.value = Boolean(source.idle);
  taskCustom.value = Boolean(source.task);
  idleForm.value = { ...policyDefaults(), ...(source.idle || {}) };
  taskForm.value = { ...policyDefaults(), ...(source.task || {}) };
  reserve.value = source.batteryReserve;
  radius.value = source.arriveRadiusM;
  graceMin.value =
    source.taskOfflineGraceSec == null ? null : Math.round(source.taskOfflineGraceSec / 60);
  companySnap.value = snapshot();
}

async function loadCompany(id: string) {
  if (!id) return;
  companyLoading.value = true;
  companyError.value = "";
  try {
    const loaded = await CompanyPolicyAPI.get(id, { silent: true });
    company.value = loaded;
    fill(loaded);
  } catch (e) {
    company.value = null;
    companyError.value =
      e instanceof Error ? e.message : "公司策略加载失败（需要「查看上报策略」权限）";
  } finally {
    companyLoading.value = false;
  }
}

async function onCompanyChange(id: string) {
  if (companyDirty.value) {
    try {
      await ElMessageBox.confirm("有未保存的公司策略修改，切换公司将丢失修改。", "未保存的修改", {
        confirmButtonText: "放弃修改切换",
        cancelButtonText: "留下保存",
        type: "warning",
      });
    } catch {
      // 留下：选择器回弹到当前公司
      const current = company.value?.orgId;
      orgId.value = "";
      await nextTick();
      orgId.value = current || companyOptions.value[0]?.value || "";
      return;
    }
  }
  await loadCompany(id);
}

/* 阈值「继承/覆盖」双向绑定：勾选继承＝null；取消继承用系统默认预填。 */
function inheritPair(value: Ref<number | null>, fallback: () => number) {
  return {
    inherit: computed({
      get: () => value.value == null,
      set: (v: boolean) => {
        value.value = v ? null : fallback();
      },
    }),
    value: computed({
      get: () => value.value ?? fallback(),
      set: (v: number) => {
        value.value = v;
      },
    }),
  };
}
const reservePair = inheritPair(reserve, () => company.value?.system.batteryReserve ?? 20);
const radiusPair = inheritPair(radius, () => company.value?.system.arriveRadiusM ?? 2000);
const gracePair = inheritPair(graceMin, () =>
  Math.round((company.value?.system.taskOfflineGraceSec ?? 3600) / 60)
);
const reserveInherit = reservePair.inherit;
const reserveValue = reservePair.value;
const radiusInherit = radiusPair.inherit;
const radiusValue = radiusPair.value;
const graceInherit = gracePair.inherit;
const graceValue = gracePair.value;

function pickPolicy(form: Policy): Policy {
  const { reportPeriodSec, reportOnlyWhenCharging, indicators, moduleLed, periodicGps } = form;
  return { reportPeriodSec, reportOnlyWhenCharging, indicators, moduleLed, periodicGps };
}

async function saveCompany() {
  if (!company.value || !canWrite.value) return;
  const data: CompanyPolicyInput = {
    idle: idleCustom.value ? pickPolicy(idleForm.value) : null,
    task: taskCustom.value ? pickPolicy(taskForm.value) : null,
    batteryReserve: reserve.value,
    arriveRadiusM: radius.value,
    // 分钟 → 秒（服务端校验 60–86400；null＝继承）
    taskOfflineGraceSec: graceMin.value == null ? null : Math.round(graceMin.value * 60),
  };
  const saved = await CompanyPolicyAPI.save(company.value.orgId, data);
  company.value = saved;
  fill(saved);
  ElMessage.success(`已保存，${saved.affectedBoxCount} 台箱子的策略已触发刷新`);
}

async function saveAll() {
  if (saving.value) return;
  saving.value = true;
  try {
    if (companyDirty.value) await saveCompany();
    if (systemDirty.value) await policyCard.value?.save();
  } finally {
    saving.value = false;
  }
}
function discard() {
  if (orgId.value) void loadCompany(orgId.value);
  void load();
}

/* ── 离开守卫（与原默认策略页同口径） ── */
function warnUnsaved(e: BeforeUnloadEvent) {
  if (dirty.value) {
    e.preventDefault();
    e.returnValue = "";
  }
}
onMounted(async () => {
  window.addEventListener("beforeunload", warnUnsaved);
  await Promise.all([load(), loadOptions()]);
  if (orgId.value) await loadCompany(orgId.value);
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
  display: flex;
  flex-direction: column;
  gap: 16px;
  width: 100%;
  max-width: 1280px;
  margin-inline: auto;
}
.group-gap {
  margin-top: 4px;
}
.group-title {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  align-items: baseline;
  margin-top: 8px;
  font-size: 15px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}
.group-hint {
  font-size: 12px;
  font-weight: 400;
  color: var(--el-text-color-secondary);
}
.picker-line {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: center;
}
.company-select {
  width: 260px;
}
.mode-line {
  margin-bottom: 14px;
}
.inherit-line {
  margin: 0;
  font-size: 13px;
  line-height: 1.8;
  color: var(--el-text-color-secondary);
}
.inherit-hint {
  margin-left: 10px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.unit {
  margin-left: 8px;
  color: var(--el-text-color-secondary);
}
.form-extra {
  font-size: 12px;
  line-height: 1.6;
  color: var(--el-text-color-secondary);
}
.readonly-list {
  padding-left: 18px;
  margin: 0;
  font-size: 13px;
  line-height: 1.9;
  color: var(--el-text-color-regular);
}
.readonly-list b {
  color: var(--el-text-color-primary);
}
.system-collapse {
  border-radius: var(--card-radius, 10px);
}
.system-title {
  margin-right: 8px;
  font-size: 15px;
  font-weight: 600;
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
