<template>
  <el-dialog
    v-model="open"
    :title="`${boxId} · 导出日志`"
    width="620px"
    style="max-width: 94vw"
    destroy-on-close
    @opened="onOpened"
    @closed="stop"
  >
    <el-radio-group v-model="source" class="source">
      <el-radio-button v-if="allow(BOX_PERM.logExport)" value="server">
        服务器已存上报
      </el-radio-button>
      <el-radio-button v-if="allow(BOX_PERM.dump)" value="device">板子本机日志</el-radio-button>
    </el-radio-group>

    <template v-if="source === 'server'">
      <el-form label-width="80px" class="form">
        <el-form-item label="时间范围">
          <el-date-picker
            v-model="range"
            type="daterange"
            value-format="YYYY-MM-DD"
            range-separator="至"
            start-placeholder="开始"
            end-placeholder="结束"
            :clearable="false"
          />
        </el-form-item>
      </el-form>
      <p class="hint">
        从服务器数据库导出，不占设备流量。一次最长 31 天，CSV，含时间、类型、摘要和位置。
      </p>
    </template>

    <template v-else>
      <el-alert
        type="warning"
        :closable="false"
        show-icon
        title="板子导出会让设备通过移动网络回传"
        class="warn"
      >
        <template #default>
          需要设备在线、信号和网络保持良好，并消耗设备流量；每行最多约 1 KB（DTU
          模板去掉十六进制副本后约 0.6 KB），1 秒 1
          行，条数多时要等很久。中途断电、重启或断网不会续传，需要重新发起。设备只在下次上报时才收到指令。
        </template>
      </el-alert>
      <el-alert
        v-if="!remote"
        type="info"
        :closable="false"
        show-icon
        title="该设备固件低于 1.0.6，不支持读取本机日志"
        class="warn"
      />
      <template v-else>
        <div v-loading="loading" class="state">
          <template v-if="!state || ['cancelled', 'timeout', 'done'].includes(state.state)">
            <p v-if="state?.state === 'done'" class="ok">
              上次回传已完成，共 {{ state.receivedParts }} 段。
            </p>
            <p v-else-if="state?.state === 'timeout'" class="bad">
              上次请求长时间没有进展，已超时。
            </p>
            <div class="row">
              <el-button type="primary" :loading="busy" @click="query">
                查询设备本机日志条数
              </el-button>
              <el-button v-if="state?.state === 'done'" @click="download">下载上次结果</el-button>
            </div>
          </template>
          <template v-else-if="state.state === 'querying'">
            <p>已排队，等设备下次上报时查询条数……</p>
            <el-button @click="cancel">取消</el-button>
          </template>
          <template v-else-if="state.state === 'ready'">
            <p>
              设备约有
              <b>{{ state.total ?? 0 }}</b>
              条本机记录（掉电、上电、开箱等）。
            </p>
            <el-form label-width="90px" class="form">
              <el-form-item label="起始日期">
                <el-date-picker
                  v-model="from"
                  type="date"
                  value-format="YYYY-MM-DD"
                  placeholder="不限（从最早）"
                  clearable
                />
              </el-form-item>
              <el-form-item label="最多条数">
                <el-input-number v-model="max" :min="1" :max="20000" :step="500" />
              </el-form-item>
            </el-form>
            <p class="hint">
              按最多 {{ planned }} 条估算：约 {{ lines }} 行、{{ kb }}，耗时约
              {{ minutes }} 分钟。条数以设备实际为准。
            </p>
            <div class="row">
              <el-button type="primary" :loading="busy" @click="confirm">开始回传</el-button>
              <el-button @click="cancel">取消</el-button>
            </div>
          </template>
          <template v-else>
            <p>
              {{
                state.state === "pending"
                  ? "已排队，等设备下次上报时开始回传……"
                  : `回传中：${state.receivedParts} / ${state.parts ?? "?"} 段`
              }}
            </p>
            <el-progress
              v-if="state.parts"
              :percentage="Math.round((state.receivedParts * 100) / state.parts)"
            />
            <el-button @click="cancel">取消</el-button>
          </template>
        </div>
      </template>
    </template>

    <template #footer>
      <el-button @click="open = false">关闭</el-button>
      <el-button v-if="source === 'server'" type="primary" :loading="busy" @click="exportServer">
        导出 CSV
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { ElMessage } from "element-plus";
import SampleBoxAPI, { type DumpState } from "@/api/sample/box";
import { useUserStore } from "@/stores/user";
import { BOX_PERM } from "../data";

