<template>
  <div class="page-container page-flow">
    <PageHeader :title="detail?.name || '划拨单详情'" back="/sample/transfers">
      <template v-if="detail" #tags>
        <el-tag type="primary" effect="plain">划拨</el-tag>
        <el-tag :type="transferTone(detail.status)">{{ detail.status }}</el-tag>
        <el-tag v-if="detail.legacy" type="info" effect="plain" class="hist-tag">历史</el-tag>
      </template>
      <template v-if="detail" #meta>
        {{ detail.id }} · {{ detail.boxCount }} 台 · {{ detail.createdBy || "—" }} 创建于
        {{ shortTime(detail.createdAt) }}
      </template>
    </PageHeader>

    <el-skeleton v-if="loading && !detail" :rows="8" animated class="block" />
    <el-empty v-else-if="!detail" :description="error || '没有这张划拨单'" />

    <template v-else>
      <!-- hero：状态＋操作区（按态×角色）＋三步条＋支链＋来源→目标＋快递单号三态＋facts -->
      <el-card shadow="never" class="block hero" :class="`tone-${headTone}`">
        <div class="hero-head">
          <div class="hero-status">
            <span class="pulse" :class="{ live: detail.status === '待接受' }" />
            <div>
              <div class="now">
                {{ detail.status === "已撤销" ? "已撤销（历史）" : detail.status }}
              </div>
              <div class="summary">{{ summaryText }}</div>
            </div>
          </div>
          <div class="ops">
            <template v-if="detail.status === '待接受'">
              <el-button
                v-if="detail.abilities.accept"
                type="primary"
                @click="openAction('accept')"
              >
                接受划拨（{{ detail.boxCount }} 台）
              </el-button>
              <el-button
                v-if="detail.abilities.reject"
                type="danger"
                plain
                @click="openAction('reject')"
              >
                拒收
              </el-button>
              <el-button
                v-if="detail.abilities.cancel"
                type="danger"
                plain
                @click="openAction('cancel')"
              >
                取消划拨
              </el-button>
              <el-button v-if="detail.abilities.tracking" @click="focusTracking">
                补填 / 修改快递单号
              </el-button>
              <span v-if="!detail.abilities.accept && !detail.abilities.cancel" class="waiting">
                等待目标方接受
              </span>
            </template>
            <el-button
              v-if="detail.abilities.retransfer && can(TRANSFER_CREATE)"
              type="primary"
              @click="openRecreate"
            >
              重新划拨
            </el-button>
            <span v-if="isEnded && !detail.abilities.retransfer" class="readonly-note">
              单据已结束 · 只读，无可用操作
            </span>
          </div>
        </div>

        <!-- 三步条：创建划拨 → 接受划拨 → 已完成；终态末补支链格 -->
        <ol class="track">
          <li class="is-done">
            <span class="dot">✓</span>
            <span class="tname">创建划拨</span>
            <span class="tmeta">
              {{ detail.createdBy || "—" }} · {{ shortTime(detail.createdAt) }}
            </span>
          </li>
          <li :class="acceptStepClass">
            <span class="dot">{{ acceptStepGlyph }}</span>
            <span class="tname">接受划拨</span>
            <span class="tmeta">{{ acceptStepMeta }}</span>
          </li>
          <li v-if="!terminalBranch" :class="doneStepClass">
            <span class="dot">{{ doneStepGlyph }}</span>
            <span class="tname">已完成</span>
            <span class="tmeta">
              {{
                detail.status === "已完成"
                  ? `归属已转移 · ${shortTime(detail.acceptedAt)}`
                  : "接受后自动达成"
              }}
            </span>
          </li>
          <li v-else :class="branchStepClass">
            <span class="dot">✕</span>
            <span class="tname">{{ detail.status }}</span>
            <span class="tmeta">{{ branchStepMeta }}</span>
          </li>
        </ol>
        <div class="branch">
          <span>接受前出口（支链）：</span>
          <span class="br cancel">
            <i />
            创建方取消 → 已取消（灰 · 箱不动单作废）
          </span>
          <span class="sep">｜</span>
          <span class="br reject">
            <i />
            接收方拒收 → 已拒收（红 · 原因必填 · 箱不动）
          </span>
          <span class="sep">｜</span>
          <span class="text-muted">接受后不可撤销，只能重新划拨</span>
        </div>

        <!-- 来源 → 目标 -->
        <div class="route">
          <div class="party">
            <span class="role from">来源公司</span>
            <b>{{ fromText }}</b>
            <span class="pst">
              {{ detail.boxCount }} 台 · 创建人 {{ detail.createdBy || "—" }} ·
              {{ shortTime(detail.createdAt) }} ·
              {{ detail.status === "已完成" ? "接受后归属已转出" : "接受前归属仍在此" }}
            </span>
          </div>
          <div class="arrow">
            →
            <small>{{ arrowText }}</small>
          </div>
          <div class="party">
            <span class="role to">目标公司</span>
            <b>{{ detail.toOrg.name || "—" }}</b>
            <span class="pst">{{ targetText }}</span>
          </div>
        </div>

        <!-- 快递单号③：创建方接受前可编辑 / 他人只读 / 接受后只读 -->
        <div class="courier" :class="{ edit: canEditTracking }">
          <span class="lab">快递单号</span>
          <template v-if="canEditTracking">
            <el-input
              ref="trackingInput"
              v-model="trackingDraft"
              size="small"
              maxlength="64"
              placeholder="选填，64 字以内"
              class="tracking-input mono"
              @keyup.enter="saveTracking"
            />
            <el-button size="small" type="primary" :loading="trackingSaving" @click="saveTracking">
              保存
            </el-button>
            <el-tag size="small" type="info" effect="plain">接受前可补填 / 修改</el-tag>
            <span class="hint">创建时选填；接受后只读展示</span>
          </template>
          <template v-else>
            <span class="val mono">{{ detail.trackingNo || "未填写" }}</span>
            <el-tag
              size="small"
              :type="detail.status === '待接受' ? 'info' : 'info'"
              effect="plain"
            >
              {{ detail.status === "待接受" ? "接受前创建方可补填 / 修改" : "只读" }}
            </el-tag>
            <span class="hint">{{ trackingHint }}</span>
          </template>
        </div>

        <dl class="facts">
          <div>
            <dt>创建人</dt>
            <dd>{{ detail.createdBy || "—" }}</dd>
          </div>
          <div>
            <dt>创建时间</dt>
            <dd>{{ fullTime(detail.createdAt) }}</dd>
          </div>
          <div v-if="detail.status === '已完成'">
            <dt>接受人</dt>
            <dd>{{ detail.acceptedBy || "—（历史无接受记录）" }}</dd>
          </div>
          <div v-if="detail.status === '已完成' && detail.acceptedAt">
            <dt>接受时间</dt>
            <dd>{{ fullTime(detail.acceptedAt) }}</dd>
          </div>
          <div v-if="detail.status === '已拒收'">
            <dt>拒收人 / 时间</dt>
            <dd>{{ detail.rejectedBy || "—" }} · {{ shortTime(detail.rejectedAt) }}</dd>
          </div>
          <div v-if="detail.status === '已拒收'" class="wide">
            <dt>拒收原因（必填）</dt>
            <dd class="reject-reason">{{ detail.rejectReason || "—" }}</dd>
          </div>
          <div v-if="detail.status === '已取消'">
            <dt>取消人 / 时间</dt>
            <dd>{{ detail.cancelledBy || "—" }} · {{ shortTime(detail.cancelledAt) }}</dd>
          </div>
          <div v-if="detail.status === '已取消' && detail.cancelNote">
            <dt>取消备注（选填）</dt>
            <dd>{{ detail.cancelNote }}</dd>
          </div>
          <div v-if="detail.status === '已撤销'">
            <dt>撤销人 / 时间</dt>
            <dd>{{ revokedBy }} · {{ shortTime(detail.revokedAt) }}</dd>
          </div>
          <div v-if="detail.status === '已撤销' && detail.revokeReason">
            <dt>撤销原因（历史）</dt>
            <dd>{{ detail.revokeReason }}</dd>
          </div>
          <div v-if="detail.note" class="wide">
            <dt>备注</dt>
            <dd>{{ detail.note }}</dd>
          </div>
        </dl>
      </el-card>

      <!-- 左：小地图＋箱清单；右：动态 feed -->
      <div class="two-col">
        <div class="col">
          <el-card shadow="never" class="block flush">
            <template #header>
              <div class="card-head">
                <span class="t">箱当前位置</span>
                <span class="s">小地图（kind 感知：无计划地点/采样安排）</span>
              </div>
            </template>
            <div class="box-chips">
              <el-check-tag :checked="!activeBox" class="bchip" @change="activeBox = ''">
                全部箱子
              </el-check-tag>
              <el-check-tag
                v-for="b in locatedBoxes"
                :key="b.boxId"
                :checked="activeBox === b.boxId"
                class="bchip"
                @change="activeBox = activeBox === b.boxId ? '' : b.boxId"
              >
                <i
                  :style="{
                    background:
                      b.gpsLng != null ? 'var(--el-color-primary)' : 'var(--el-color-warning)',
                  }"
                />
                {{ b.name }}
                <span v-if="b.batteryUsable != null" :class="{ low: b.batteryUsable < 20 }">
                  {{ b.batteryUsable }}%
                </span>
              </el-check-tag>
            </div>
            <div class="map-mock">
              <div class="map-road" />
              <div class="map-road2" />
              <div
                v-for="p in mapPins"
                :key="p.id"
                class="map-pin"
                :class="{ lbs: p.lbs, ghost: p.stale, active: activeBox === p.id }"
                :style="{ left: p.x + '%', top: p.y + '%' }"
                :title="p.title"
              >
                <span class="pin-head" />
                <span class="pin-pulse" />
              </div>
              <span v-if="!mapPins.length" class="map-empty">暂无定位上报</span>
              <span class="map-caption">地图示意 · 非真实底图 · 蓝=GPS 橙=基站 灰=过期</span>
            </div>
          </el-card>

          <el-card shadow="never" class="block flush">
            <template #header>
              <div class="card-head">
                <span class="t">箱清单（{{ detail.boxCount }} 台）</span>
                <span class="s">编号脱敏 前3后4 · 当前归属随接受转移</span>
              </div>
            </template>
            <el-table
              :data="detail.boxes"
              class="box-table"
              max-height="280"
              @row-click="(row: TransferBox) => (activeBox = row.boxId)"
            >
              <el-table-column label="采样箱 / 编号" min-width="180">
                <template #default="{ row }">
                  <b>{{ row.name }}</b>
                  <div class="text-muted mono">{{ row.code }}</div>
                </template>
              </el-table-column>
              <el-table-column label="当前归属" min-width="150">
                <template #default="{ row }">
                  <div>{{ row.org || "总公司" }}</div>
                  <div class="text-muted sub">
                    {{ detail.status === "已完成" ? "接受时转移" : "接受前未动" }}
                  </div>
                </template>
              </el-table-column>
              <el-table-column label="保管人" width="130">
                <template #default="{ row }">
                  <span v-if="row.owner">{{ row.owner }}</span>
                  <span v-else class="text-muted">
                    {{ detail.status === "已完成" ? "—（接受后清空）" : "—" }}
                  </span>
                </template>
              </el-table-column>
              <el-table-column label="电量" width="80">
                <template #default="{ row }">
                  <span
                    v-if="row.batteryUsable != null"
                    class="bat"
                    :class="row.batteryUsable < 20 ? 'low' : 'ok'"
                  >
                    {{ row.batteryUsable }}%
                  </span>
                  <span v-else class="text-muted">—</span>
                </template>
              </el-table-column>
              <el-table-column label="最近上报" min-width="120">
                <template #default="{ row }">
                  <TimeText :value="row.lastReportAt" mode="ago" />
                </template>
              </el-table-column>
            </el-table>
            <div class="table-foot text-muted">
              <span>共 {{ detail.boxCount }} 台 · 点行在地图定位</span>
              <span class="right">隐藏：开箱次数 / 用时（划拨无采样作业）</span>
            </div>
          </el-card>
        </div>

        <div class="col">
          <el-card shadow="never" class="block flush">
            <template #header>
              <div class="card-head">
                <span class="t">动态</span>
                <span class="s">提交 / 补单号 / 接受 / 取消 / 拒收 / 完成</span>
              </div>
            </template>
            <div class="feed-body">
              <div
                v-for="(log, index) in feedLogs"
                :key="index"
                class="ev"
                :class="feedTone(log.action)"
              >
                <span class="edot" />
                <div class="ebody">
                  <div class="eline">
                    <b>{{ log.action }}</b>
                    <span class="text-muted">{{ log.by || "—" }}</span>
                    <span class="etime">{{ shortTime(log.time) }}</span>
                  </div>
                  <div v-if="log.note" class="enote" :class="{ reject: log.action === '拒收划拨' }">
                    {{ log.note }}
                  </div>
                </div>
              </div>
              <div v-if="detail.status === '待接受'" class="ev warn">
                <span class="edot" />
                <div class="ebody wait">
                  等待 {{ detail.toOrg.name }} 管理员接受…（接受前创建方可取消 / 接收方可拒收）
                </div>
              </div>
            </div>
          </el-card>
        </div>
      </div>
    </template>

    <ActionDialog v-model="actionOpen" :mode="actionMode" :detail="detail" @done="load" />
    <CreateDialog v-model="createOpen" :prefill="prefill" @saved="onRecreated" />
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: "SampleTransferDetail" });

