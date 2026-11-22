<template>
  <div ref="pageRoot" class="page-container page-flow policy-page">
    <PageHeader
      title="公司策略中心"
      subtitle="按公司设置箱子默认策略：非任务期间与任务期间双频，含指示灯、卫星定位与判定阈值。"
    >
      <template #tags>
        <el-tooltip
          effect="light"
          popper-class="policy-help-popper"
          placement="bottom"
          :content="PAGE_SUB_FULL"
        >
          <span class="policy-qmark" tabindex="0">?</span>
        </el-tooltip>
      </template>
      <template #actions>
        <span class="head-priority">
          优先级：任务内单箱 &gt; 长期单箱 &gt; 任务统一 &gt; 批量 &gt;
          <b>公司默认</b>
          &gt; 系统默认
          <br />
          公司层只兜底「没有更细设置」的箱子
        </span>
      </template>
    </PageHeader>
    <div class="policy-main">
      <!-- 公司选择行：选项＝自己范围内的顶级公司（deptOptions 按 scope 裁剪）；只有一家公司时固定不可换 -->
      <div v-if="companyOptions.length" class="company-row">
        <span class="company-lab">
          公司
          <el-tooltip
            effect="light"
            popper-class="policy-help-popper"
            placement="bottom"
            :content="companyTip"
          >
            <span class="policy-qmark" tabindex="0">?</span>
          </el-tooltip>
        </span>
        <el-select
          v-model="orgId"
          class="company-select"
          :disabled="companyOptions.length === 1"
          placeholder="选择公司"
          @change="onCompanyChange"
        >
          <el-option v-for="c in companyOptions" :key="c.value" :label="c.label" :value="c.value" />
        </el-select>
        <el-tag v-if="companyOptions.length === 1" type="info" size="small" effect="plain">
          固定
        </el-tag>
        <el-tag v-if="company" type="info" effect="plain">
          {{ company.boxCount }} 台箱子以本公司策略兜底
        </el-tag>
        <span v-if="company?.updatedAt" class="save-meta">
          最近保存：{{ company.updatedAt.slice(0, 19).replace("T", " ") }} ·
          {{ company.updatedBy || "—" }}
        </span>
      </div>

      <el-alert
        v-if="companyError"
        :title="companyError"
        type="warning"
        :closable="false"
        class="group-gap"
      />
      <el-alert
        v-else-if="company && readOnlyTip"
        :title="readOnlyTip"
        type="info"
        :closable="false"
        class="group-gap"
      />

      <!-- 1280 档：锚点回落顶部 seg（≥1360 隐藏，走左锚点 rail） -->
      <div v-if="company || canSystem" class="seg-nav">
        <span class="seg" role="tablist">
          <button
            v-for="s in navSections"
            :key="s.id"
            type="button"
            :class="{ active: activeSec === s.id }"
            @click="navTo(s.id)"
          >
            {{ s.name }}
            <span class="st">{{ s.chip }}</span>
          </button>
        </span>
      </div>

      <div v-if="company || canSystem" class="content-grid">
        <!-- 1440 档：左侧锚点导航（sticky＋scrollspy 高亮） -->
        <aside class="anchor-rail">
          <div class="rail-title">页内导航</div>
          <a
            v-for="s in navSections"
            :key="s.id"
            :href="'#' + s.id"
            :class="{ active: activeSec === s.id }"
            @click.prevent="navTo(s.id)"
          >
            <span class="ar-name">{{ s.name }}</span>
            <span class="ar-sub">
              {{ s.sub }} ·
              <el-tag v-if="s.chipTag" :type="s.chipTag" size="small" effect="plain">
                {{ s.chip }}
              </el-tag>
              <template v-else>{{ s.chip }}</template>
            </span>
          </a>
          <div class="rail-foot">
            <span>
              继承＝整层默认
              <el-tooltip
                effect="light"
                popper-class="policy-help-popper"
                placement="top"
                :content="GROUP_HINT"
              >
                <span class="policy-qmark" tabindex="0">?</span>
              </el-tooltip>
            </span>
          </div>
        </aside>

        <div class="sections">
          <template v-if="company">
            <!-- ① 非任务期间（idle）：完整策略（周期/定时模式/指示灯/卫星定位），继承＝整层 NULL -->
            <SectionCard
              id="sec-idle"
              v-loading="companyLoading"
              class="sec"
              sub="箱子没有单箱、批量或任务设置时生效"
            >
              <template #title>
                非任务期间（idle）
                <el-tag :type="idleCustom ? 'success' : 'info'" size="small" effect="plain">
                  {{ idleCustom ? "公司覆盖" : "继承系统默认" }}
                </el-tag>
                <el-tooltip
                  effect="light"
                  popper-class="policy-help-popper"
                  placement="top"
                  :content="IDLE_TIP"
                >
                  <span class="policy-qmark" tabindex="0">?</span>
                </el-tooltip>
              </template>
              <el-radio-group v-model="idleCustom" :disabled="!canWrite" class="mode-line">
                <el-radio :value="false">继承系统默认</el-radio>
                <el-radio :value="true">单独设置</el-radio>
              </el-radio-group>
              <p v-if="!idleCustom" class="inherit-line">
                当前系统默认：{{ formatDuration(company.system.reportPeriodSec) }}（{{
                  company.system.reportPeriodSec
                }}
                秒）·
                {{ company.system.reportOnlyWhenCharging ? "仅充电时定时上报" : "持续定时上报" }} ·
                指示灯日常亮 · 卫星定位随任务默认（有任务定位、空闲关）
              </p>
              <PolicyFields v-else v-model="idleForm" :disabled="!canWrite" grid />
            </SectionCard>

            <!-- ② 任务期间默认（task）：radio＋一句灰注；长 alert 全文收 ? 气泡 -->
            <SectionCard
              id="sec-task"
              v-loading="companyLoading"
              class="sec"
              sub="只影响新建任务单，进行中任务按建单快照执行"
            >
              <template #title>
                任务期间默认（task）
                <el-tag :type="taskCustom ? 'success' : 'info'" size="small" effect="plain">
                  {{ taskCustom ? "公司覆盖" : "继承系统默认" }}
                </el-tag>
                <el-tooltip
                  effect="light"
                  popper-class="policy-help-popper"
                  placement="top"
                  :content="TASK_TIP"
                >
                  <span class="policy-qmark" tabindex="0">?</span>
                </el-tooltip>
              </template>
              <el-radio-group v-model="taskCustom" :disabled="!canWrite" class="mode-line">
                <el-radio :value="false">继承系统默认</el-radio>
                <el-radio :value="true">单独设置</el-radio>
              </el-radio-group>
              <p v-if="!taskCustom" class="inherit-line">
                建单初始值用系统默认：{{ formatDuration(company.system.reportPeriodSec) }}（{{
                  company.system.reportPeriodSec
                }}
                秒）·
                {{ company.system.reportOnlyWhenCharging ? "仅充电时定时上报" : "持续定时上报" }}
              </p>
              <PolicyFields v-else v-model="taskForm" :disabled="!canWrite" task grid />
            </SectionCard>

            <!-- ③ 判定阈值（公司化）：四列表格三行；继承 switch 开＝值禁用虚线灰；无码整块锁定＋tooltip -->
            <SectionCard
              id="sec-judge"
              v-loading="companyLoading"
              class="sec sec-judge"
              flush
              sub="服务端生效、不下发设备；影响在线 / 低电 / 可调配与到达判定"
            >
              <template #title>
                判定阈值（公司化）
                <el-tag :type="judgeOverrideCount ? 'primary' : 'info'" size="small" effect="plain">
                  {{ judgeOverrideCount ? `${judgeOverrideCount} 项覆盖` : "全继承" }}
                </el-tag>
                <el-tooltip
                  effect="light"
                  popper-class="policy-help-popper"
                  placement="top"
                  :content="JUDGE_TIP"
                >
                  <span class="policy-qmark" tabindex="0">?</span>
                </el-tooltip>
              </template>
              <!-- R21（062）：阈值三列按 can.judge（policyCompanyJudge）单独 gating；无码整块锁定＋tooltip -->
              <el-tooltip
                content="需要「修改公司判定阈值」权限"
                placement="top"
                :disabled="canJudge"
              >
                <table class="jtable">
                  <colgroup>
                    <col style="width: 24%" />
                    <col style="width: 20%" />
                    <col style="width: 30%" />
                    <col style="width: 26%" />
                  </colgroup>
                  <thead>
                    <tr>
                      <th>项</th>
                      <th>继承系统默认</th>
                      <th>值</th>
                      <th>系统默认</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>
                        <span class="jname">
                          电量预留
                          <el-tooltip
                            effect="light"
                            popper-class="policy-help-popper"
                            placement="top"
                            :content="JUDGE_HELP.reserve"
                          >
                            <span class="policy-qmark" tabindex="0">?</span>
                          </el-tooltip>
                        </span>
                      </td>
                      <td>
                        <span class="jinherit">
                          <el-switch v-model="reserveInherit" :disabled="!canJudge" />
                          <span class="st">{{ reserveInherit ? "继承" : "覆盖" }}</span>
                        </span>
                      </td>
                      <td>
                        <span class="jval" :class="{ 'is-inherit': reserveInherit }">
                          <el-input-number
                            v-model="reserveValue"
                            :min="0"
                            :max="80"
                            controls-position="right"
                            :disabled="!canJudge || reserveInherit"
                          />
                          <span class="junit">%</span>
                        </span>
                      </td>
                      <td>
                        <span class="jdefault">
                          系统默认
                          <b>{{ company.system.batteryReserve }}%</b>
                        </span>
                      </td>
                    </tr>
                    <tr>
                      <td>
                        <span class="jname">
                          任务到达半径
                          <el-tooltip
                            effect="light"
                            popper-class="policy-help-popper"
                            placement="top"
                            :content="JUDGE_HELP.radius"
                          >
                            <span class="policy-qmark" tabindex="0">?</span>
                          </el-tooltip>
                        </span>
                      </td>
                      <td>
                        <span class="jinherit">
                          <el-switch v-model="radiusInherit" :disabled="!canJudge" />
                          <span class="st">{{ radiusInherit ? "继承" : "覆盖" }}</span>
                        </span>
                      </td>
                      <td>
                        <span class="jval" :class="{ 'is-inherit': radiusInherit }">
                          <el-input-number
                            v-model="radiusValue"
                            :min="100"
                            :max="50000"
                            :step="500"
                            controls-position="right"
                            :disabled="!canJudge || radiusInherit"
                          />
                          <span class="junit">米</span>
                        </span>
                      </td>
                      <td>
                        <span class="jdefault">
                          系统默认
                          <b>{{ company.system.arriveRadiusM }} 米</b>
                        </span>
                      </td>
                    </tr>
                    <tr>
                      <td>
                        <span class="jname">
                          建单后未上线宽限
                          <el-tooltip
                            effect="light"
                            popper-class="policy-help-popper"
                            placement="top"
                            :content="JUDGE_HELP.grace"
                          >
                            <span class="policy-qmark" tabindex="0">?</span>
                          </el-tooltip>
                        </span>
                      </td>
                      <td>
                        <span class="jinherit">
                          <el-switch v-model="graceInherit" :disabled="!canJudge" />
                          <span class="st">{{ graceInherit ? "继承" : "覆盖" }}</span>
                        </span>
                      </td>
                      <td>
                        <span class="jval" :class="{ 'is-inherit': graceInherit }">
                          <el-input-number
                            v-model="graceValue"
                            :min="1"
                            :max="1440"
                            :step="5"
                            controls-position="right"
                            :disabled="!canJudge || graceInherit"
                          />
                          <span class="junit">分钟</span>
                        </span>
                      </td>
                      <td>
                        <span class="jdefault">
                          系统默认
                          <b>{{ Math.round(company.system.taskOfflineGraceSec / 60) }} 分钟</b>
                        </span>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </el-tooltip>
              <div class="jfoot">
                箱子在检测站期间，策略与判定阈值按寄出分公司生效（建单快照）；划拨/分配改挂后自动切换到新公司。
              </div>
            </SectionCard>

            <!-- ④ 只读说明：默认折叠面板（计数 4，展开 2×2 四条全文；PM 裁决深睡/在线低功耗只放说明） -->
            <el-collapse id="sec-readonly" v-model="readonlyOpen" class="ro-collapse sec">
              <el-collapse-item name="readonly">
                <template #title>
                  <span class="ro-title">只读说明（自动行为与不支持项）</span>
                  <el-tag type="info" size="small" effect="plain">4</el-tag>
                  <span class="ro-sub">深睡 / 在线低功耗只放说明，固件不支持项不做控件</span>
                </template>
                <div class="ro-grid">
                  <div class="ro-item">
                    <b>休眠与低功耗（自动行为，无开关）</b>
                    STM 空闲自动休眠、插电不休眠；DTU 深度休眠由 STM 按条件提议（周期≥600
                    秒、电池供电、无任务、开箱 2 小时窗口外等），台架 IMEI
                    白名单默认空、生产未启用；DTU 在线低功耗同为白名单制（需 DTU 固件 V2.0.9
                    及以上），生产未启用。
                  </div>
                  <div class="ro-item">
                    <b>固定策略</b>
                    搜星每轮≤60 秒、连续失败后降频；开箱后 2 小时在线窗口；电量曲线自动学习上报。
                  </div>
                  <div class="ro-item">
                    <b>固件不支持（不做控件）</b>
                    蜂鸣器、LED
                    闪烁模式自定义（节拍固件写死）、采样间隔、设备侧电量阈值/开箱告警开关、远程重启指令。低电量/可调配判定在服务端（上方「判定阈值」），无需下发。
                  </div>
                  <div class="ro-item">
                    <b>单箱操作引导</b>
                    远程抹除、读设备本机日志在采样箱详情页逐台操作（各自授权），不放公司级；事件（开关箱/上电/插拔充电器）恒立即上报，不可关闭。
                  </div>
                </div>
              </el-collapse-item>
            </el-collapse>
          </template>

          <!-- ⑤ ADMIN 系统默认（全局兜底）：独立锚点置只读说明后；沿用 BoxPolicySettings 字段级四码 gating -->
          <div v-if="canSystem" id="sec-system" class="sec-system">
            <el-collapse v-model="systemOpen" class="system-collapse">
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

          <!-- 保存条：sticky 吸底、与卡同宽、右对齐；脏态差集计数「N 处更改」 -->
          <div v-if="dirty" class="save-bar">
            <span class="dot" />
            <span class="save-bar-text">{{ saveBarText }}</span>
            <span v-if="companyDiffParts.length" class="sb-count">
              {{ companyDiffParts.length }} 处更改
            </span>
            <span v-if="saveBarDetail" class="sb-detail">{{ saveBarDetail }}</span>
            <span class="sb-ops">
              <el-button text @click="discard">放弃更改</el-button>
              <el-button type="primary" :loading="saving" @click="saveAll">保存</el-button>
            </span>
          </div>
        </div>
      </div>
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
import { formatDuration } from "@/utils/duration";

