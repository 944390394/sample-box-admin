<template>
  <div class="page-container page-flow">
    <PageHeader
      title="USB 串口读取"
      back="/device/boxes"
      subtitle="把采样箱用 USB 线插到这台电脑，直接读箱子里的状态和还没同步到服务器的记录。数据不经过服务器。"
    />

    <el-result
      v-if="!supported"
      icon="warning"
      title="这个浏览器不能直接读串口"
      data-test="serial-unsupported"
    >
      <template #sub-title>
        <p class="text-muted">
          请用电脑上的 Chrome 或 Edge 打开这一页，并且网址要是 https
          开头。手机和微信里的浏览器都不支持。
        </p>
      </template>
    </el-result>

    <template v-else>
      <SectionCard title="连接" data-test="serial-connect">
        <template #extra>
          <span class="state" :class="{ on: connected }">
            <i />
            {{ connected ? "已连接" : "未连接" }}
          </span>
        </template>
        <div class="connect">
          <ol class="steps">
            <li>用 USB 线把采样箱插到电脑上（插上就会开始充电，单片机这时不休眠，能随时回话）。</li>
            <li>
              点「连接设备」，在浏览器弹出的列表里选
              <b>USB-SERIAL CH340</b>
              （Windows 上也可能叫 USB 串行设备）。
            </li>
            <li>读完点「断开」再拔线。列表里没有设备时，先装 CH340 驱动。</li>
          </ol>
          <p class="text-muted fw-note">
            要箱子固件 1.0.15 及以上；更早的固件只会把上报行吐到这个口，不回命令。
          </p>
          <div class="connect__actions">
            <el-button
              v-if="!connected"
              type="primary"
              :icon="Connection"
              :loading="connecting"
              @click="connect"
            >
              连接设备
            </el-button>
            <template v-else>
              <el-button :icon="Refresh" @click="refresh">刷新状态</el-button>
              <el-button @click="disconnect">断开</el-button>
            </template>
          </div>
        </div>
        <el-alert
          v-if="error"
          type="error"
          :closable="false"
          show-icon
          :title="error"
          class="error"
        />
        <el-alert
          v-else-if="silent"
          type="warning"
          :closable="false"
          show-icon
          class="error"
          title="连上了，但箱子没回命令：固件可能低于 1.0.15，或选错了串口。下面的串口原文里能看到箱子吐出的上报行。"
        />
      </SectionCard>

      <div class="grid">
        <SectionCard
          title="箱子状态"
          :sub="infoAt ? `读取于 ${infoAt}` : ''"
          data-test="serial-info"
        >
          <InfoList v-if="info" :items="infoItems" label-width="84px" />
          <div v-else class="empty-line">{{ connected ? "正在读取…" : "连接后自动读取" }}</div>
        </SectionCard>

        <SectionCard title="没同步到服务器的记录" data-test="serial-queue">
          <template #extra>
            <el-button
              size="small"
              type="primary"
              :disabled="!connected || dumping"
              :loading="dumping"
              @click="dump"
            >
              逐条读出
            </el-button>
            <el-button size="small" :disabled="!records.length" @click="exportCsv">
              导出 CSV
            </el-button>
          </template>
          <div v-if="queue" class="queue">
            <strong>{{ queue.pending }}</strong>
            <span class="text-muted">
              条：已存进闪存 {{ queue.flash }} 条，有信号后自动补传；刚发出还在等确认
              {{ queue.ring }} 条
            </span>
          </div>
          <div v-else class="empty-line">{{ connected ? "正在读取…" : "连接后自动读取" }}</div>
          <el-progress
            v-if="dumping && queue && queue.pending"
            :percentage="Math.min(100, Math.round((records.length / queue.pending) * 100))"
            :stroke-width="6"
            class="progress"
          />
          <p class="text-muted hint">
            这些记录就是箱子里的「未同步清单」：服务器确认一条，箱子才删一条。读出来只是查看，不会删除。
          </p>
        </SectionCard>
      </div>

      <SectionCard
        v-if="records.length"
        title="未同步记录明细"
        :sub="`共 ${records.length} 条，最老的在前`"
        flush
      >
        <el-table :data="records" max-height="420" class="records">
          <el-table-column label="队列号" width="90">
            <template #default="{ row }">
              <span class="mono">{{ row.q }}</span>
            </template>
          </el-table-column>
          <el-table-column label="位置" width="120">
            <template #default="{ row }">
              <span class="chip" :class="row.flash ? 'is-flash' : 'is-ring'">
                {{ row.flash ? "闪存 · 待补传" : "内存 · 等确认" }}
              </span>
            </template>
          </el-table-column>
          <el-table-column label="类型" width="100">
            <template #default="{ row }">{{ row.kind }}</template>
          </el-table-column>
          <el-table-column label="设备时间" width="170">
            <template #default="{ row }">
              <span class="mono">{{ row.time || "—" }}</span>
            </template>
          </el-table-column>
          <el-table-column label="电压 · 箱盖" width="140">
            <template #default="{ row }">{{ row.battery }} · {{ row.lid }}</template>
          </el-table-column>
          <el-table-column label="原文" min-width="260" show-overflow-tooltip>
            <template #default="{ row }">
              <span class="mono">{{ row.text }}</span>
            </template>
          </el-table-column>
        </el-table>
      </SectionCard>

      <SectionCard title="串口原文" sub="板子镜像出来的上报行和命令回复，最多留 500 行">
        <template #extra>
          <el-button
            v-for="cmd in QUICK"
            :key="cmd"
            size="small"
            :disabled="!connected"
            @click="send(cmd)"
          >
            {{ cmd }}
          </el-button>
          <el-button size="small" link @click="log = []">清空</el-button>
        </template>
        <div ref="logBox" class="log" data-test="serial-log">
          <div v-for="(line, i) in log" :key="i" :class="['log__line', line.dir]">
            {{ line.dir === "out" ? "> " : "" }}{{ line.text }}
          </div>
          <div v-if="!log.length" class="empty-line">还没有内容</div>
        </div>
        <div class="send">
          <el-input
            v-model="command"
            placeholder="输入命令，如 info"
            :disabled="!connected"
            @keyup.enter="sendTyped"
          />
          <el-button :disabled="!connected || !command.trim()" @click="sendTyped">发送</el-button>
        </div>
      </SectionCard>
    </template>
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: "SampleSerial" });