import TransferAPI, { type TransferBox, type TransferDetail } from "@/api/sample/transfer";
import PageHeader from "@/components/biz/PageHeader.vue";
import TimeText from "@/components/biz/TimeText.vue";
import { fullTime, shortTime } from "@/utils/time";
import { transferTone } from "@/utils/tone";
import { usePerm } from "@/composables/usePerm";
import { TRANSFER_CREATE } from "../data";
import ActionDialog from "./ActionDialog.vue";
import CreateDialog from "./CreateDialog.vue";

/**
 * R25（#71）划拨详情 kind 感知改版：三步条（创建→接受→已完成＋终态支链格）＋来源→目标卡＋快递单号三态
 * ＋箱清单（编号脱敏/当前归属随接受转移/保管人接受后清空/电量/最近上报）＋小地图（示意）＋动态 feed＋按态×角色操作区。
 * 隐藏采样单位/接收人员/计划地点/样品/开箱次数/用时（划拨无采样作业）。历史已划拨→已完成（接受人—不伪造）、已撤销只读。
 */
const route = useRoute();
const router = useRouter();
const can = usePerm();
const id = computed(() => String(route.params.id || ""));
const detail = ref<TransferDetail | null>(null);
const loading = ref(false);
const error = ref("");
const actionOpen = ref(false);
const actionMode = ref<"accept" | "reject" | "cancel" | "">("");
const createOpen = ref(false);
const prefill = ref<{ boxIds: string[]; names: Record<string, string>; fromName: string } | null>(
  null
);
const activeBox = ref("");
const trackingDraft = ref("");
const trackingSaving = ref(false);
const trackingInput = ref<{ focus: () => void } | null>(null);