/**
 * 采样箱 › 默认策略 → 公司策略中心（R13，任务 #46；#90 企业级改版呈现层）。
 * 菜单对 policyCompany/policyCompanyJudge/policyDefault/battery-reserve/arrive-radius/station
 * 六码 some 可见（server/menus.js，R21/062 扩两新码）。
 * 公司层：idle/task 两份完整策略（继承＝整层 NULL）＋判定阈值三列（null＝继承）；
 * 写闸门 device:box:policyCompany＋manageOrgIds（服务端 can.write 权威），无码只读；
 * 阈值三列 R21（062）起按 can.judge（policyCompanyJudge）单独 gating，无码锁定＋tooltip。
 * ADMIN 折叠区沿用 BoxPolicySettings（系统默认全局兜底，字段级四码 gating，station 已拆出）。
 * 脏标记/保存条/放弃/离开守卫复用原默认策略页口径：放弃＝重新 load，离开前确认，关页前 beforeunload。
 * #90 呈现：1440 左锚点 rail／1280 顶部 seg＋scrollspy；长 helper 收 ? 气泡（light 限宽 360 单点常量）；
 * 阈值四列表格（checkbox→switch 视觉等价）；只读说明默认折叠；保存条吸底右对齐＋快照差集计数。
 * 语义零改动：字段/选项/范围/继承整层 NULL/task 快照/双闸/下发/审计沿 R13/R21。
 */
