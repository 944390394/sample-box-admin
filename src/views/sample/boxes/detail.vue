<template>
  <div class="page-container page-flow">
    <el-skeleton v-if="!box && loading" :rows="8" animated />
    <el-empty v-else-if="!box" :description="error || '采样箱不存在'">
      <el-button @click="router.push('/device/boxes')">回采样箱列表</el-button>
    </el-empty>

    <template v-else>
      <PageHeader :title="box.name || box.id" back="/device/boxes">
        <template #tags>
          <el-tag :type="lifeTone(box.life)">{{ lifeLabel(box.life) }}</el-tag>
          <el-tag v-if="box.wipe" type="danger" effect="dark" :title="wipeTitle(box.wipe)">
            抹除中
          </el-tag>
          <el-tag :type="online ? 'success' : 'info'" effect="plain">
            <span class="dot" :class="online ? 'on' : 'off'" />
            {{ online ? "在线" : "离线" }}
          </el-tag>
        </template>
        <template #meta>
          <span class="mono">IMEI {{ box.id }}</span>
          · {{ box.org || "总公司" }} ·
          {{ box.owner && box.owner !== "—" ? `${box.owner} 保管` : "无保管人" }}
        </template>
        <template #actions>
          <el-button
            v-if="box.life === '待激活' && can(BOX_PERM.activate)"
            type="primary"
            @click="openActivate"
          >
            激活
          </el-button>
          <el-button
            v-if="box.life === '未使用' && TASK_CREATE.some((perm) => can(perm))"
            type="primary"
            plain
            @click="router.push({ path: '/task/create', query: { boxIds: box.id } })"
          >
            创建任务单
          </el-button>
          <el-button
            v-if="can(BOX_PERM.assignOrg) || can(BOX_PERM.assignOwner)"
            @click="assignOpen = true"
          >
            分配
          </el-button>
          <el-button v-if="can(policyPerm.read)" @click="policyOpen = true">上报策略</el-button>
          <el-button @click="qrOpen = true">二维码</el-button>
          <el-dropdown v-if="more.length" trigger="click" @command="onMore">
            <el-button>
              更多
              <el-icon class="el-icon--right"><ArrowDown /></el-icon>
            </el-button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item
                  v-for="item in more"
                  :key="item.cmd"
                  :command="item.cmd"
                  :divided="item.danger"
                  :class="{ 'is-danger': item.danger }"
                >
                  {{ item.label }}
                </el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </template>
      </PageHeader>

      <BoxSummary v-if="box.life !== '待激活'" :box="box" />

      <el-alert v-if="box.alert" type="error" :closable="false" show-icon :title="box.alert" />
      <el-alert
        v-if="box.masked?.length"
        type="info"
        :closable="false"
        :title="`按你的权限，${maskedText}不显示`"
      />

      <el-card v-if="box.life === '待激活'" shadow="never">
        <el-steps :active="activationStep" finish-status="success" align-center>
          <el-step title="设备上电上报" />
          <el-step title="等待激活" />
          <el-step title="密钥已下发" />
          <el-step title="箱子已确认" />
        </el-steps>
        <p class="text-muted center">
          核对箱体上的 IMEI 后点「激活」。激活后箱子下次上线会收到密钥，确认后即可使用。
        </p>
      </el-card>

      <el-card shadow="never" class="tabs-card">
        <el-tabs v-model="tab" @tab-change="onTab">
          <el-tab-pane label="概览" name="overview">
            <BoxOverview :box="box" @tab="(name) => (tab = name)" />
          </el-tab-pane>
          <el-tab-pane
            v-if="can(BOX_PERM.track) || (can(BOX_PERM.task) && can(BOX_PERM.location))"
            label="轨迹"
            name="track"
            lazy
          >
            <BoxTrack :box="box" />
          </el-tab-pane>
          <el-tab-pane v-if="EVENT_PERMS.some((perm) => can(perm))" label="事件" name="event" lazy>
            <UplinkLog :load="loadLogs" events-only />
          </el-tab-pane>
          <el-tab-pane v-if="can(BOX_PERM.task)" label="任务" name="task" lazy>
            <BoxTasks :box-id="box.id" />
          </el-tab-pane>
          <el-tab-pane v-if="can(BOX_PERM.log)" label="上报记录" name="log" lazy>
            <UplinkLog :load="loadLogs" :load-raw="loadRaw">
              <template #actions>
                <el-button
                  v-if="can(BOX_PERM.logExport) || can(BOX_PERM.dump)"
                  size="small"
                  @click="exportOpen = true"
                >
                  导出
                </el-button>
              </template>
            </UplinkLog>
          </el-tab-pane>
          <el-tab-pane label="设备" name="info" lazy>
            <BoxInfo :box="box" />
          </el-tab-pane>
        </el-tabs>
      </el-card>
    </template>

    <el-dialog v-model="activate.open" title="激活采样箱" width="460px" style="max-width: 94vw">
      <p v-if="box" class="lead">IMEI {{ box.id }}</p>
      <p class="text-muted">
        核对箱体上贴的 IMEI 后确认。激活后状态变为{{ lifeLabel("未使用") }}，所属总公司。
      </p>
      <el-input
        v-if="can(BOX_PERM.rename)"
        v-model="activate.name"
        maxlength="32"
        show-word-limit
        :placeholder="`名称（选填），不填用：${box?.name || ''}`"
        @keyup.enter="doActivate"
      />
      <template #footer>
        <el-button @click="activate.open = false">取消</el-button>
        <el-button type="primary" :loading="activate.busy" @click="doActivate">确认激活</el-button>
      </template>
    </el-dialog>

    <AssignDialog v-if="box" v-model="assignOpen" :box="box" @saved="load" />
    <ReportPolicyDialog
      v-if="box"
      v-model="policyOpen"
      :box-id="box.id"
      :box-name="box.name"
      @saved="load"
    />
    <LogExportDialog
      v-if="box"
      v-model="exportOpen"
      :box-id="box.id"
      :remote="Boolean(box.remote)"
    />
    <BoxQrDialog v-if="box" v-model="qrOpen" :box="box" />
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: "SampleBoxDetail" });