const isEnded = computed(() =>
  ["已完成", "已取消", "已拒收", "已撤销", "已划拨"].includes(detail.value?.status || "")
);
const terminalBranch = computed(() =>
  ["已取消", "已拒收", "已撤销"].includes(detail.value?.status || "")
);
const canEditTracking = computed(
  () => detail.value?.status === "待接受" && detail.value?.abilities.tracking === true
);
const headTone = computed(() => {
  const s = detail.value?.status;
  if (s === "待接受") return "pending";
  if (s === "已完成" || s === "已划拨") return "done";
  if (s === "已拒收") return "error";
  return "void";
});
const fromText = computed(() => {
  const from = detail.value?.from || [];
  if (!from.length) return "—";
  return from.map((f) => `${f.orgName}（${f.count} 台）`).join("、");
});
const summaryText = computed(() => {
  const d = detail.value;
  if (!d) return "";
  const n = d.boxCount;
  switch (d.status) {
    case "待接受":
      return `${n} 台采样箱待 ${d.toOrg.name} 管理员接受确认；归属仍属 ${fromText.value}，接受时立即转移`;
    case "已完成":
      return `${n} 台采样箱归属已转移到 ${d.toOrg.name}${d.acceptedBy ? `（接受人 ${d.acceptedBy} · ${shortTime(d.acceptedAt)}）` : "（历史单·无接受记录）"}；接受后不可撤销`;
    case "已取消":
      return `创建方已取消，单据作废；${n} 台箱子归属未动，仍属 ${fromText.value}`;
    case "已拒收":
      return `接收方已拒收（原因：${d.rejectReason || "—"}）；${n} 台箱子归属未动，仍属 ${fromText.value}`;
    case "已撤销":
      return `历史两态单（旧「已划拨→已撤销」）；撤销端点已下线，本单只读保留可查`;
    default:
      return "";
  }
});
const arrowText = computed(() => {
  const s = detail.value?.status;
  if (s === "待接受") return "接受时归属转移";
  if (s === "已完成" || s === "已划拨") return "归属已转移";
  if (s === "已撤销") return "已退回原公司";
  return "箱未动";
});
const targetText = computed(() => {
  const d = detail.value;
  if (!d) return "";
  switch (d.status) {
    case "待接受":
      return `待接受 · 接受后归属立即转入`;
    case "已完成":
      return d.acceptedBy
        ? `接受管理员 ${d.acceptedBy} · 已接受 ${shortTime(d.acceptedAt)} · 保管人待指派`
        : `历史单 · 归属已转入（无接受记录）`;
    case "已取消":
      return `未接受 · 单据已作废`;
    case "已拒收":
      return `已拒收 ${shortTime(d.rejectedAt)} · 原因见下`;
    case "已撤销":
      return `历史单 · 撤销后箱已退回`;
    default:
      return "";
  }
});
const trackingHint = computed(() => {
  const s = detail.value?.status;
  if (s === "待接受") return "当前视角只读；接受后恒只读";
  if (s === "已完成" || s === "已划拨") return "接受后只读展示，不可修改";
  if (s === "已取消") return "单据已作废 · 记录只读保留";
  if (s === "已拒收") return "单据已拒收 · 记录只读保留";
  return "历史单只读";
});
const acceptStepClass = computed(() => {
  const s = detail.value?.status;
  if (s === "待接受") return "is-current";
  if (s === "已完成" || s === "已划拨") return "is-done";
  return "is-void";
});
const acceptStepGlyph = computed(() => {
  const s = detail.value?.status;
  if (s === "待接受") return "2";
  if (s === "已完成" || s === "已划拨") return "✓";
  return "—";
});
const acceptStepMeta = computed(() => {
  const d = detail.value;
  if (!d) return "";
  if (d.status === "待接受") return `待 ${d.toOrg.name} 管理员确认`;
  if (d.status === "已完成" || d.status === "已划拨")
    return d.acceptedBy ? `${d.acceptedBy} · ${shortTime(d.acceptedAt)}` : "历史单 · 无接受记录";
  return "未发生（接受前已出口）";
});
const doneStepClass = computed(() => (detail.value?.status === "已完成" ? "is-done" : ""));
const doneStepGlyph = computed(() => (detail.value?.status === "已完成" ? "✓" : "3"));
const branchStepClass = computed(() =>
  detail.value?.status === "已拒收" ? "is-error" : "is-void"
);
const branchStepMeta = computed(() => {
  const d = detail.value;
  if (!d) return "";
  if (d.status === "已取消") return `创建方 ${d.cancelledBy || "—"} · ${shortTime(d.cancelledAt)}`;
  if (d.status === "已拒收") return `接收方 ${d.rejectedBy || "—"} · ${shortTime(d.rejectedAt)}`;
  return `历史 · ${shortTime(d.revokedAt)}`;
});
const revokedBy = computed(() => {
  const log = detail.value?.logs.find((l) => l.action === "撤销划拨");
  return log?.by || "—";
});
/** 动态 feed：流转日志倒序（最近在上）；补单号 note 即单号。 */
const feedLogs = computed(() => [...(detail.value?.logs || [])].reverse());
function feedTone(action: string) {
  if (action === "接受划拨") return "ok";
  if (action === "拒收划拨") return "error";
  if (action === "取消划拨" || action === "撤销划拨") return "neutral";
  if (action === "补填快递单号") return "ok";
  return "";
}
/** 有定位的箱子（GPS 优先，否则基站）；小地图示意投影。 */
const locatedBoxes = computed(() =>
  (detail.value?.boxes || []).filter(
    (b) => (b.gpsLng != null && b.gpsLat != null) || (b.lbsLng != null && b.lbsLat != null)
  )
);
const mapPins = computed(() => {
  const list = locatedBoxes.value;
  if (!list.length) return [];
  const coords = list.map((b) => ({
    id: b.boxId,
    lng: (b.gpsLng ?? b.lbsLng) as number,
    lat: (b.gpsLat ?? b.lbsLat) as number,
    lbs: b.gpsLng == null,
    title: b.name,
    stale: !b.lastReportAt,
  }));
  const lngs = coords.map((c) => c.lng);
  const lats = coords.map((c) => c.lat);
  const minLng = Math.min(...lngs),
    maxLng = Math.max(...lngs);
  const minLat = Math.min(...lats),
    maxLat = Math.max(...lats);
  const spanLng = maxLng - minLng || 1;
  const spanLat = maxLat - minLat || 1;
  return coords.map((c) => ({
    ...c,
    x: 15 + ((c.lng - minLng) / spanLng) * 70,
    y: 70 - ((c.lat - minLat) / spanLat) * 50,
  }));
});

