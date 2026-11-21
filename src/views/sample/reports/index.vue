<template>
  <div class="page-container uplink-records">
    <el-card shadow="never" class="records-card">
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
        <div class="table-area">
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
 */
type DisplayRow = BoxLogItem & { facts: UplinkFacts };
type Preset = "1h" | "6h" | "24h" | "7d" | "custom";

const PAGE_SIZE = 50;
const serverMode = import.meta.env.VITE_MOCK_DEV_SERVER !== "true";
const can = usePerm();
const router = useRouter();

const loading = ref(false);
const exporting = ref(false);
const error = ref("");
const boxes = ref<SampleBox[]>([]);
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

const kindChips = [
  { value: "", label: "全部" },
  { value: "timer", label: "定时上报" },
  { value: "pad", label: "开箱" },
  { value: "shut", label: "关箱" },
  { value: "boot", label: "上电" },
  { value: "chg", label: "充电" },
  { value: "chgs", label: "充电状态" },
  { value: "unknown", label: "其他" },
];
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
  boxes.value = await SampleBoxAPI.list();
  if (!boxId.value && boxes.value[0]) boxId.value = boxes.value[0].id;
}

let seq = 0;
async function load(opts: { cursor?: { time: string; id: string } | null; page?: number } = {}) {
  if (!boxId.value) return;
  const [from, to] = effectiveRange();
  if (!from || !to) return;
  const mine = ++seq;
  loading.value = true;
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
    if (mine !== seq) return;
    rows.value = result.list;
    nextCursor.value = result.nextCursor;
    // 记下「下一页」的游标供回翻走 keyset；更深的旧游标作废截掉
    const index = page.value;
    cursors.value = cursors.value.slice(0, index);
    if (result.nextCursor) cursors.value[index] = result.nextCursor;
  } catch (e) {
    if (mine !== seq) return;
    rows.value = [];
    nextCursor.value = null;
    error.value = e instanceof Error ? e.message : "加载失败";
  } finally {
    if (mine === seq) loading.value = false;
  }
}

let sumSeq = 0;
async function loadSummary() {
  if (!boxId.value) return;
  const [from, to] = effectiveRange();
  if (!from || !to) return;
  const mine = ++sumSeq;
  summaryLoading.value = true;
  try {
    const result = await SampleBoxAPI.uplinkSummary(boxId.value, {
      from,
      to,
      kind: kind.value || undefined,
      anomaly: anomaly.value ? "1" : undefined,
    });
    if (mine !== sumSeq) return;
    summary.value = result;
    summaryError.value = false;
  } catch {
    if (mine !== sumSeq) return;
    // 旧服务端没有概览端点：降级为「—」＋上一页/下一页，列表不受影响
    summary.value = null;
    summaryError.value = true;
  } finally {
    if (mine === sumSeq) summaryLoading.value = false;
  }
}

function search() {
  page.value = 1;
  cursors.value = [null];
  void load({ cursor: null });
  void loadSummary();
}

function goPage(target: number) {
  if (target < 1 || loading.value) return;
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

const debouncedSearch = useDebounceFn(search, 300);
watch([kind, boxId, preset, anomaly], () => debouncedSearch());
watch(customRange, () => {
  if (preset.value === "custom") debouncedSearch();
});

onMounted(async () => {
  if (!serverMode) return;
  try {
    await loadBoxes();
    search();
  } catch (e) {
    error.value = e instanceof Error ? e.message : "加载失败";
  }
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