import { ArrowDown } from "@element-plus/icons-vue";
import SampleBoxAPI, { type BoxLogItem } from "@/api/sample/box";
import { policyPerm } from "@/api/sample/report-policy";
import PageHeader from "@/components/biz/PageHeader.vue";
import UplinkLog, { type UplinkLoadParams } from "@/components/biz/UplinkLog.vue";
import { usePerm } from "@/composables/usePerm";
import { lifeLabel } from "@/utils/labels";
import { clock } from "@/utils/time";
import { lifeTone } from "@/utils/tone";
import AssignDialog from "./AssignDialog.vue";
import BoxInfo from "./BoxInfo.vue";
import BoxOverview from "./BoxOverview.vue";
import BoxTasks from "./BoxTasks.vue";
import BoxTrack from "./BoxTrack.vue";
import LogExportDialog from "./LogExportDialog.vue";
import BoxQrDialog from "./BoxQrDialog.vue";
import BoxSummary from "./BoxSummary.vue";
import ReportPolicyDialog from "./ReportPolicyDialog.vue";
import { deleteArchive, wipeTitle } from "./management";
import { telemetryState } from "./telemetry";
import { BOX_PERM, EVENT_PERMS, TASK_CREATE, type SampleBox } from "../data";

/**
 * 采样箱详情：页头放名称、状态和常用操作，下面一条状态条（电量、箱盖、信号、最近上报、位置）切换标签也一直在；
 * 内容分标签页——概览、轨迹、事件、任务、上报记录（原文，要权限）、设备。
 * 标签页写在地址栏 ?tab=，旧的调试记录页会跳到「上报记录」。10 秒刷新一次。
 */
const route = useRoute();
const router = useRouter();
const can = usePerm();
const box = ref<SampleBox | null>(null);
const loading = ref(false);
const error = ref("");
// 在线状态跟全站时钟走：超过 3 个上报周期没报，到点就变离线，不等下次刷新
const now = clock;
const tab = ref(String(route.query.tab || "overview"));
const assignOpen = ref(false);
const policyOpen = ref(false);
const exportOpen = ref(false);
const qrOpen = ref(false);

const online = computed(() =>
  box.value ? telemetryState(box.value.last, box.value.reportPeriodSec, now.value).online : false
);
const maskedText = computed(() => {
  const names: Record<string, string> = {
    status: "电量和箱盖",
    location: "位置",
    identity: "SIM 卡和固件信息",
  };
  return (box.value?.masked || []).map((key) => names[key] || key).join("、");
});
const activationStep = computed(() => {
  const step = box.value?.activateStep;
  if (step === "已确认") return 4;
  if (step === "待设备确认") return 2;
  return 1;
});

async function load() {
  const id = String(route.params.id || "");
  if (!id) return;
  loading.value = !box.value;
  try {
    const next = await SampleBoxAPI.detail(encodeURIComponent(id));
    box.value = next;
    error.value = "";
    // 旧链接按名称（BOX-004）打开的，换成编号地址
    if (next.id !== id)
      void router.replace({
        path: `/device/boxes/${encodeURIComponent(next.id)}`,
        query: route.query,
      });
  } catch (e) {
    if (!box.value) error.value = e instanceof Error ? e.message : "";
  } finally {
    loading.value = false;
  }
}