let seq = 0;
async function load() {
  if (!id.value) return;
  const mine = ++seq;
  loading.value = true;
  error.value = "";
  try {
    const next = await TransferAPI.detail(id.value);
    if (mine !== seq) return;
    detail.value = next;
    trackingDraft.value = next.trackingNo || "";
  } catch (e) {
    if (mine !== seq) return;
    detail.value = null;
    error.value = e instanceof Error ? e.message : "";
  } finally {
    if (mine === seq) loading.value = false;
  }
}
function openAction(mode: "accept" | "reject" | "cancel") {
  actionMode.value = mode;
  actionOpen.value = true;
}
function focusTracking() {
  trackingInput.value?.focus();
}
async function saveTracking() {
  if (!detail.value || trackingSaving.value) return;
  trackingSaving.value = true;
  try {
    await TransferAPI.tracking(detail.value.id, trackingDraft.value.trim());
    ElMessage.success(trackingDraft.value.trim() ? "快递单号已保存" : "快递单号已清空");
    await load();
  } catch (e) {
    ElMessage.error((e as Error).message || "保存失败");
  } finally {
    trackingSaving.value = false;
  }
}
/** 重新划拨：原单箱集预填向导（R24 沿用）。 */
function openRecreate() {
  const d = detail.value;
  if (!d) return;
  const boxIds = d.boxes.map((b) => b.boxId);
  if (!boxIds.length) {
    ElMessage.warning("这张划拨单没有箱子，无法重新划拨");
    return;
  }
  const names: Record<string, string> = {};
  for (const b of d.boxes) names[b.boxId] = b.name || b.code;
  prefill.value = { boxIds, names, fromName: d.name };
  createOpen.value = true;
}
function onRecreated() {
  createOpen.value = false;
  router.push("/sample/transfers");
}
watch(id, () => void load());
onMounted(() => void load());
onActivated(() => void load());
</script>