const open = defineModel<boolean>({ required: true });
/** remote：服务端给的「设备支持读本机日志」，不靠固件版本号（看不到固件版本的人也能用）。 */
const props = defineProps<{ boxId: string; remote?: boolean }>();
const user = useUserStore();
const allow = (perm: string) => !!user.userInfo.perms?.includes(perm);
const remote = computed(() => Boolean(props.remote));
const source = ref<"server" | "device">("server");
const today = () => new Date().toISOString().slice(0, 10);
const range = ref<[string, string]>([
  new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10),
  today(),
]);
const state = ref<DumpState | null>(null);
const loading = ref(false);
const busy = ref(false);
const from = ref("");
const max = ref(2000);
let timer: ReturnType<typeof setInterval> | undefined;

const planned = computed(() => Math.min(max.value, state.value?.total ?? max.value));
const lines = computed(() => Math.ceil(planned.value / 7));
const kb = computed(() => {
  const bytes = lines.value * 1000;
  return bytes > 1048576
    ? `${(bytes / 1048576).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
});
const minutes = computed(() => Math.max(1, Math.ceil(lines.value / 60)));

function save(response: { data: Blob; headers: Record<string, string> }, fallback: string) {
  const matched = String(response.headers["content-disposition"] || "").match(
    /filename\*=UTF-8''([^;]+)/
  );
  const url = URL.createObjectURL(response.data);
  const link = document.createElement("a");
  link.href = url;
  link.download = matched ? decodeURIComponent(matched[1]) : fallback;
  link.click();
  URL.revokeObjectURL(url);
}

function onOpened() {
  source.value = allow(BOX_PERM.logExport) ? "server" : "device";
  if (allow(BOX_PERM.dump) && remote.value) refresh(true);
}
async function refresh(first = false) {
  if (first) loading.value = true;
  try {
    state.value = await SampleBoxAPI.dumpStatus(props.boxId);
    const active = state.value && ["querying", "pending", "running"].includes(state.value.state);
    if (active && !timer) timer = setInterval(() => refresh(), 5000);
    if (!active) stop();
  } catch {
    stop();
  } finally {
    loading.value = false;
  }
}
function stop() {
  if (timer) clearInterval(timer);
  timer = undefined;
}
onBeforeUnmount(stop);

async function exportServer() {
  busy.value = true;
  try {
    save(
      await SampleBoxAPI.exportLogs(props.boxId, { from: range.value[0], to: range.value[1] }),
      `${props.boxId}-上报日志.csv`
    );
  } finally {
    busy.value = false;
  }
}
async function query() {
  busy.value = true;
  try {
    state.value = await SampleBoxAPI.dumpQuery(props.boxId);
    await refresh();
  } finally {
    busy.value = false;
  }
}
async function confirm() {
  if (!state.value) return;
  busy.value = true;
  try {
    const fromSec = from.value
      ? Math.floor(new Date(`${from.value}T00:00:00`).getTime() / 1000)
      : 0;
    state.value = await SampleBoxAPI.dumpConfirm(props.boxId, state.value.id, {
      fromSec,
      max: max.value,
    });
    ElMessage.success("已排队，设备下次上报时开始回传");
    await refresh();
  } finally {
    busy.value = false;
  }
}
async function cancel() {
  if (!state.value) return;
  state.value = await SampleBoxAPI.dumpCancel(props.boxId, state.value.id);
  stop();
}
async function download() {
  if (!state.value) return;
  save(
    await SampleBoxAPI.dumpDownload(props.boxId, state.value.id),
    `${props.boxId}-设备本机日志.csv`
  );
}
</script>

<style scoped>
.source {
  margin-bottom: 14px;
}
.form {
  margin-top: 6px;
}
.warn {
  margin-bottom: 12px;
}
.hint {
  margin: 8px 0 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--el-text-color-secondary);
}
.state {
  min-height: 90px;
}
.row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.ok {
  color: var(--el-color-success);
}
.bad {
  color: var(--el-color-danger);
}
</style>