defineOptions({ name: "SampleBoxPolicy" });

/* ── ? 气泡全文常量（原 helper/副标题/alert 原文，一字不改） ── */
const PAGE_SUB_FULL =
  "按公司设置箱子的默认策略：非任务期间与任务期间两份完整策略（双频），含指示灯、卫星定位与公司化判定阈值。只影响没有单箱、批量或任务设置的箱子；开关箱、上电、插拔充电器仍然马上上报。";
const GROUP_HINT = "每份是完整策略（含指示灯与卫星定位），不逐字段拼接；「继承」＝整层用系统默认。";
const IDLE_TIP = `${GROUP_HINT}箱子没有单箱、批量或任务设置时生效。`;
const TASK_TIP =
  "任务期间默认策略只影响新建任务单（作为「本任务统一」初始值/兜底）；进行中任务按建单快照执行，公司级后续修改不波及。长期单箱策略仍优先于它。" +
  GROUP_HINT;
const JUDGE_TIP =
  "服务端生效、不下发设备；勾选「继承」＝用系统默认。影响在线/低电/可调配与任务到达判定。";
/** 阈值逐项链 ? 全文：沿系统默认区 HELP/form-extra 原文＋范围步进。 */
const JUDGE_HELP = {
  reserve: "从总电量底部扣掉，不计入可用电量。范围 0–80%。",
  radius:
    "箱子离寄出、收货地址或计划地点在这个范围内算到达；基站定位误差常有一两公里。范围 100–50000 米，步进 500。",
  grace:
    "（1–1440，默认 60）。被任务占用、从未上报的箱子，建单后这段时间内算中性「待上线」，不计离线；超过才计离线。一旦上报过回落「超过 3 个上报周期」口径。步进 5 分钟。",
} as const;
const COMPANY_SUB = "策略按顶级公司（分公司/总部）生效；箱子挂科室/班组时向上归到本公司";

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
  station: false,
  ...(settings.value?.can || {}),
}));
const canSystem = computed(() =>
  Boolean(can.value.box || can.value.batteryReserve || can.value.arriveRadius || can.value.station)
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
const companyTip = computed(() =>
  companyOptions.value.length === 1
    ? `${COMPANY_SUB}。当前账号数据范围内仅一家顶级公司，选择器固定不可换；只能改本公司（数据范围闸门）。`
    : COMPANY_SUB
);

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
/** 判定阈值三列：null＝继承系统默认（开关「继承」）；UI 宽限以分钟展示。 */
const reserve = ref<number | null>(null);
const radius = ref<number | null>(null);
const graceMin = ref<number | null>(null);
const companySnap = ref("");
/** 快照对象（fill 时落）：脏态差集计数用；companySnap 字符串比对仍为 companyDirty 权威。 */
const snapObj = ref<{
  idleCustom: boolean;
  idle: Policy;
  taskCustom: boolean;
  task: Policy;
  reserve: number | null;
  radius: number | null;
  graceMin: number | null;
} | null>(null);
const saving = ref(false);
const readonlyOpen = ref<string[]>([]);

const canWrite = computed(() => Boolean(company.value?.can.write));
/**
 * R21（062）：阈值三列单独可写＝服务端 can.judge（policyCompanyJudge 码＋manageOrgIds 闸门）。
 * 老服务端无 judge 键时回落 can.write（旧口径：company 码管全部），部署同批后恒有键。
 */
const canJudge = computed(() => Boolean(company.value?.can.judge ?? company.value?.can.write));
/** 只读/半只读提示：两码都无＝全只读；仅阈值码＝上报策略只读（阈值分组可改）。 */
const readOnlyTip = computed(() => {
  if (!company.value) return "";
  if (!canWrite.value && !canJudge.value)
    return "当前账号可查看本公司策略；修改上报策略需要「修改公司默认策略」权限，修改判定阈值需要「修改公司判定阈值」权限，且只能改本公司（数据范围闸门）。";
  if (!canWrite.value)
    return "当前账号可修改本公司判定阈值；修改上报策略需要「修改公司默认策略」权限（只能改本公司，数据范围闸门）。";
  return "";
});

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

/* ── 脏态差集计数（#90）：模式切换＋custom 层逐字段＋阈值三列，随改随减 ── */
const POLICY_FIELD_LABELS: [keyof Policy, string][] = [
  ["reportPeriodSec", "上报周期"],
  ["reportOnlyWhenCharging", "定时上报"],
  ["periodicGps", "卫星定位"],
  ["indicators", "STM 指示灯"],
  ["moduleLed", "4G 模块指示灯"],
];
function layerParts(
  custom: boolean,
  form: Policy,
  snapCustom: boolean,
  snapForm: Policy,
  tag: string
): string[] {
  const parts: string[] = [];
  if (custom !== snapCustom) parts.push(custom ? `${tag} 单独设置` : `${tag} 回继承`);
  if (custom)
    for (const [key, label] of POLICY_FIELD_LABELS)
      if ((form[key] ?? null) !== (snapForm[key] ?? null)) parts.push(`${tag} ${label}`);
  return parts;
}
const companyDiffParts = computed(() => {
  const snap = snapObj.value;
  if (!company.value || !snap) return [];
  const parts = [
    ...layerParts(idleCustom.value, idleForm.value, snap.idleCustom, snap.idle, "idle"),
    ...layerParts(taskCustom.value, taskForm.value, snap.taskCustom, snap.task, "task"),
  ];
  if (reserve.value !== snap.reserve)
    parts.push(reserve.value == null ? "电量预留回继承" : "电量预留覆盖");
  if (radius.value !== snap.radius)
    parts.push(radius.value == null ? "到达半径回继承" : "到达半径覆盖");
  if (graceMin.value !== snap.graceMin)
    parts.push(graceMin.value == null ? "宽限回继承" : "宽限覆盖");
  return parts;
});
const saveBarDetail = computed(() => {
  const parts = [...companyDiffParts.value];
  if (systemDirty.value) parts.push("系统默认未保存");
  return parts.join(" · ");
});
const judgeOverrideCount = computed(
  () => [reserve.value, radius.value, graceMin.value].filter((v) => v != null).length
);

/* ── 页内锚点导航（rail/seg 共用）＋scrollspy ── */
type NavChipTag = "primary" | "success" | "warning" | "info" | "danger";
const navSections = computed(() => {
  const list: { id: string; name: string; sub: string; chip: string; chipTag?: NavChipTag }[] = [];
  if (company.value) {
    list.push(
      {
        id: "sec-idle",
        name: "非任务期间",
        sub: "idle",
        chip: idleCustom.value ? "公司覆盖" : "继承默认",
        chipTag: idleCustom.value ? "success" : "info",
      },
      {
        id: "sec-task",
        name: "任务期间",
        sub: "task",
        chip: taskCustom.value ? "公司覆盖" : "继承默认",
        chipTag: taskCustom.value ? "success" : "info",
      },
      {
        id: "sec-judge",
        name: "判定阈值",
        sub: "公司化",
        chip: judgeOverrideCount.value ? `${judgeOverrideCount.value} 项覆盖` : "全继承",
        chipTag: judgeOverrideCount.value ? "primary" : "info",
      },
      { id: "sec-readonly", name: "只读说明", sub: "自动行为", chip: "4 条" }
    );
  }
  if (canSystem.value)
    list.push({
      id: "sec-system",
      name: "系统默认",
      sub: "全局兜底",
      chip: "仅系统授权",
      chipTag: "warning",
    });
  return list;
});
const pageRoot = ref<HTMLElement | null>(null);
const activeSec = ref("sec-idle");
let scrollEl: HTMLElement | null = null;
/** 点击锚点后暂持高亮，直到用户真实滚动意图（wheel/touch/键盘）再交还 scrollspy——
 *  页尾区被 clamp 到不了顶时避免 spy 反覆盖点击目标。 */
let spyHold = false;
function releaseSpy() {
  spyHold = false;
}
function navTo(id: string) {
  activeSec.value = id;
  spyHold = true;
  document.getElementById(id)?.scrollIntoView({ block: "start", behavior: "smooth" });
}
/** scrollspy：以滚动容器顶为基准，取最后一个顶边进入视口上沿的区；真实滚到底才锁定末区。
 *  滚动容器＝.page-container 自身（page.scss overflow-y:auto＋height:100%），不是 .layout-content。 */
function onScroll() {
  if (spyHold || !scrollEl || !scrollEl.isConnected) return;
  const sections = navSections.value;
  if (!sections.length) return;
  const base = scrollEl.getBoundingClientRect().top;
  let current = sections[0].id;
  for (const s of sections) {
    const el = document.getElementById(s.id);
    if (el && el.isConnected && el.getBoundingClientRect().top - base <= 96) current = s.id;
  }
  if (
    scrollEl.scrollTop > 0 &&
    scrollEl.scrollTop + scrollEl.clientHeight >= scrollEl.scrollHeight - 4
  )
    current = sections[sections.length - 1].id;
  activeSec.value = current;
}

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
  snapObj.value = {
    idleCustom: idleCustom.value,
    idle: { ...idleForm.value },
    taskCustom: taskCustom.value,
    task: { ...taskForm.value },
    reserve: reserve.value,
    radius: radius.value,
    graceMin: graceMin.value,
  };
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

/* 阈值「继承/覆盖」双向绑定：开关继承＝null；取消继承用系统默认预填。 */
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
  if (!company.value || (!canWrite.value && !canJudge.value)) return;
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
  scrollEl = pageRoot.value;
  scrollEl?.addEventListener("scroll", onScroll, { passive: true });
  scrollEl?.addEventListener("wheel", releaseSpy, { passive: true });
  scrollEl?.addEventListener("touchmove", releaseSpy, { passive: true });
  scrollEl?.addEventListener("keydown", releaseSpy);
  await Promise.all([load(), loadOptions()]);
  if (orgId.value) await loadCompany(orgId.value);
  await nextTick();
  onScroll();
});
onBeforeUnmount(() => {
  window.removeEventListener("beforeunload", warnUnsaved);
  scrollEl?.removeEventListener("scroll", onScroll);
  scrollEl?.removeEventListener("wheel", releaseSpy);
  scrollEl?.removeEventListener("touchmove", releaseSpy);
  scrollEl?.removeEventListener("keydown", releaseSpy);
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

<style lang="scss">
/* ? 气泡限宽单点常量（#90）：grid/区头气泡只在公司策略页出现；popper 挂 body 故非 scoped */
.policy-help-popper {
  max-width: 360px;
  line-height: 1.6;
}
.policy-qmark {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  font-size: 11px;
  vertical-align: 1px;
  color: var(--el-text-color-secondary);
  cursor: help;
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color);
  border-radius: 50%;
}
.policy-qmark:hover,
.policy-qmark:focus-visible {
  color: var(--el-color-primary);
  border-color: var(--el-color-primary);
}
</style>

<style lang="scss" scoped>
/* 超宽屏内容约束：沿系统设置 settings-main 口径，内容封顶 1280 居中 */
.policy-main {
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: 100%;
  max-width: 1280px;
  margin-inline: auto;
}
.group-gap {
  margin-top: 4px;
}
.group-hint {
  font-size: 12px;
  font-weight: 400;
  color: var(--el-text-color-secondary);
}
.head-priority {
  font-size: 11px;
  line-height: 1.5;
  color: var(--el-text-color-placeholder);
  text-align: right;
}
.head-priority b {
  font-weight: 600;
  color: var(--el-text-color-secondary);
}
/* 公司选择行：白卡单行（受限视角灰显＋固定 tag＋范围气泡） */
.company-row {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
  padding: 7px 14px;
  background: var(--content-bg);
  border: 1px solid var(--card-border);
  border-radius: var(--card-radius);
}
.company-lab {
  display: inline-flex;
  gap: 5px;
  align-items: center;
  font-size: 13px;
  font-weight: 700;
  color: var(--el-text-color-regular);
}
.company-select {
  width: 220px;
}
.save-meta {
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--el-text-color-placeholder);
}
/* 内容栅格：≥1360 左锚点 rail；<1360 顶部 seg 单列 */
.content-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 10px;
  align-items: start;
}
.sections {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}
.sections > * {
  scroll-margin-top: 52px;
}
.seg-nav {
  position: sticky;
  top: 0;
  z-index: 30;
  display: flex;
  gap: 2px;
  align-items: center;
  padding: 2px 0;
  background: var(--page-bg);
}
.seg {
  display: inline-flex;
  gap: 2px;
  padding: 2px;
  background: var(--el-fill-color-light);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 6px;
}
.seg button {
  display: inline-flex;
  gap: 5px;
  align-items: center;
  height: 26px;
  padding: 0 12px;
  font-size: 12px;
  color: var(--el-text-color-regular);
  white-space: nowrap;
  cursor: pointer;
  background: none;
  border: none;
  border-radius: 4px;
}
.seg button.active {
  font-weight: 700;
  color: var(--el-color-primary);
  background: var(--el-bg-color);
  box-shadow: 0 1px 2px rgb(0 0 0 / 10%);
}
.seg .st {
  font-size: 10px;
  font-weight: 400;
  color: var(--el-text-color-placeholder);
}
.seg button.active .st {
  color: var(--el-color-primary);
}
.anchor-rail {
  display: none;
}
.rail-title {
  padding: 2px 10px 4px;
  font-size: 11px;
  color: var(--el-text-color-placeholder);
  letter-spacing: 0.05em;
}
.anchor-rail a {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 6px 10px;
  text-decoration: none;
  border-left: 2px solid transparent;
  border-radius: 6px;
}
.anchor-rail a:hover {
  background: var(--el-fill-color-light);
}
.anchor-rail a.active {
  background: var(--el-color-primary-light-9);
  border-left-color: var(--el-color-primary);
}
.ar-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--el-text-color-regular);
}
.anchor-rail a.active .ar-name {
  color: var(--el-color-primary);
}
.ar-sub {
  display: flex;
  gap: 4px;
  align-items: center;
  font-size: 11px;
  color: var(--el-text-color-placeholder);
}
.rail-foot {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 6px 10px;
  margin-top: 6px;
  font-size: 11px;
  line-height: 1.6;
  color: var(--el-text-color-placeholder);
  border-top: 1px dashed var(--el-border-color);
}
.rail-foot span {
  display: inline-flex;
  gap: 4px;
  align-items: center;
}
@media (min-width: 1360px) {
  .content-grid {
    grid-template-columns: 148px minmax(0, 1fr);
  }
  .seg-nav {
    display: none;
  }
  .anchor-rail {
    position: sticky;
    top: 12px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .sections > * {
    scroll-margin-top: 12px;
  }
}
/* 双频模式 radio＋继承灰注 */
.mode-line {
  margin-bottom: 8px;
}
.inherit-line {
  margin: 0;
  font-size: 13px;
  line-height: 1.8;
  color: var(--el-text-color-secondary);
}
/* 判定阈值：四列表格三行（项｜继承 switch｜值｜系统默认灰字） */
.jtable {
  width: 100%;
  font-size: 13px;
  table-layout: fixed;
  border-collapse: collapse;
}
.jtable th {
  height: 26px;
  padding: 0 12px;
  font-size: 11px;
  font-weight: 600;
  color: var(--el-text-color-secondary);
  text-align: left;
  white-space: nowrap;
  background: var(--el-fill-color-light);
  border-bottom: 1px solid var(--el-border-color-lighter);
}
.jtable td {
  height: 36px;
  padding: 2px 12px;
  vertical-align: middle;
  border-bottom: 1px solid var(--el-border-color-extra-light);
}
.jtable tr:last-child td {
  border-bottom: none;
}
.jname {
  display: inline-flex;
  gap: 5px;
  align-items: center;
  font-size: 13px;
  color: var(--el-text-color-primary);
}
.jinherit {
  display: inline-flex;
  gap: 6px;
  align-items: center;
}
.jinherit .st {
  font-size: 11px;
  color: var(--el-text-color-secondary);
}
.jval {
  display: inline-flex;
  gap: 6px;
  align-items: center;
}
.jval :deep(.el-input-number) {
  width: 150px;
}
/* 继承开＝值禁用虚线灰（语义仍 null＝继承） */
.jval.is-inherit :deep(.el-input-number .el-input__wrapper) {
  background: var(--el-fill-color-light);
  border: 1px dashed var(--el-border-color);
  box-shadow: none;
}
.jval.is-inherit :deep(.el-input__inner) {
  color: var(--el-text-color-placeholder);
}
.junit {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.jdefault {
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: var(--el-text-color-placeholder);
}
.jdefault b {
  font-weight: 600;
  color: var(--el-text-color-secondary);
}
.jfoot {
  padding: 6px 16px 10px;
  font-size: 11px;
  line-height: 1.6;
  color: var(--el-text-color-secondary);
}
/* 只读说明：默认折叠面板（计数 4），展开 2×2 四条全文 */
.ro-collapse {
  background: var(--content-bg);
  border: 1px solid var(--card-border);
  border-radius: var(--card-radius);
}
.ro-collapse :deep(.el-collapse-item__header) {
  height: 44px;
  padding: 0 16px;
  background: transparent;
  border-bottom: none;
}
.ro-collapse :deep(.el-collapse-item__wrap) {
  background: transparent;
  border-bottom: none;
}
.ro-collapse :deep(.el-collapse-item__content) {
  padding: 0 16px 12px;
}
.ro-title {
  font-size: 13px;
  font-weight: 700;
  color: var(--el-text-color-primary);
}
.ro-collapse :deep(.el-tag) {
  margin: 0 6px;
}
.ro-sub {
  font-size: 11px;
  font-weight: 400;
  color: var(--el-text-color-secondary);
}
.ro-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
.ro-item {
  padding: 8px 10px;
  font-size: 12px;
  line-height: 1.65;
  color: var(--el-text-color-regular);
  background: var(--el-fill-color-light);
  border: 1px solid var(--el-border-color-extra-light);
  border-radius: 8px;
}
.ro-item b {
  display: block;
  margin-bottom: 2px;
  font-size: 12px;
  color: var(--el-text-color-primary);
}
@media (max-width: 900px) {
  .ro-grid {
    grid-template-columns: 1fr;
  }
}
/* ADMIN 系统默认折叠区（独立锚点） */
.system-collapse {
  border-radius: var(--card-radius, 10px);
}
.system-title {
  margin-right: 8px;
  font-size: 15px;
  font-weight: 600;
}
/* 脏状态 sticky 吸底保存条：与卡同宽、右对齐（不再居中浮底） */
.save-bar {
  position: sticky;
  bottom: 0;
  z-index: 20;
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
  padding: 8px 14px;
  background: var(--content-bg);
  border: 1px solid var(--card-border);
  border-radius: var(--card-radius);
  box-shadow: 0 -2px 10px rgb(29 33 41 / 6%);
}
.save-bar .dot {
  flex-shrink: 0;
  width: 8px;
  height: 8px;
  background: var(--el-color-warning);
  border-radius: 50%;
}
.save-bar-text {
  font-size: 13px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}
.sb-count {
  padding: 0 7px;
  font-size: 11px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  line-height: 17px;
  color: var(--el-color-warning);
  background: var(--el-color-warning-light-9);
  border-radius: 9px;
}
.sb-detail {
  font-size: 11px;
  color: var(--el-text-color-placeholder);
}
.sb-ops {
  display: flex;
  gap: 8px;
  margin-left: auto;
}
</style>