<style scoped>
.page-container {
  overflow: auto;
}
.page-container > * {
  flex-shrink: 0;
}
.block {
  margin-top: 12px;
}
.hist-tag {
  font-size: 10px;
}
.hero {
  --tone: var(--el-color-primary);
  --tone-soft: var(--el-color-primary-light-9);
  position: relative;
  overflow: hidden;
  border-radius: 10px;
}
.hero.tone-done {
  --tone: var(--el-color-success);
  --tone-soft: var(--el-color-success-light-9);
}
.hero.tone-error {
  --tone: var(--el-color-danger);
  --tone-soft: var(--el-color-danger-light-9);
}
.hero.tone-void {
  --tone: var(--el-color-info);
  --tone-soft: var(--el-color-info-light-9);
}
.hero::before {
  position: absolute;
  inset: 0 0 auto;
  height: 3px;
  content: "";
  background: var(--tone);
}
.hero-head {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: center;
  justify-content: space-between;
}
.hero-status {
  display: flex;
  gap: 12px;
  align-items: center;
}
.pulse {
  width: 12px;
  height: 12px;
  background: var(--tone);
  border-radius: 50%;
  box-shadow: 0 0 0 5px var(--tone-soft);
}
.now {
  font-size: 20px;
  font-weight: 600;
  color: var(--tone);
}
.summary {
  margin-top: 2px;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}