function onTab(name: string | number) {
  void router.replace({ query: { ...route.query, tab: String(name) } });
}

const loadLogs = (params: UplinkLoadParams) => SampleBoxAPI.logs(box.value!.id, params);
const loadRaw = async (item: BoxLogItem) =>
  (await SampleBoxAPI.raw(box.value!.id, item.id || "", item.time)).raw;

interface MoreItem {
  cmd: string;
  label: string;
  danger?: boolean;
}
const more = computed<MoreItem[]>(() => {
  const b = box.value;
  if (!b) return [];
  const list: MoreItem[] = [];
  if (can(BOX_PERM.rename)) list.push({ cmd: "rename", label: "改名称" });
  if (b.life === "未使用" && can(BOX_PERM.disable)) list.push({ cmd: "disable", label: "停用" });
  if (b.life === "停用" && can(BOX_PERM.enable)) list.push({ cmd: "restore", label: "恢复使用" });
  if (["未使用", "停用"].includes(b.life) && can(BOX_PERM.delete))
    list.push({ cmd: "delete", label: "删除档案", danger: true });
  return list;
});
async function onMore(cmd: string) {
  const b = box.value;
  if (!b) return;
  if (cmd === "rename") {
    try {
      const { value } = await ElMessageBox.prompt("1–32 个字，不能和别的采样箱重名", "改名称", {
        inputValue: b.name,
        inputValidator: (text: string) =>
          (text.trim().length >= 1 && text.trim().length <= 32) || "名称要 1–32 个字",
        confirmButtonText: "保存",
        cancelButtonText: "取消",
      });
      box.value = await SampleBoxAPI.rename(b.id, value.trim());
      ElMessage.success("已改名");
    } catch {
      /* 取消 */
    }
  } else if (cmd === "disable" || cmd === "restore") {
    const verb = cmd === "disable" ? "停用" : "恢复使用";
    try {
      await ElMessageBox.confirm(
        cmd === "disable"
          ? "停用后不能被任务选中，可以随时恢复。"
          : `恢复后回到${lifeLabel("未使用")}状态。`,
        `${verb}采样箱`,
        { type: "warning", confirmButtonText: verb, cancelButtonText: "取消" }
      );
    } catch {
      return;
    }
    box.value = await (cmd === "disable" ? SampleBoxAPI.disable(b.id) : SampleBoxAPI.restore(b.id));
    ElMessage.success(`已${verb}`);
  } else if (cmd === "delete") {
    if (
      await deleteArchive(
        b.id,
        Boolean(b.remote) && can(BOX_PERM.wipe),
        Boolean(b.wipe),
        b.name || b.id
      )
    ) {
      if (b.firmware && b.wipe == null) void router.push("/device/boxes");
      else await load();
    }
  }
}

const activate = reactive({ open: false, busy: false, name: "" });
function openActivate() {
  Object.assign(activate, { open: true, busy: false, name: "" });
}
async function doActivate() {
  if (!box.value) return;
  activate.busy = true;
  try {
    box.value = await SampleBoxAPI.activate(box.value.id, activate.name.trim());
    ElMessage.success("已激活");
    activate.open = false;
  } finally {
    activate.busy = false;
  }
}

let poll = 0;
watch(
  () => route.params.id,
  (id) => {
    if (id && route.path.startsWith("/device/boxes/")) {
      box.value = null;
      void load();
    }
  }
);
onMounted(() => {
  void load();
  poll = window.setInterval(() => void load(), 10000);
});
onBeforeUnmount(() => window.clearInterval(poll));
</script>

<style scoped>
.dot {
  display: inline-block;
  width: 7px;
  height: 7px;
  margin-right: 5px;
  vertical-align: 1px;
  border-radius: 50%;
}
.dot.on {
  background: var(--el-color-success);
}
.dot.off {
  background: var(--el-text-color-placeholder);
}
.center {
  margin: 12px 0 0;
  text-align: center;
}
.lead {
  margin: 0 0 6px;
  font-weight: 600;
}
.tabs-card :deep(.el-card__body) {
  padding: 4px 16px 16px;
}
.tabs-card :deep(.el-tabs__header) {
  margin-bottom: 16px;
}
.tabs-card :deep(.el-tabs__item) {
  height: 44px;
  font-size: 14px;
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12.5px;
}
:deep(.is-danger) {
  color: var(--el-color-danger);
}
</style>
