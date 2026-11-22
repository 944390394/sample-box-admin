<template>
  <div class="page-container uplink-records">
    <el-card shadow="never" class="records-card" @pointerdown.capture="bumpInteract">
      <template v-if="serverMode">
        <!-- 概览条：当前筛选范围一次聚合（总数/定时占比/事件次数/电压区间/最近上报） -->
        <div v-loading="summaryLoading" class="overview">
          <div class="stat">
            <span class="stat__label">上报总数</span>
            <b class="stat__value">{{ summary ? summary.total : "—" }}</b>
          </div>
          <div class="stat">
            <span class="stat__label">定时占比</span>
            <b class="stat__value">{{ timerRatio }}</b>
          </div>
          <div class="stat">
            <span class="stat__label">开箱</span>
            <b class="stat__value" :class="{ warn: kindCount('pad') > 0 }">
              {{ summary ? kindCount("pad") : "—" }}
            </b>
          </div>
          <div class="stat">
            <span class="stat__label">关箱</span>
            <b class="stat__value">{{ summary ? kindCount("shut") : "—" }}</b>
          </div>
          <div class="stat">
            <span class="stat__label">上电</span>
            <b class="stat__value">{{ summary ? kindCount("boot") : "—" }}</b>
          </div>
          <div class="stat">
            <span class="stat__label">充电</span>
            <b class="stat__value">{{ summary ? kindCount("chg") : "—" }}</b>
          </div>
          <div class="stat">
            <span class="stat__label">电压</span>
            <b class="stat__value">{{ voltRange }}</b>
          </div>
          <div class="stat">
            <span class="stat__label">最近上报</span>
            <b class="stat__value"><TimeText :value="summary?.latest" /></b>
          </div>
          <!-- 实时刷新：不打断时的新上报 badge（点击回第 1 页刷新）＋最近一次静默更新时间 -->
          <span class="overview__live">
            <button
              v-if="newCount > 0"
              type="button"
              class="live-badge"
              title="回到第 1 页并刷新"
              @click="search"
            >
              {{ newCount }} 条新上报
            </button>
            <span v-if="lastLiveAt" class="live-chip">已更新 · {{ lastLiveAt }}</span>
          </span>
          <span class="overview__note">
            {{ rangeNote }}
            <template v-if="summaryError">
              · 概览统计不可用（服务端版本较旧），列表与翻页不受影响
            </template>
          </span>
        </div>

        <!-- 筛选：类型 chips＋采样箱＋时间快捷＋仅看异常；变更 300ms  debounce 即时查询 -->
        <div class="filters">
          <div class="chips" role="group" aria-label="上报类型">
            <button
              v-for="chip in kindChips"
              :key="chip.value"
              type="button"
              class="chip"
              :class="{ active: kind === chip.value }"
              :aria-pressed="kind === chip.value"
              @click="kind = chip.value"
            >
              {{ chip.label }}
            </button>
          </div>
          <div class="filter-row">
            <el-select v-model="boxId" filterable placeholder="选择采样箱" style="width: 200px">
              <el-option
                v-for="box in boxes"
                :key="box.id"
                :label="boxTitle(box)"
                :value="box.id"
              />
            </el-select>
            <div class="chips" role="group" aria-label="时间范围">
              <button
                v-for="item in presetChips"
                :key="item.value"
                type="button"
                class="chip"
                :class="{ active: preset === item.value }"
                :aria-pressed="preset === item.value"
                @click="preset = item.value"
              >
                {{ item.label }}
              </button>
            </div>
            <el-date-picker
              v-if="preset === 'custom'"
              v-model="customRange"
              :editable="false"
              :clearable="false"
              type="datetimerange"
              range-separator="~"
              start-placeholder="开始时间"
              end-placeholder="结束时间"
              value-format="YYYY-MM-DD HH:mm:ss"
              style="width: 380px"
            />
            <el-switch v-model="anomaly" active-text="仅看异常" />
            <el-button type="primary" :loading="loading" @click="search">查询</el-button>
            <el-button
              v-if="can(BOX_PERM.logExport)"
              :loading="exporting"
              :disabled="!boxId"
              @click="exportCsv"
            >
              导出 CSV
            </el-button>
          </div>
          <p class="filter-hint">
            异常口径与采样箱列表一致：电压低于低电阈值，或任务期间开箱超上限的开箱记录。
          </p>
        </div>

        <!-- 列表：加载骨架 / 错误重试 / 空态 / 语义行；表头吸顶、表体内滚，分页器常驻可见 -->
        <div ref="tableArea" class="table-area" @scroll.capture="onTableScroll">
          <div v-if="error" class="state">
            <el-empty :image-size="60" :description="error">
              <el-button type="primary" @click="retry">重试</el-button>
            </el-empty>
          </div>
          <el-skeleton v-else-if="loading && !rows.length" :rows="8" animated class="skeleton" />
          <el-empty
            v-else-if="!rows.length"
            :image-size="80"
            :description="boxes.length ? '该时间段没有上报记录' : '数据范围内没有采样箱'"
          >
            <span class="empty-hint">换个时间范围或类型试试，或关闭「仅看异常」</span>
          </el-empty>
          <el-table
            v-else
            v-loading="loading"
            height="100%"
            :data="displayRows"
            :row-key="(row: DisplayRow) => row.id || row.time"
            :row-class-name="rowClass"
            class="records"
          >
            <el-table-column label="时间" min-width="120">
              <template #default="{ row }">
                <TimeText :value="row.time" />
              </template>
            </el-table-column>
            <el-table-column label="类型" width="110">
              <template #default="{ row }">
                <el-tag
                  size="small"
                  :type="kindTone(row.kind)"
                  :effect="row.kind === 'timer' ? 'plain' : 'light'"
                >
                  {{ kindLabel(row.kind, "设备上报") }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="摘要" min-width="300">
              <template #default="{ row }">
                <span class="facts">
                  <span v-if="row.facts.seq != null" class="fact mono">
                    seq {{ row.facts.seq }}
                  </span>
                  <span v-if="row.facts.volts != null" class="volt">
                    <i class="volt__bar">
                      <i class="volt__fill" :style="voltStyle(row.facts.volts)" />
                    </i>
                    {{ row.facts.volts.toFixed(2) }} V
                  </span>
                  <span
                    v-if="row.facts.lid"
                    class="fact lid"
                    :class="{ warn: /开/.test(row.facts.lid) }"
                  >
                    <el-icon>
                      <Unlock v-if="/开/.test(row.facts.lid)" />
                      <Lock v-else />
                    </el-icon>
                    {{ row.facts.lid }}
                  </span>
                  <span v-if="row.kind === 'chg' || row.kind === 'chgs'" class="fact charge">
                    <el-icon><Lightning /></el-icon>
                    {{ row.kind === "chg" ? "充电" : "充电状态" }}
                  </span>
                  <span v-for="part in row.facts.rest" :key="part" class="fact">{{ part }}</span>
                  <span
                    v-if="row.facts.clockDriftSec != null"
                    class="fact warn"
                    title="设备时钟和服务器收到时间相差较大，可能是离线补传"
                  >
                    设备时间 {{ fullTime(row.deviceTime).slice(5, 19) }}
                  </span>
                </span>
              </template>
            </el-table-column>
            <el-table-column label="位置（基站）" min-width="220">
              <template #default="{ row }">
                <span v-if="row.lbsLng != null && row.lbsLat != null" class="place">
                  {{ coordText(row.lbsLng, row.lbsLat) }}
                  <el-button link type="primary" size="small" @click="openMap(row)">
                    <el-icon><MapLocation /></el-icon>
                    地图
                  </el-button>
                </span>
                <span v-else class="none">—</span>
              </template>
            </el-table-column>
            <el-table-column label="GPS" min-width="220">
              <template #default="{ row }">
                <span v-if="row.gpsLng != null && row.gpsLat != null" class="place">
                  {{ coordText(row.gpsLng, row.gpsLat) }}
                  <FreshTag :time="row.time" />
                </span>
                <span v-else class="none">—</span>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="80" fixed="right">
              <template #default="{ row }">
                <el-button v-if="can(BOX_PERM.raw)" link type="primary" @click="openDetail(row)">
                  查看
                </el-button>
                <span v-else class="none">—</span>
              </template>
            </el-table-column>
          </el-table>
        </div>

        <!-- 分页：keyset 顺序翻页＋页码跳转（总条数来自概览聚合）；旧服务端无概览时退回上一页/下一页 -->
        <div class="pager">
          <el-pagination
            v-if="summary"
            background
            layout="total, prev, pager, next, jumper"
            :total="summary.total"
            :page-size="PAGE_SIZE"
            :current-page="page"
            :disabled="loading"
            @current-change="goPage"
          />
          <template v-else>
            <el-button :disabled="page === 1 || loading" @click="goPage(page - 1)">
              上一页
            </el-button>
            <span class="pager__note">第 {{ page }} 页</span>
            <el-button :disabled="!nextCursor || loading" @click="goPage(page + 1)">
              下一页
            </el-button>
          </template>
        </div>
      </template>
      <el-table v-else :data="reports">
        <el-table-column prop="time" label="时间" width="110" />
        <el-table-column prop="box" label="采样箱" width="110" />
        <el-table-column prop="event" label="事件" width="80" />
        <el-table-column prop="person" label="人员" width="120" />
        <el-table-column prop="opens" label="累计开箱" width="100" />
        <el-table-column prop="gps" label="GPS" />
        <el-table-column prop="lbs" label="基站" />
      </el-table>
    </el-card>

    <!-- 详情抽屉：摘要事实＋上报原文（保留原 dialog 的内容） -->
    <el-drawer v-model="detailOpen" title="上报详情" size="560px" destroy-on-close>
      <template v-if="detailRow">
        <el-descriptions :column="2" border size="small" class="detail-facts">
          <el-descriptions-item label="收到时间" :span="2">
            {{ fullTime(detailRow.time) }}
          </el-descriptions-item>
          <el-descriptions-item label="类型">
            <el-tag size="small" :type="kindTone(detailRow.kind)">
              {{ kindLabel(detailRow.kind, "设备上报") }}
            </el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="设备时间">
            {{ detailRow.deviceTime ? fullTime(detailRow.deviceTime) : "—" }}
          </el-descriptions-item>
          <el-descriptions-item label="摘要" :span="2">{{ detailRow.text }}</el-descriptions-item>
        </el-descriptions>
        <div v-loading="rawLoading" class="detail-raw">
          <pre v-if="detailRaw" class="raw">{{ detailRaw }}</pre>
          <el-empty v-else-if="!rawLoading" :image-size="56" description="没有原文" />
        </div>
      </template>
    </el-drawer>
  </div>
</template>

<script setup lang="ts">
import { Lightning, Lock, MapLocation, Unlock } from "@element-plus/icons-vue";
import { ElMessage } from "element-plus";
import SampleBoxAPI, { type BoxLogItem, type UplinkSummary } from "@/api/sample/box";
import FreshTag from "@/components/biz/FreshTag.vue";
import TimeText from "@/components/biz/TimeText.vue";
import { usePerm } from "@/composables/usePerm";
import { useSampleStream, type SampleStreamMessage } from "@/composables/useSampleStream";
import { presetRange } from "@/utils/batteryChart";
import { boxFileName, boxTitle } from "@/utils/boxLabel";
import { kindLabel } from "@/utils/labels";
import { coordText } from "@/utils/position";
import { fullTime } from "@/utils/time";
import { kindTone } from "@/utils/tone";
import type { SampleBox } from "@/views/sample/data";
import { BOX_PERM } from "@/views/sample/data";
import { formatRaw, uplinkFacts, type UplinkFacts } from "@/views/sample/boxes/uplink";

import { reports } from "../data";

/**
 * 上报记录独立页（/monitor/reports）。
 * 概览条＋类型/时间/异常筛选＋语义表格＋服务端分页（keyset 顺序翻、页码跳转走 OFFSET）。
 * 列表不取原文 blob，查看才按主键解压；导出复用 export-logs（device:box:logExport，5 万行截断标明）。
 * 旧服务端没有概览端点时降级：概览给「—」、分页退回上一页/下一页，列表照常。
 * 实时刷新（R24）：优先订阅 /api/v1/sample/stream 的 uplink 推送，连不上退 15s summary 轮询
 * （total|latest 指纹，隐藏暂停、恢复即查）；第 1 页近顶部静默重拉＋新行微高亮＋「已更新」chip，
 * 翻页/滚动/导出等交互中不打断，只累积「N 条新上报」badge 点击回第 1 页刷新。
 */
type DisplayRow = BoxLogItem & { facts: UplinkFacts };
type Preset = "1h" | "6h" | "24h" | "7d" | "custom";

const PAGE_SIZE = 50;
/** 实时刷新：兜底轮询间隔／表体「近顶部」阈值／交互保护窗／新行高亮时长／stream 事件合批 debounce。 */
const LIVE_POLL_MS = 15000;
const LIVE_TOP_PX = 32;
const LIVE_HOLD_MS = 1500;
const FRESH_FADE_MS = 1200;
const LIVE_DEBOUNCE_MS = 600;
const serverMode = import.meta.env.VITE_MOCK_DEV_SERVER !== "true";
const can = usePerm();
const router = useRouter();

const loading = ref(false);
const exporting = ref(false);
const error = ref("");
/** 箱选择器数据：list 角色拿完整列表；仅 log/event 角色走 report-options（只有 id+name，R21/062）。 */
const boxes = ref<Pick<SampleBox, "id" | "name">[]>([]);
const boxId = ref("");
const rows = ref<BoxLogItem[]>([]);
const kind = ref("");
const preset = ref<Preset>("7d");
const customRange = ref<[string, string]>(defaultCustomRange());
const anomaly = ref(false);
const page = ref(1);
/** cursors[i]＝取第 i+1 页用的游标（null＝第一页）；跳页没有游标时走服务端 page 参数。 */
const cursors = ref<({ time: string; id: string } | null)[]>([null]);
const nextCursor = ref<{ time: string; id: string } | null>(null);
const summary = ref<UplinkSummary | null>(null);
const summaryLoading = ref(false);
const summaryError = ref(false);
const detailOpen = ref(false);
const detailRow = ref<BoxLogItem | null>(null);
const detailRaw = ref("");
const rawLoading = ref(false);
/** 实时刷新 UI：badge 条数（未插行的新上报）／最近静默更新时刻／新行高亮键集（1.2s 后清空）。 */
const newCount = ref(0);
const lastLiveAt = ref("");
const freshKeys = ref<Set<string>>(new Set());
const tableArea = ref<HTMLElement | null>(null);

/**
 * R21（062）：事件-only 角色（无 device:box:log）只能查持码的事件种类——服务端 #logPerm 口径不变，
 * 页内把类型 chips 收窄到持码项并默认选第一项，避免默认「全部」撞 403；持 log 角色全种类照旧。
 * chgs（充电状态）/timer/unknown 不在事件码口径里，要 log 码。
 */
const EVENT_CHIP_PERMS: Record<string, string> = {
  pad: BOX_PERM.eventLid,
  shut: BOX_PERM.eventLid,
  boot: BOX_PERM.eventBoot,
  chg: BOX_PERM.eventCharge,
};
const ALL_KIND_CHIPS = [
  { value: "", label: "全部" },
  { value: "timer", label: "定时上报" },
  { value: "pad", label: "开箱" },
  { value: "shut", label: "关箱" },
  { value: "boot", label: "上电" },
  { value: "chg", label: "充电" },
  { value: "chgs", label: "充电状态" },
  { value: "unknown", label: "其他" },
];
const kindChips = computed(() =>
  can(BOX_PERM.log)
    ? ALL_KIND_CHIPS
    : ALL_KIND_CHIPS.filter(
        (chip) => EVENT_CHIP_PERMS[chip.value] && can(EVENT_CHIP_PERMS[chip.value])
      )
);
// 事件-only 角色默认选第一个持码事件种类（「全部」要 log 码，默认查会 403）
if (!can(BOX_PERM.log)) kind.value = kindChips.value[0]?.value ?? "";
const presetChips: { value: Preset; label: string }[] = [
  { value: "1h", label: "1 小时" },
  { value: "6h", label: "6 小时" },
  { value: "24h", label: "24 小时" },
  { value: "7d", label: "7 天" },
  { value: "custom", label: "自定义" },
];

const displayRows = computed<DisplayRow[]>(() =>
  rows.value.map((item) => ({ ...item, facts: uplinkFacts(item) }))
);
const currentBox = computed(() => boxes.value.find((box) => box.id === boxId.value) ?? null);
const kindCount = (key: string) => summary.value?.kinds[key] ?? 0;
const timerRatio = computed(() => {
  if (!summary.value || !summary.value.total) return "—";
  return `${(((summary.value.kinds.timer ?? 0) / summary.value.total) * 100).toFixed(1)}%`;
});
const voltRange = computed(() => {
  if (!summary.value || summary.value.minMv == null || summary.value.maxMv == null) return "—";
  return `${(summary.value.minMv / 1000).toFixed(2)}–${(summary.value.maxMv / 1000).toFixed(2)} V`;
});
const rangeNote = computed(() => {
  const [from, to] = summary.value
    ? [summary.value.window.from, summary.value.window.to]
    : effectiveRange();
  const name = currentBox.value ? boxTitle(currentBox.value) : "未选采样箱";
  return `${name} · ${from.slice(0, 16)} ~ ${to.slice(0, 16)}${anomaly.value ? " · 仅异常" : ""}`;
});

function defaultCustomRange(): [string, string] {
  return presetRange("7d");
}

function effectiveRange(): [string, string] {
  if (preset.value === "custom") return customRange.value ?? ["", ""];
  return presetRange(preset.value);
}

/** 电压 mini bar：3.3–4.2 V 映射宽度，低电红/偏低橙/正常绿（与电量色阶同族）。 */
function voltStyle(volts: number) {
  const width = Math.min(100, Math.max(4, ((volts - 3.3) / 0.9) * 100));
  const color =
    volts < 3.6
      ? "var(--el-color-danger)"
      : volts < 3.8
        ? "var(--el-color-warning)"
        : "var(--el-color-success)";
  return { width: `${width}%`, background: color };
}

async function loadBoxes() {
  // R21（062）：持 log/event 无 list 的角色走轻量 report-options（仅范围内 id+name）；
  // 持 list 的角色保持原列表端点，行为不变。
  boxes.value = can(BOX_PERM.list) ? await SampleBoxAPI.list() : await SampleBoxAPI.reportOptions();
  if (!boxId.value && boxes.value[0]) boxId.value = boxes.value[0].id;
}

let seq = 0;
/** silent＝实时刷新静默重拉：不亮 loading、失败不清空已有行；返回是否落地（竞态丢弃＝false）。 */
async function load(
  opts: { cursor?: { time: string; id: string } | null; page?: number; silent?: boolean } = {}
): Promise<boolean> {
  if (!boxId.value) return false;
  const [from, to] = effectiveRange();
  if (!from || !to) return false;
  const mine = ++seq;
  if (!opts.silent) loading.value = true;
  error.value = "";
  try {
    const cursor = opts.cursor ?? null;
    const result = await SampleBoxAPI.logs(boxId.value, {
      from,
      to,
      limit: PAGE_SIZE,
      kind: kind.value || undefined,
      anomaly: anomaly.value ? "1" : undefined,
      cursorTime: cursor?.time,
      cursorId: cursor?.id,
      page: cursor ? undefined : opts.page,
    });
    if (mine !== seq) return false;
    rows.value = result.list;
    nextCursor.value = result.nextCursor;
    // 记下「下一页」的游标供回翻走 keyset；更深的旧游标作废截掉
    const index = page.value;
    cursors.value = cursors.value.slice(0, index);
    if (result.nextCursor) cursors.value[index] = result.nextCursor;
    return true;
  } catch (e) {
    if (mine !== seq) return false;
    if (!opts.silent) {
      rows.value = [];
      nextCursor.value = null;
      error.value = e instanceof Error ? e.message : "加载失败";
    }
    return false;
  } finally {
    if (mine === seq && !opts.silent) loading.value = false;
  }
}

let sumSeq = 0;
/** 返回落地的概览（竞态丢弃/失败＝null），调用方用它重置实时刷新基线。 */
async function loadSummary(): Promise<UplinkSummary | null> {
  if (!boxId.value) return null;
  const [from, to] = effectiveRange();
  if (!from || !to) return null;
  const mine = ++sumSeq;
  summaryLoading.value = true;
  try {
    const result = await SampleBoxAPI.uplinkSummary(boxId.value, {
      from,
      to,
      kind: kind.value || undefined,
      anomaly: anomaly.value ? "1" : undefined,
    });
    if (mine !== sumSeq) return null;
    summary.value = result;
    summaryError.value = false;
    return result;
  } catch {
    if (mine !== sumSeq) return null;
    // 旧服务端没有概览端点：降级为「—」＋上一页/下一页，列表不受影响
    summary.value = null;
    summaryError.value = true;
    return null;
  } finally {
    if (mine === sumSeq) summaryLoading.value = false;
  }
}

function search() {
  page.value = 1;
  cursors.value = [null];
  resetLiveCounters();
  scrollTableTop();
  void load({ cursor: null });
  void loadSummary().then((result) => {
    if (result) setLiveBaseline(result);
  });
}

function goPage(target: number) {
  if (target < 1 || loading.value) return;
  bumpInteract();
  // 回第 1 页＝用户主动看最新：与 badge 点击同路径，重置计数并同步概览
  if (target === 1) {
    search();
    return;
  }
  const cursor = cursors.value[target - 1];
  page.value = target;
  void load(cursor !== undefined ? { cursor } : { page: target });
}

async function retry() {
  error.value = "";
  try {
    if (!boxes.value.length) await loadBoxes();
    search();
  } catch (e) {
    error.value = e instanceof Error ? e.message : "加载失败";
  }
}

function openMap(row: unknown) {
  const item = row as BoxLogItem;
  void router.push({ path: "/monitor/screen", query: { box: item.box } });
}

async function openDetail(row: unknown) {
  const item = row as BoxLogItem;
  detailRow.value = item;
  detailRaw.value = "";
  detailOpen.value = true;
  if (!item.id) return;
  rawLoading.value = true;
  try {
    const data = await SampleBoxAPI.raw(boxId.value, item.id, item.time);
    detailRaw.value = formatRaw(data.raw);
  } catch {
    detailRaw.value = "";
  } finally {
    rawLoading.value = false;
  }
}

async function exportCsv() {
  if (!boxId.value) return;
  const [from, to] = effectiveRange();
  if (!from || !to) return;
  exporting.value = true;
  try {
    const res = await SampleBoxAPI.exportLogs(boxId.value, {
      from,
      to,
      kind: kind.value || undefined,
      anomaly: anomaly.value ? "1" : undefined,
    });
    const matched = String(res.headers["content-disposition"] || "").match(
      /filename\*=UTF-8''([^;]+)/
    );
    const url = URL.createObjectURL(res.data);
    const link = document.createElement("a");
    link.href = url;
    link.download = matched
      ? decodeURIComponent(matched[1])
      : `${boxFileName(currentBox.value)}-上报日志.csv`;
    link.click();
    URL.revokeObjectURL(url);
    if (String(res.headers["x-export-truncated"] || "") === "1") {
      ElMessage.warning("已达单次导出上限 5 万行，仅导出最近的 5 万行；其余请缩小时间范围分批导出");
    }
  } finally {
    exporting.value = false;
  }
}

/* ---- 实时刷新（R24）：stream 优先＋15s summary 轮询兜底 ---- */
/** 用户基线（查询/切筛选/回第 1 页）时的概览 total；badge＝未插行的新上报＝不匹配事件＋基线后增量。 */
let baseTotal = 0;
/** 静默检查最近一次看到的 total（badge 模式下不上屏，只用来计数）。 */
let seenTotal = 0;
/** stream 事件里确定不匹配 kind/时间筛选的条数（anomaly 口径在服务端，交给 summary 复核）。 */
let mismatchCount = 0;
let lastFingerprint = "";
let liveTimer = 0;
let checkTimer = 0;
let freshTimer = 0;
/** 交互保护窗：滚动/点击后短暂暂停自动插入，防抖动。 */
let interactUntil = 0;
let tableScrolled = false;
let checking = false;
let liveStopped = false;

const { live: streamLive } = useSampleStream({
  enabled: serverMode,
  onMessage: onStreamMessage,
  onLive: () => {
    stopLivePoll();
    // 连上之前漏掉的报文补一次（与箱详情页同策略）
    void checkLive();
  },
  onDown: () => startLivePoll(),
});

const rowKey = (row: BoxLogItem) => row.id || row.time;

function rowClass({ row }: { row: DisplayRow }) {
  return freshKeys.value.has(rowKey(row)) ? "row-fresh" : "";
}

function clockNow() {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function updateBadge() {
  newCount.value = mismatchCount + Math.max(0, seenTotal - baseTotal);
}

function resetLiveCounters() {
  mismatchCount = 0;
  newCount.value = 0;
}

function setLiveBaseline(result: UplinkSummary) {
  baseTotal = result.total;
  seenTotal = result.total;
  lastFingerprint = `${result.total}|${result.latest}`;
}

function bumpInteract() {
  interactUntil = Date.now() + LIVE_HOLD_MS;
}

function scrollTableTop() {
  const wrap = tableArea.value?.querySelector<HTMLElement>(".el-scrollbar__wrap");
  if (wrap) wrap.scrollTop = 0;
  tableScrolled = false;
}

/** 表体内滚（EP2 el-scrollbar）：离开顶部即视为「正在看旧数据」，自动插入改走 badge。 */
function onTableScroll(event: Event) {
  const target = event.target as HTMLElement | null;
  if (!target || !target.closest(".el-table__body-wrapper")) return;
  tableScrolled = target.scrollTop > LIVE_TOP_PX;
  bumpInteract();
}

/** 第 1 页＋近顶部＋无交互/导出/详情阅读中才允许静默插行；其余一律 badge 不打断。 */
function canAutoInsert() {
  return (
    page.value === 1 &&
    !tableScrolled &&
    !loading.value &&
    !summaryLoading.value &&
    !exporting.value &&
    !detailOpen.value &&
    !error.value &&
    Date.now() >= interactUntil &&
    !document.hidden
  );
}

/** kind/时间按秒级对齐服务端窗口；anomaly 客户端不可靠复算，视为可能匹配交给 summary 判定。 */
function matchesFilter(uplink: BoxLogItem) {
  if (kind.value && (uplink.kind || "unknown") !== kind.value) return false;
  const [from, to] = effectiveRange();
  const time = uplink.time.slice(0, 19);
  if (from && time < from) return false;
  if (to && time > to) return false;
  return true;
}

function onStreamMessage(message: SampleStreamMessage) {
  if (message.type !== "box" || !message.box || !message.uplink) return;
  if (message.box.id !== boxId.value) return;
  if (!matchesFilter(message.uplink)) {
    // 筛选不匹配：只计 badge 不插行（隐藏时也计数，恢复后统一补查）
    mismatchCount += 1;
    updateBadge();
    return;
  }
  if (document.hidden) return;
  // 多包合批：短暂 debounce 后一次 summary 复核，避免密集上报逐包重拉
  window.clearTimeout(checkTimer);
  checkTimer = window.setTimeout(() => void checkLive(), LIVE_DEBOUNCE_MS);
}

/** 静默重拉第 1 页＋概览：新行 prepend 微高亮 1.2s 淡出，右上角 chip 记更新时间。 */
async function silentRefresh(result: UplinkSummary) {
  const oldKeys = new Set(rows.value.map(rowKey));
  const ok = await load({ cursor: null, silent: true });
  if (!ok) return;
  summary.value = result;
  summaryError.value = false;
  const fresh = new Set<string>();
  for (const row of rows.value) {
    const key = rowKey(row);
    if (!oldKeys.has(key)) fresh.add(key);
  }
  window.clearTimeout(freshTimer);
  freshKeys.value = fresh;
  if (fresh.size) {
    freshTimer = window.setTimeout(() => {
      freshKeys.value = new Set();
    }, FRESH_FADE_MS);
  }
  setLiveBaseline(result);
  lastLiveAt.value = clockNow();
}

/** summary 指纹（total|latest）变了才动页面：能插则静默插行，不能插只累积 badge。 */
async function checkLive() {
  if (!serverMode || liveStopped || checking || !boxId.value) return;
  if (document.hidden) return;
  if (loading.value || summaryLoading.value) {
    // 用户查询在飞：基线即将重置，稍后再查而不是丢事件
    window.clearTimeout(checkTimer);
    checkTimer = window.setTimeout(() => void checkLive(), LIVE_DEBOUNCE_MS);
    return;
  }
  const [from, to] = effectiveRange();
  if (!from || !to) return;
  const box = boxId.value;
  const kindNow = kind.value;
  const anomalyNow = anomaly.value;
  const presetNow = preset.value;
  const customNow = customRange.value;
  checking = true;
  try {
    const result = await SampleBoxAPI.uplinkSummary(box, {
      from,
      to,
      kind: kindNow || undefined,
      anomaly: anomalyNow ? "1" : undefined,
    });
    // 请求期间切了箱/筛选：丢弃本次结果（新查询自己重置基线）
    if (
      box !== boxId.value ||
      kindNow !== kind.value ||
      anomalyNow !== anomaly.value ||
      presetNow !== preset.value ||
      customNow !== customRange.value
    )
      return;
    seenTotal = result.total;
    const fingerprint = `${result.total}|${result.latest}`;
    if (fingerprint === lastFingerprint) {
      updateBadge();
      return;
    }
    lastFingerprint = fingerprint;
    if (canAutoInsert()) await silentRefresh(result);
    updateBadge();
  } catch {
    /* 静默检查失败不打扰页面：保留旧数据，等下一轮事件/轮询 */
  } finally {
    checking = false;
  }
}

function startLivePoll() {
  if (liveTimer || liveStopped || !serverMode || streamLive.value) return;
  liveTimer = window.setInterval(() => {
    if (!document.hidden) void checkLive();
  }, LIVE_POLL_MS);
}

function stopLivePoll() {
  window.clearInterval(liveTimer);
  liveTimer = 0;
}

/** 隐藏暂停（停轮询、stream 事件不触发重拉）；恢复即查一次补上漏掉的。 */
function onVisibilityChange() {
  if (document.hidden) {
    stopLivePoll();
    return;
  }
  void checkLive();
  startLivePoll();
}

const debouncedSearch = useDebounceFn(search, 300);
watch([kind, boxId, preset, anomaly], () => {
  bumpInteract();
  debouncedSearch();
});
watch(customRange, () => {
  if (preset.value === "custom") {
    bumpInteract();
    debouncedSearch();
  }
});

onMounted(async () => {
  if (!serverMode) return;
  document.addEventListener("visibilitychange", onVisibilityChange);
  try {
    await loadBoxes();
    search();
  } catch (e) {
    error.value = e instanceof Error ? e.message : "加载失败";
  }
});

onActivated(() => {
  if (!serverMode || document.hidden) return;
  void checkLive();
  startLivePoll();
});

onDeactivated(() => {
  stopLivePoll();
  window.clearTimeout(checkTimer);
});

onBeforeUnmount(() => {
  liveStopped = true;
  stopLivePoll();
  window.clearTimeout(checkTimer);
  window.clearTimeout(freshTimer);
  document.removeEventListener("visibilitychange", onVisibilityChange);
});
</script>

<style lang="scss" scoped>
/* 卡片撑满页面高度：概览/筛选/分页器固定，表体占剩余高度内滚（分页器常驻可见） */
.records-card {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
}

.records-card :deep(.el-card__body) {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
}

.table-area {
  flex: 1;
  min-height: 160px;
}

.overview {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 24px;
  align-items: baseline;
  padding: 12px 16px;
  margin-bottom: 12px;
  background: var(--el-fill-color-lighter);
  border-radius: 8px;
}

.stat {
  display: inline-flex;
  gap: 6px;
  align-items: baseline;
}

.stat__label {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.stat__value {
  font-size: 16px;
  font-variant-numeric: tabular-nums;
  color: var(--el-text-color-primary);
}

.stat__value.warn {
  color: var(--el-color-danger);
}

.overview__note {
  flex-basis: 100%;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.overview__live {
  display: inline-flex;
  gap: 8px;
  align-items: center;
  margin-left: auto;
}

.live-badge {
  padding: 3px 12px;
  font-size: 12px;
  color: var(--el-color-white);
  cursor: pointer;
  background: var(--el-color-primary);
  border: none;
  border-radius: 999px;
  transition: background 0.15s;
}

.live-badge:hover {
  background: var(--el-color-primary-light-3);
}

.live-chip {
  padding: 2px 10px;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: var(--el-color-primary);
  background: var(--el-color-primary-light-9);
  border-radius: 999px;
}

.filters {
  margin-bottom: 12px;
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.chip {
  padding: 4px 12px;
  font-size: 13px;
  color: var(--el-text-color-regular);
  cursor: pointer;
  background: var(--el-fill-color-light);
  border: 1px solid transparent;
  border-radius: 999px;
  transition:
    color 0.15s,
    background 0.15s,
    border-color 0.15s;
}

.chip:hover {
  color: var(--el-color-primary);
  background: var(--el-color-primary-light-9);
}

.chip.active {
  color: var(--el-color-primary);
  background: var(--el-color-primary-light-9);
  border-color: var(--el-color-primary-light-5);
}

.filter-row {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: center;
  margin-top: 10px;
}

.filter-hint {
  margin: 8px 0 0;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.skeleton {
  padding: 8px 4px;
}

.state {
  padding: 12px 0;
}

.empty-hint {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

/* 实时新行：prepend 后微高亮 1.2s 淡出（键集合同时清空，动画不残留） */
.records :deep(.row-fresh > td.el-table__cell) {
  animation: row-fresh-fade 1.2s ease-out;
}

@keyframes row-fresh-fade {
  from {
    background-color: var(--el-color-primary-light-8);
  }

  to {
    background-color: var(--el-table-tr-bg-color);
  }
}

.facts {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  align-items: center;
  font-size: 13px;
}

.fact {
  display: inline-flex;
  gap: 3px;
  align-items: center;
  color: var(--el-text-color-secondary);
  white-space: nowrap;
}

.fact.warn {
  color: var(--el-color-warning-dark-2);
}

.fact.lid.warn {
  color: var(--el-color-danger);
}

.fact.charge {
  color: var(--el-color-warning-dark-2);
}

.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.volt {
  display: inline-flex;
  gap: 6px;
  align-items: center;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.volt__bar {
  position: relative;
  width: 40px;
  height: 6px;
  overflow: hidden;
  background: var(--el-fill-color);
  border-radius: 3px;
}

.volt__fill {
  position: absolute;
  inset: 0 auto 0 0;
  border-radius: 3px;
}

.place {
  display: inline-flex;
  gap: 8px;
  align-items: center;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}

.none {
  color: var(--el-text-color-placeholder);
}

.pager {
  display: flex;
  gap: 8px;
  align-items: center;
  justify-content: flex-end;
  margin-top: 12px;
}

.pager__note {
  font-size: 13px;
  color: var(--el-text-color-secondary);
}

.detail-facts {
  margin-bottom: 12px;
}

.detail-raw {
  min-height: 120px;
}

.raw {
  max-height: 60vh;
  padding: 10px;
  margin: 0;
  overflow: auto;
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  background: var(--el-fill-color-light);
  border-radius: 6px;
}
</style>