.ops {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}
.waiting {
  padding: 2px 8px;
  font-size: 12px;
  color: var(--el-color-warning);
  background: var(--el-color-warning-light-9);
  border-radius: 4px;
}
.readonly-note {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
/* 三步条 */
.track {
  display: flex;
  padding: 2px 0 0;
  margin: 14px 0 0;
  list-style: none;
}
.track li {
  position: relative;
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 2px;
  align-items: flex-start;
  min-width: 0;
}
.track li:last-child {
  flex: none;
  align-items: flex-end;
  text-align: right;
}
.track li:not(:last-child)::after {
  position: absolute;
  top: 10px;
  right: 6px;
  left: 28px;
  height: 2px;
  content: "";
  background: var(--el-border-color);
  border-radius: 1px;
}
.track li.is-done:not(:last-child)::after {
  background: var(--el-color-success);
}
.track .dot {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  font-size: 10px;
  font-weight: 700;
  color: var(--el-text-color-placeholder);
  background: var(--el-bg-color);
  border: 2px solid var(--el-border-color);
  border-radius: 50%;
}
.track .is-done .dot {
  color: #fff;
  background: var(--el-color-success);
  border-color: var(--el-color-success);
}
.track .is-current .dot {
  color: #fff;
  background: var(--el-color-primary);
  border-color: var(--el-color-primary);
  box-shadow: 0 0 0 4px var(--el-color-primary-light-9);
}
.track .is-void .dot {
  color: #fff;
  background: var(--el-color-info);
  border-color: var(--el-color-info);
}
.track .is-error .dot {
  color: #fff;
  background: var(--el-color-danger);
  border-color: var(--el-color-danger);
}
.track .tname {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.track .is-done .tname {
  color: var(--el-text-color-primary);
}
.track .is-current .tname {
  font-weight: 700;
  color: var(--el-color-primary);
}
.track .is-error .tname {
  font-weight: 700;
  color: var(--el-color-danger);
}
.track .tmeta {
  font-size: 11px;
  color: var(--el-text-color-secondary);
}
.branch {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  padding: 4px 10px;
  margin-top: 8px;
  font-size: 11px;
  color: var(--el-text-color-secondary);
  background: var(--el-fill-color-light);
  border: 1px dashed var(--el-border-color);
  border-radius: 6px;
}
.branch .br {
  display: inline-flex;
  gap: 4px;
  align-items: center;
}
.branch .br i {
  width: 7px;
  height: 7px;
  border-radius: 50%;
}
.branch .br.cancel i {
  background: var(--el-color-info);
}
.branch .br.reject i {
  background: var(--el-color-danger);
}
.branch .br.reject {
  color: var(--el-color-danger);
}
.branch .sep {
  color: var(--el-border-color);
}
/* 来源→目标 */
.route {
  display: flex;
  gap: 10px;
  align-items: stretch;
  padding-top: 12px;
  margin-top: 12px;
  border-top: 1px dashed var(--el-border-color-lighter);
}
.party {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  padding: 8px 12px;
  background: var(--el-fill-color-light);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
}
.party .role {
  align-self: flex-start;
  padding: 0 8px;
  font-size: 11px;
  line-height: 16px;
  border-radius: 9px;
}
.party .role.from {
  color: var(--el-color-success);
  background: var(--el-color-success-light-9);
}
.party .role.to {
  color: var(--el-color-primary);
  background: var(--el-color-primary-light-9);
}
.party b {
  font-size: 14px;
}
.party .pst {
  font-size: 11px;
  color: var(--el-text-color-secondary);
}
.arrow {
  display: flex;
  flex: none;
  flex-direction: column;
  gap: 2px;
  align-items: center;
  align-self: center;
  justify-content: center;
  font-size: 18px;
  color: var(--el-text-color-placeholder);
}
.arrow small {
  font-size: 10px;
  color: var(--el-text-color-secondary);
  white-space: nowrap;
}
/* 快递单号行 */
.courier {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  padding: 6px 12px;
  margin-top: 10px;
  font-size: 13px;
  background: var(--el-color-primary-light-9);
  border: 1px solid var(--el-color-primary-light-7);
  border-radius: 6px;
}
.courier .lab {
  font-weight: 600;
  color: var(--el-text-color-regular);
}
.courier .val {
  font-size: 13px;
}
.courier .hint {
  margin-left: auto;
  font-size: 11px;
  color: var(--el-text-color-secondary);
}
.tracking-input {
  width: 200px;
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.facts {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px 24px;
  padding-top: 12px;
  margin: 12px 0 0;
  border-top: 1px dashed var(--el-border-color-lighter);
}
.facts .wide {
  grid-column: span 2;
}
.facts dt {
  margin-bottom: 4px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.facts dd {
  margin: 0;
  font-size: 13px;
}
.facts dd.reject-reason {
  font-weight: 600;
  color: var(--el-color-danger);
}
/* 两栏 */
.two-col {
  display: grid;
  grid-template-columns: minmax(0, 1.62fr) minmax(0, 1fr);
  gap: 12px;
  align-items: start;
}
.col {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.flush :deep(.el-card__header) {
  padding: 8px 14px;
}
.flush :deep(.el-card__body) {
  padding: 0;
}
.card-head {
  display: flex;
  gap: 8px;
  align-items: baseline;
}
.card-head .t {
  font-size: 13px;
  font-weight: 700;
}
.card-head .s {
  font-size: 11px;
  color: var(--el-text-color-secondary);
}
/* 小地图（示意） */
.box-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 8px 14px 0;
}
.bchip {
  display: inline-flex;
  gap: 5px;
  align-items: center;
  cursor: pointer;
}
.bchip i {
  width: 7px;
  height: 7px;
  border-radius: 50%;
}
.bchip .low {
  font-weight: 600;
  color: var(--el-color-warning);
}
.map-mock {
  position: relative;
  height: 120px;
  margin: 8px 14px 12px;
  overflow: hidden;
  background:
    repeating-linear-gradient(0deg, transparent 0 19px, var(--el-border-color-lighter) 19px 20px),
    repeating-linear-gradient(90deg, transparent 0 19px, var(--el-border-color-lighter) 19px 20px),
    var(--el-fill-color-light);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
}
.map-road {
  position: absolute;
  top: 58%;
  right: -10%;
  left: -10%;
  height: 11px;
  background: var(--el-bg-color);
  border-top: 1px solid var(--el-border-color-lighter);
  border-bottom: 1px solid var(--el-border-color-lighter);
  transform: rotate(-5deg);
}
.map-road2 {
  position: absolute;
  top: -10%;
  bottom: -10%;
  left: 36%;
  width: 8px;
  background: var(--el-bg-color);
  border-right: 1px solid var(--el-border-color-lighter);
  border-left: 1px solid var(--el-border-color-lighter);
  transform: rotate(7deg);
}
.map-pin {
  position: absolute;
  display: flex;
  flex-direction: column;
  gap: 1px;
  align-items: center;
  transform: translate(-50%, -100%);
}
.map-pin .pin-head {
  width: 18px;
  height: 18px;
  background: var(--el-color-primary);
  border: 2px solid var(--el-bg-color);
  border-radius: 50% 50% 50% 0;
  box-shadow: 0 2px 5px rgb(0 0 0 / 25%);
  transform: rotate(-45deg);
}
.map-pin .pin-pulse {
  width: 24px;
  height: 6px;
  background: rgb(22 93 255 / 22%);
  border-radius: 50%;
}
.map-pin.lbs .pin-head {
  background: var(--el-color-warning);
}
.map-pin.ghost {
  opacity: 0.45;
}
.map-pin.ghost .pin-head {
  background: var(--el-color-info);
}
.map-pin.active .pin-head {
  box-shadow: 0 0 0 4px var(--el-color-primary-light-7);
}
.map-empty {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.map-caption {
  position: absolute;
  bottom: 5px;
  left: 6px;
  padding: 1px 7px;
  font-size: 10px;
  color: var(--el-text-color-secondary);
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 4px;
}
.box-table :deep(.el-table__row) {
  cursor: pointer;
}
.sub {
  font-size: 11px;
}
.bat {
  font-weight: 600;
}
.bat.ok {
  color: var(--el-color-success);
}
.bat.low {
  color: var(--el-color-warning);
}
.table-foot {
  display: flex;
  gap: 6px;
  align-items: center;
  padding: 6px 14px;
  font-size: 11px;
  border-top: 1px solid var(--el-border-color-lighter);
}
.table-foot .right {
  margin-left: auto;
}
/* 动态 feed */
.feed-body {
  display: flex;
  flex-direction: column;
  max-height: 420px;
  padding: 8px 14px;
  overflow: auto;
}
.ev {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  padding: 6px 0;
  font-size: 12px;
  border-bottom: 1px solid var(--el-border-color-lighter);
}
.ev:last-child {
  border-bottom: none;
}
.ev .edot {
  flex: none;
  width: 8px;
  height: 8px;
  margin-top: 4px;
  background: var(--el-color-primary);
  border-radius: 50%;
}
.ev.ok .edot {
  background: var(--el-color-success);
}
.ev.warn .edot {
  background: var(--el-color-warning);
}
.ev.error .edot {
  background: var(--el-color-danger);
}
.ev.neutral .edot {
  background: var(--el-color-info);
}
.ev .ebody {
  flex: 1;
  min-width: 0;
}
.ev .eline {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  align-items: baseline;
}
.ev .etime {
  font-size: 11px;
  color: var(--el-text-color-secondary);
}
.ev .enote {
  margin-top: 1px;
  font-size: 11px;
  color: var(--el-text-color-regular);
}
.ev .enote.reject {
  color: var(--el-color-danger);
}
.ev .wait {
  font-size: 11px;
  color: var(--el-color-warning);
}
</style>