import { Connection, Refresh } from "@element-plus/icons-vue";
import InfoList, { type InfoItem } from "@/components/biz/InfoList.vue";
import PageHeader from "@/components/biz/PageHeader.vue";
import SectionCard from "@/components/biz/SectionCard.vue";
import { chargeLabel, kindLabel, lidLabel } from "@/utils/labels";
import { BoxSerial, parseReply, serialSupported, uplinkFields } from "@/utils/serialBox";
import { fullTime, localStamp } from "@/utils/time";

/**
 * USB 串口读取：用浏览器的 Web Serial 直接和插在电脑上的采样箱说话（固件 1.0.15 起）。
 * 连上后自动发 info、queue；「逐条读出」发 dump，收 #rec 直到 #end。协议见 docs/offline-queue.md。
 */
const QUICK = ["info", "queue", "last", "help"];
const supported = serialSupported();
const connected = ref(false);
const connecting = ref(false);
const error = ref("");
const command = ref("");
const log = ref<{ dir: "in" | "out"; text: string }[]>([]);
const logBox = ref<HTMLElement | null>(null);
const info = ref<Record<string, string> | null>(null);
const infoAt = ref("");
const queue = ref<{ pending: number; flash: number; ring: number } | null>(null);
const dumping = ref(false);
/* 连上后 3 秒还没收到 #info：多半是旧固件，或者选错了口 */
const silent = ref(false);
let silentTimer = 0;

interface RecordRow {
  q: string;
  flash: boolean;
  kind: string;
  time: string;
  battery: string;
  lid: string;
  text: string;
}
const records = ref<RecordRow[]>([]);
let collecting: RecordRow[] = [];

function push(dir: "in" | "out", text: string) {
  log.value.push({ dir, text });
  if (log.value.length > 500) log.value.splice(0, log.value.length - 500);
  void nextTick(() => {
    if (logBox.value) logBox.value.scrollTop = logBox.value.scrollHeight;
  });
}

function onLine(line: string) {
  const reply = parseReply(line);
  // dump 时几百条 #rec 不刷进原文区，只进表格
  if (reply.kind !== "rec") push("in", line);
  if (reply.kind === "info") {
    silent.value = false;
    info.value = reply.fields;
    infoAt.value = localStamp(new Date()).slice(11);
  } else if (reply.kind === "queue") {
    queue.value = {
      pending: Number(reply.fields.pending) || 0,
      flash: Number(reply.fields.flash) || 0,
      ring: Number(reply.fields.ring) || 0,
    };
  } else if (reply.kind === "rec") {
    collecting.push(toRow(reply.fields.q || "", reply.fields.bf === "1", reply.text));
    if (collecting.length % 20 === 0) records.value = [...collecting];
  } else if (reply.kind === "end") {
    records.value = [...collecting];
    dumping.value = false;
    ElMessage.success(`读出 ${records.value.length} 条没同步的记录`);
  }
}

function toRow(q: string, flash: boolean, text: string): RecordRow {
  const f = uplinkFields(text);
  const t = Number(f.t);
  const bat = Number(f.bat);
  return {
    q,
    flash,
    kind: kindLabel(f.why, f.why || "—"),
    time: t > 1e12 ? fullTime(localStamp(new Date(t))) : "",
    battery: bat > 0 ? `${(bat / 1000).toFixed(2)} V` : "—",
    lid: f.lid === "1" ? lidLabel(1) : f.lid === "0" ? lidLabel(0) : "—",
    text,
  };
}

const serial = new BoxSerial(onLine, (reason) => {
  connected.value = false;
  dumping.value = false;
  if (reason) error.value = `连接断了：${reason}。检查 USB 线后重新连接。`;
});

async function connect() {
  error.value = "";
  connecting.value = true;
  try {
    await serial.connect();
    connected.value = true;
    silent.value = false;
    push("out", "（已连接，9600 8N1）");
    await refresh();
    window.clearTimeout(silentTimer);
    silentTimer = window.setTimeout(() => {
      if (connected.value && !info.value) silent.value = true;
    }, 3000);
  } catch (e) {
    const text = e instanceof Error ? e.message : String(e);
    // 用户在选择框里点了取消，不算错
    if (!/No port selected|cancel/i.test(text))
      error.value = `连不上：${text}。确认设备没被别的程序（串口助手等）占用。`;
  } finally {
    connecting.value = false;
  }
}

async function send(cmd: string) {
  try {
    push("out", cmd);
    await serial.send(cmd);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

async function refresh() {
  await send("info");
  await send("queue");
}

function sendTyped() {
  const cmd = command.value.trim();
  if (!cmd) return;
  command.value = "";
  void send(cmd);
}

async function dump() {
  collecting = [];
  records.value = [];
  dumping.value = true;
  await send("queue");
  await send("dump");
}

async function disconnect() {
  await serial.disconnect();
  connected.value = false;
  push("out", "（已断开）");
}

const infoItems = computed<InfoItem[]>(() => {
  const f = info.value || {};
  const bat = Number(f.bat);
  const t = Number(f.t);
  const free = Number(f.free);
  return [
    { label: "固件", value: f.fw || "—", mono: true },
    { label: "充电", value: f.chg != null ? chargeLabel(Number(f.chg)) : "—" },
    { label: "电池电压", value: bat > 0 ? `${(bat / 1000).toFixed(2)} V` : "—" },
    { label: "箱盖", value: f.lid != null ? lidLabel(Number(f.lid)) : "—" },
    { label: "累计开箱", value: f.opens != null ? `${f.opens} 次` : "—" },
    {
      label: "联网",
      value: f.link === "1" ? "模块已就绪" : f.link === "0" ? "模块未就绪（没信号或没开机）" : "—",
    },
    { label: "设备时间", value: t > 1e12 ? fullTime(localStamp(new Date(t))) : "还没对时" },
    { label: "上报周期", value: f.period ? `${f.period} 秒` : "—" },
    { label: "上报序号", value: f.seq || "—", mono: true },
    { label: "待同步", value: f.pending != null ? `${f.pending} 条` : "—" },
    { label: "剩余存储", value: free > 0 ? `${(free / 1048576).toFixed(2)} MB` : "—" },
  ];
});

function exportCsv() {
  const head = ["队列号", "位置", "类型", "设备时间", "电压", "箱盖", "原文"];
  const cell = (v: string) => `"${String(v).replace(/"/g, '""')}"`;
  const rows = records.value.map((r) =>
    [r.q, r.flash ? "闪存" : "内存", r.kind, r.time, r.battery, r.lid, r.text].map(cell).join(",")
  );
  const blob = new Blob([`\uFEFF${head.join(",")}\n${rows.join("\n")}\n`], {
    type: "text/csv;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `未同步记录-${localStamp(new Date()).replace(/[: ]/g, "")}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

onBeforeUnmount(() => {
  window.clearTimeout(silentTimer);
  void serial.disconnect();
});
</script>

<style scoped>
.state {
  display: inline-flex;
  gap: 6px;
  align-items: center;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}
.state i {
  width: 8px;
  height: 8px;
  background: var(--status-stale);
  border-radius: 50%;
}
.state.on {
  color: var(--status-ok);
}
.state.on i {
  background: var(--status-ok);
}
.connect {
  display: flex;
  flex-wrap: wrap;
  gap: 12px 24px;
  align-items: center;
  justify-content: space-between;
}
.steps {
  flex: 1;
  min-width: 260px;
  padding-left: 20px;
  margin: 0;
  font-size: 13px;
  line-height: 1.9;
  color: var(--el-text-color-regular);
}
.fw-note {
  flex-basis: 100%;
  margin: -4px 0 0;
}
.connect__actions {
  display: flex;
  gap: 8px;
}
.error {
  margin-top: 12px;
}
.grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--page-gap);
}
.queue {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: baseline;
}
.queue strong {
  font-size: 28px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.progress {
  margin-top: 10px;
}
.hint {
  margin: 12px 0 0;
}
.empty-line {
  font-size: 13px;
  color: var(--el-text-color-placeholder);
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
}
.chip {
  padding: 1px 6px;
  font-size: 12px;
  border-radius: 4px;
}
.chip.is-flash {
  color: var(--loc-lbs);
  background: var(--loc-lbs-bg);
}
.chip.is-ring {
  color: var(--loc-gps);
  background: var(--loc-gps-bg);
}
.log {
  height: 260px;
  padding: 10px 12px;
  overflow-y: auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.6;
  color: var(--el-text-color-regular);
  background: var(--el-fill-color-lighter);
  border-radius: 8px;
}
.log__line {
  overflow-wrap: anywhere;
}
.log__line.out {
  color: var(--el-color-primary);
}
.send {
  display: flex;
  gap: 8px;
  margin-top: 10px;
}
@media (max-width: 900px) {
  .grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
