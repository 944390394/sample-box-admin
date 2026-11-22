<template>
  <div class="page-container page-flow">
    <PageHeader
      :title="`${greeting}，${userStore.userInfo.nickname || userStore.userInfo.username || ''}`"
      :subtitle="subtitle"
    >
      <template #actions>
        <el-button :icon="Refresh" :loading="loading" @click="load">刷新</el-button>
        <el-button
          v-if="can(BOX_PERM.overview)"
          :icon="DataBoard"
          @click="router.push('/monitor/overview')"
        >
          总览
        </el-button>
        <el-button
          v-if="can(BOX_PERM.list)"
          :icon="MapLocation"
          @click="router.push('/monitor/screen')"
        >
          实时地图
        </el-button>
        <el-button
          v-if="TASK_CREATE.some((perm) => can(perm))"
          type="primary"
          :icon="Plus"
          @click="router.push('/task/create')"
        >
          创建任务单
        </el-button>
        <el-button
          v-if="enableTransferInspect && can(TRANSFER_CREATE)"
          :icon="Plus"
          @click="router.push('/sample/transfers')"
        >
          批量划拨
        </el-button>
      </template>
    </PageHeader>

    <el-skeleton v-if="!data && loading" :rows="6" animated />
    <template v-else-if="data">
      <div v-if="tiles.length" class="home-tiles">
        <StatTiles :items="tiles" :max="6" muted-zero @update:model-value="openTile" />
      </div>

      <el-row :gutter="12">
        <el-col :lg="16" :span="24">
          <section class="block">
            <div class="card-head section-head">
              <span class="card-head__title">待我处理</span>
              <span class="text-muted">
                {{ todoTotal ? `共 ${todoTotal} 件` : "暂时没有要你处理的事" }}
              </span>
            </div>
            <div v-if="activeCards.length" class="cards">
              <template v-for="card in activeCards" :key="card.key">
                <TodoCard
                  v-if="card.tasks"
                  :title="card.title"
                  :hint="card.hint"
                  :tone="card.tone"
                  :bucket="card.tasks"
                  more
                  @open="(id) => router.push(`/task/detail/${id}`)"
                  @more="router.push(card.more)"
                >
                  <template #default="{ item }">
                    <div class="line">
                      <b>{{ item.name }}</b>
                      <el-tag size="small" :type="taskTone(item.status)">{{ item.status }}</el-tag>
                    </div>
                    <div class="text-muted">
                      {{ routeOf(item) }} · {{ item.boxes }} 台 ·
                      <TimeText :value="item.createdAt" />
                    </div>
                  </template>
                </TodoCard>
              </template>
            </div>
            <div v-else class="todo-empty">
              <el-empty :image-size="64" description="都处理完了">
                <div class="todo-empty__actions">
                  <el-button
                    v-if="TASK_CREATE.some((perm) => can(perm))"
                    type="primary"
                    :icon="Plus"
                    @click="router.push('/task/create')"
                  >
                    创建任务单
                  </el-button>
                  <el-button
                    v-if="can(BOX_PERM.list)"
                    :icon="Box"
                    @click="router.push('/device/boxes')"
                  >
                    去看采样箱
                  </el-button>
                </div>
              </el-empty>
            </div>
            <div v-if="activeCards.length && quietCards.length" class="quiet-row">
              <button
                type="button"
                class="quiet-chip"
                :aria-expanded="quietOpen"
                @click="quietOpen = !quietOpen"
              >
                其余 {{ quietCards.length }} 类待办为 0
                <el-icon class="quiet-chip__arrow" :class="{ open: quietOpen }">
                  <ArrowDown />
                </el-icon>
              </button>
              <ul v-if="quietOpen" class="quiet-list">
                <li v-for="card in quietCards" :key="card.key">
                  {{ card.title }}
                  <b>0</b>
                </li>
              </ul>
            </div>
            <div v-if="footerLinks.length" class="todo-footer">
              <button
                v-for="link in footerLinks"
                :key="link.key"
                type="button"
                class="todo-footer__link"
                @click="router.push(link.to)"
              >
                <el-icon :size="14"><component :is="link.icon" /></el-icon>
                {{ link.label }}
              </button>
            </div>
          </section>

          <!-- #75：提醒区——监控信号类卡（低电量/告警/离线/开着盖/待激活/开箱超限），与「待我处理」同级；
               不是待办，去掉待办红顶、语义色走 warning/info 系；零条整区隐藏。落地链接沿用现状（行数==卡数）。 -->
          <section v-if="activeReminders.length" class="block reminder-block">
            <div class="card-head section-head">
              <span class="card-head__title">提醒</span>
              <span class="reminder-total">共 {{ reminderTotal }} 条</span>
            </div>
            <div class="cards reminder-cards">
              <template v-for="card in activeReminders" :key="card.key">
                <TodoCard
                  v-if="card.boxes"
                  :title="card.title"
                  :hint="card.hint"
                  :bucket="card.boxes"
                  :class="`reminder-${reminderAccent(card.key)}`"
                  more
                  @open="(id) => router.push(`/device/boxes/${id}`)"
                  @more="router.push(card.more)"
                >
                  <template #default="{ item }">
                    <div class="line">
                      <b>{{ item.name }}</b>
                      <span class="text-muted">{{ item.org || "总公司" }}</span>
                    </div>
                    <div class="text-muted">{{ boxLine(item, card.key) }}</div>
                  </template>
                </TodoCard>
                <TodoCard
                  v-else-if="card.tasks"
                  :title="card.title"
                  :hint="card.hint"
                  :bucket="card.tasks"
                  :class="`reminder-${reminderAccent(card.key)}`"
                  more
                  @open="(id) => router.push(`/task/detail/${id}`)"
                  @more="router.push(card.more)"
                >
                  <template #default="{ item }">
                    <div class="line">
                      <b>{{ item.name }}</b>
                      <el-tag size="small" :type="taskTone(item.status)">{{ item.status }}</el-tag>
                    </div>
                    <div class="text-muted">
                      {{ routeOf(item) }} · {{ item.boxes }} 台 ·
                      <TimeText :value="item.createdAt" />
                    </div>
                  </template>
                </TodoCard>
              </template>
            </div>
          </section>

          <section v-if="showField" class="block">
            <div class="card-head section-head">
              <span class="card-head__title">我手上的</span>
            </div>
            <div class="cards two">
              <TodoCard
                v-if="data.myBoxes"
                title="我保管的箱子"
                :bucket="data.myBoxes"
                tone="success"
                @open="(id) => router.push(`/device/boxes/${id}`)"
              >
                <template #default="{ item }">
                  <div class="line">
                    <b>{{ item.name }}</b>
                    <!-- R23/D5：「任务中」标签＝链接 → 箱子详情·任务段（?tab=task）；其余生命周期仍普通标签 -->
                    <el-tag
                      v-if="item.life === '在途'"
                      size="small"
                      :type="lifeTone(item.life)"
                      class="box-task-link"
                      title="跳箱子详情的任务段"
                      @click.stop="openBoxTaskTab(item.id)"
                    >
                      {{ lifeLabel(item.life) }} →
                    </el-tag>
                    <el-tag v-else size="small" :type="lifeTone(item.life)">
                      {{ lifeLabel(item.life) }}
                    </el-tag>
                  </div>
                  <div class="text-muted">{{ boxLine(item, "mine") }}</div>
                  <!-- 行内推进入口：仅服务端 actions 命中才显示；跳任务详情任务段复用既有推进弹窗 -->
                  <div v-if="boxRowActions(item.id).length" class="box-row-ops">
                    <el-button
                      v-for="act in boxRowActions(item.id)"
                      :key="act.to"
                      size="small"
                      type="primary"
                      @click.stop="openTaskProgress(act.taskId)"
                    >
                      {{ act.label }}
                    </el-button>
                  </div>
                </template>
              </TodoCard>
              <TodoCard
                v-if="data.taskTodo?.mine"
                title="我经手的任务"
                :bucket="data.taskTodo.mine"
                tone="primary"
                @open="(id) => router.push(`/task/detail/${id}`)"
              >
                <template #default="{ item }">
                  <div class="line">
                    <b>{{ item.name }}</b>
                    <el-tag size="small" :type="taskTone(item.status)">{{ item.status }}</el-tag>
                  </div>
                  <div class="text-muted">{{ routeOf(item) }}</div>
                </template>
              </TodoCard>
            </div>
          </section>
        </el-col>

        <el-col :lg="8" :span="24">
          <el-card shadow="never" class="feed-card">
            <template #header>
              <div class="card-head">
                <span class="card-head__title">最近动态</span>
                <span class="feed-head__side">
                  <span class="text-muted">任务流转和开关箱</span>
                  <el-button
                    v-if="can(OPLOG_READ)"
                    link
                    type="primary"
                    size="small"
                    @click="router.push('/system/operation-log')"
                  >
                    查看全部
                  </el-button>
                </span>
              </div>
            </template>
            <div class="feed-scroll">
              <template v-if="feedGroups.length">
                <section v-for="group in feedGroups" :key="group.key" class="feed-group">
                  <h4 class="feed-day">{{ group.label }}</h4>
                  <ul class="feed">
                    <li v-for="(item, index) in group.items" :key="index" @click="openFeed(item)">
                      <span
                        class="icon"
                        :class="item.type === 'task' ? 'is-task' : `is-${item.kind}`"
                      >
                        <el-icon>
                          <component
                            :is="
                              item.type === 'task'
                                ? Promotion
                                : item.kind === 'pad'
                                  ? Unlock
                                  : item.kind === 'shut'
                                    ? Lock
                                    : SwitchButton
                            "
                          />
                        </el-icon>
                      </span>
                      <div class="body">
                        <div class="line">
                          <b v-if="item.type === 'task'">{{ item.action }} · {{ item.taskName }}</b>
                          <b v-else>{{ item.boxName }} {{ item.action }}</b>
                          <TimeText class="time" :value="item.time" />
                        </div>
                        <div v-if="item.type === 'task'" class="text-muted">
                          {{ item.by }}
                          <template v-if="item.note">· {{ item.note }}</template>
                        </div>
                        <div v-else-if="(item.count || 1) > 1 && item.since" class="text-muted">
                          最早
                          <TimeText :value="item.since" />
                          · 点开看全部事件
                        </div>
                      </div>
                    </li>
                  </ul>
                </section>
                <div v-if="feedRest" class="feed-more">
                  <el-button link type="primary" @click="feedShown += 20">
                    加载更多（还有 {{ feedRest }} 条）
                  </el-button>
                </div>
              </template>
              <el-empty v-else :image-size="56" description="最近没有动态" />
            </div>
          </el-card>
        </el-col>
      </el-row>
    </template>
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: "SampleHome" });

import {
  ArrowDown,
  Box,
  DataBoard,
  Document,
  Lock,
  MapLocation,
  Plus,
  Promotion,
  Refresh,
  Switch,
  SwitchButton,
  Unlock,
} from "@element-plus/icons-vue";
import type { Component } from "vue";
import WorkbenchAPI, {
  type BoxBrief,
  type Bucket,
  type FeedItem,
  type TaskBrief,
  type Workbench,
} from "@/api/sample/workbench";
import SampleBoxAPI from "@/api/sample/box";
import PolicyAPI, { type PolicyTask } from "@/api/sample/report-policy";
import PageHeader from "@/components/biz/PageHeader.vue";
import StatTiles, { type StatTile } from "@/components/biz/StatTiles.vue";
import TimeText from "@/components/biz/TimeText.vue";
import { usePerm } from "@/composables/usePerm";
import { useBoxFeatures } from "@/composables/useBoxFeatures";
import { useUserStore } from "@/stores/user";
import { lifeLabel } from "@/utils/labels";
import { ago, clock, toDate } from "@/utils/time";
import { lifeTone, taskTone } from "@/utils/tone";
import { BOX_PERM, TASK_CREATE, TRANSFER_CREATE } from "../data";
import { graceHint, graceState } from "../boxes/grace";
import { TASK_ACTIONS } from "../tasks/status";
import TodoCard from "./TodoCard.vue";

/**
 * 工作台：一页看「要我处理什么」。
 * 每张卡片单独授权（角色页「工作台」模块），勾了且有看里面内容的权限才显示；
 * 有数量的卡片在前，零组折成一枚 chip（点开看明细），全零时给引导空态。30 秒刷新一次。
 * 呈现约定（数据口径不变）：KPI 零值降权、整卡可点跳筛选列表；待办区块底部是一行 ghost
 * 快捷链接 footer（与区块同体，不再独立横条）；最近动态限高内滚、按日分组、默认 20 条＋加载更多。
 */
const router = useRouter();
const can = usePerm();
const userStore = useUserStore();
const { enableTransferInspect, taskOfflineGraceSec, loadBoxFeatures } = useBoxFeatures();
const data = ref<Workbench | null>(null);
const loading = ref(false);
const updatedAt = ref<Date | null>(null);
/**
 * R23/D5（#66）：我保管的箱子行内「开始采样／封箱」入口。
 * 显隐完全由服务端 actions 决定（与任务单列表/详情同一口径）：拉 mine=1&bucket=sampling
 * （与工作台采样待办卡同谓词同窗口），按 boxIds 映射到箱子行；仅本人保管＋参与方＋对应权限码
 * 三者同时满足服务端才回 action，前端不自造动作。无任务单权限或拉取失败时为空＝不显示按钮。
 * 点按钮跳任务详情任务段深链 ?tab=task（复用详情页既有推进弹窗与原因校验），不在首页自造弹窗。
 */
const sampleTaskByBox = ref<Map<string, PolicyTask>>(new Map());
const SAMPLER_ROW_ACTIONS = ["采样中", "已封箱"] as const;
function boxRowActions(boxId: string) {
  const task = sampleTaskByBox.value.get(boxId);
  if (!task?.actions?.length) return [];
  return SAMPLER_ROW_ACTIONS.filter((to) => task.actions!.includes(to)).map((to) => ({
    to,
    label: TASK_ACTIONS[to] || to,
    taskId: task.id,
  }));
}
function openBoxTaskTab(boxId: string) {
  void router.push({ path: `/device/boxes/${boxId}`, query: { tab: "task" } });
}
function openTaskProgress(taskId: string) {
  void router.push({ path: `/task/detail/${taskId}`, query: { tab: "task" } });
}
async function loadSampleActions() {
  if (!can(BOX_PERM.task)) {
    sampleTaskByBox.value = new Map();
    return;
  }
  try {
    const page = await PolicyAPI.tasks({ mine: "1", bucket: "sampling", pageSize: 100 });
    const map = new Map<string, PolicyTask>();
    for (const task of page.list || [])
      for (const boxId of task.boxIds || []) if (!map.has(boxId)) map.set(boxId, task);
    sampleTaskByBox.value = map;
  } catch {
    /* 拉取失败不显示行内按钮（fail-closed），不影响工作台主体 */
    sampleTaskByBox.value = new Map();
  }
}

/** 操作日志页的门禁码，与侧栏菜单（server/menus.js）同一项。 */
const OPLOG_READ = "sys:oplog:read";

const greeting = computed(() => {
  const hour = new Date().getHours();
  return hour < 6
    ? "夜深了"
    : hour < 11
      ? "早上好"
      : hour < 13
        ? "中午好"
        : hour < 18
          ? "下午好"
          : "晚上好";
});
const subtitle = computed(() =>
  updatedAt.value
    ? `数据更新于 ${updatedAt.value.toTimeString().slice(0, 5)}，每 30 秒自动刷新`
    : "正在读取…"
);

const tiles = computed<StatTile[]>(() => {
  const stats = data.value?.stats;
  const tasks = data.value?.taskTodo;
  if (!stats) return [];
  const list: StatTile[] = [
    {
      key: "life:在途",
      label: lifeLabel("在途"),
      value: stats.counts["在途"] ?? 0,
      tone: "primary",
      title: can(BOX_PERM.task) ? "点击查看进行中的任务单" : "点击查看任务中的采样箱",
    },
    {
      key: "life:未使用",
      label: lifeLabel("未使用"),
      value: stats.counts["未使用"] ?? 0,
      tone: "success",
      title: "点击查看未使用的采样箱",
    },
    {
      key: "flag:offline",
      label: "离线",
      value: stats.flags.offline ?? 0,
      tone: stats.flags.offline ? "warning" : "default",
      title: "点击查看离线的采样箱",
    },
  ];
  if (stats.flags.low != null)
    list.push({
      key: "flag:low",
      label: "低电量",
      value: stats.flags.low ?? 0,
      tone: stats.flags.low ? "danger" : "default",
      title: "点击查看低电量的采样箱",
    });
  list.push({
    key: "flag:alert",
    label: "告警",
    value: stats.flags.alert ?? 0,
    tone: stats.flags.alert ? "danger" : "default",
    title: "点击查看告警的采样箱",
  });
  if (tasks?.moving)
    list.push({
      key: "task:moving",
      label: "运送中的任务",
      value: tasks.moving.total,
      tone: "primary",
      title: "点击查看运送中的任务单",
    });
  return list;
});
function openTile(key: string) {
  if (!key) return;
  // 运送中的任务 → 任务单「在途」页签（合并单的运送阶段；该卡有数据即说明有任务单权限）
  if (key === "task:moving") {
    void router.push({ path: "/task/tasks", query: { status: "在途" } });
    return;
  }
  // 任务中 → 任务单「进行中」页签；没有任务单权限的角色回落箱子筛选（旧口径，路由按权限注册）
  if (key === "life:在途" && can(BOX_PERM.task)) {
    void router.push({ path: "/task/tasks", query: { status: "进行中" } });
    return;
  }
  void router.push({ path: "/device/boxes", query: { tile: key } });
}

interface Card {
  key: string;
  title: string;
  hint?: string;
  tone: "primary" | "warning" | "danger" | "success";
  tasks?: Bucket<TaskBrief>;
  boxes?: Bucket<BoxBrief>;
  more: string | { path: string; query?: Record<string, string> };
}
/**
 * 卡片：每张单独授权（monitor:card:*）。服务端只给勾了的卡片数据，这里按固定顺序排：
 * 先任务流转（寄出 → 到达 → 签收 → 接收退回 → 采样 → 检测 → 超限），再箱子（待激活、告警、离线、低电、开盖）。
 */
/**
 * D-1（#81）：划拨两桶（transferAccept 接收方待接受／transferCancel 创建方可取消）服务端 todo 已下发，
 * workbench 类型未列这两键（类型文件不在本批文件面），局部拓宽按可选桶读；
 * 旧服务端无键＝undefined＝零条隐藏，沿用现状口径。两桶不做 monitor:card:* 门控（服务端 CARD_OF 未列）。
 */
type TransferTodoBuckets = {
  transferAccept?: Bucket<TaskBrief>;
  transferCancel?: Bucket<TaskBrief>;
};
const cards = computed<Card[]>(() => {
  const d = data.value;
  if (!d) return [];
  const list: Card[] = [];
  const t = d.taskTodo as (NonNullable<Workbench["taskTodo"]> & TransferTodoBuckets) | null;
  // D1（R22 批2）：一卡一筛——more 带 mine=1＋bucket，落地行数==卡片数字（服务端 bucketsOf 与 todo 同谓词）。
  const bucketMore = (bucket: string) => ({
    path: "/task/tasks",
    query: { mine: "1", bucket },
  });
  const push = (
    card: Omit<Card, "tasks" | "boxes">,
    bucket?: Bucket<TaskBrief> | Bucket<BoxBrief>,
    boxes = false
  ) => {
    if (bucket)
      list.push(
        boxes
          ? { ...card, boxes: bucket as Bucket<BoxBrief> }
          : { ...card, tasks: bucket as Bucket<TaskBrief> }
      );
  };
  if (t) {
    push(
      {
        key: "send",
        title: "待寄出",
        hint: "箱子装好后点「确认寄出」",
        tone: "primary",
        more: bucketMore("send"),
      },
      t.send
    );
    push(
      {
        key: "arrive",
        title: "待确认到达",
        hint: "箱子到了收货地址后确认",
        tone: "primary",
        more: bucketMore("arrive"),
      },
      t.arrive
    );
    push(
      {
        key: "sign",
        title: "待签收",
        hint: "扫箱码做签收核验",
        tone: "warning",
        more: bucketMore("sign"),
      },
      t.sign
    );
    push(
      {
        key: "returning",
        title: "待接收退回",
        hint: "被拒收、正退回本单位的箱子，到了以后扫码接收",
        tone: "warning",
        more: bucketMore("returning"),
      },
      t.returning
    );
    push(
      {
        key: "sampling",
        title: "采样待推进",
        hint: "开始采样、封箱、寄检测站",
        tone: "primary",
        more: bucketMore("sampling"),
      },
      t.sampling
    );
    push(
      {
        key: "inspect",
        title: "待检测",
        hint: "开箱检测时扫箱码点「开始检测」",
        tone: "warning",
        more: { path: "/task/tasks", query: { status: "待检测" } },
      },
      t.inspect
    );
    // D-1（#81）：划拨两卡（R25 三态），label 与 mp 统一「划拨待接受/划拨可取消」，顺序同 mp GROUPS。
    // 计数取 workbench 两桶；more 走任务页桶深链（mine=1&bucket=…，与 todo 共用 bucketsOf 谓词＋同窗口，
    // 落地行数==卡片数字；调拨页「待接受」页签是全局视图、不按我的接受/取消能力收窄，故选桶路径）。
    // 零条隐藏/零组折叠沿用现状口径；提醒区不动。
    push(
      {
        key: "transferAccept",
        title: "划拨待接受",
        hint: "你是目标方：接受后箱子归属转移，拒收需填原因",
        tone: "warning",
        more: bucketMore("transferAccept"),
      },
      t.transferAccept
    );
    push(
      {
        key: "transferCancel",
        title: "划拨可取消",
        hint: "你创建的划拨单还没被接受，可取消（箱不动）",
        tone: "primary",
        more: bucketMore("transferCancel"),
      },
      t.transferCancel
    );
    push(
      {
        key: "overLimit",
        title: "开箱超限",
        hint: "任务期间开箱次数超过上限",
        tone: "danger",
        // 超限桶不按 actionable 过滤（todo.overLimit 含只能取消的单），故不带 mine=1，落地行数==卡片数字
        more: { path: "/task/tasks", query: { bucket: "overLimit" } },
      },
      t.overLimit
    );
  }
  const b = d.boxTodo;
  push(
    {
      key: "pending",
      title: "待激活",
      hint: "新设备上电后自动建档，核对 IMEI 后激活",
      tone: "warning",
      more: { path: "/device/boxes", query: { tile: "life:待激活" } },
    },
    b.pending,
    true
  );
  push(
    {
      key: "alert",
      title: "告警",
      tone: "danger",
      more: { path: "/device/boxes", query: { tile: "flag:alert" } },
    },
    b.alert,
    true
  );
  push(
    {
      key: "offline",
      title: "离线",
      hint: `超过 3 个上报周期未上报 · ${graceHint(taskOfflineGraceSec.value)}`,
      tone: "warning",
      more: { path: "/device/boxes", query: { tile: "flag:offline" } },
    },
    b.offline,
    true
  );
  push(
    {
      key: "low",
      title: "低电量",
      hint: "可用电量低于 20%",
      tone: "danger",
      more: { path: "/device/boxes", query: { tile: "flag:low" } },
    },
    b.low,
    true
  );
  push(
    {
      key: "lid",
      title: "开着盖",
      tone: "warning",
      more: { path: "/device/boxes", query: { tile: "flag:lid" } },
    },
    b.lid,
    true
  );
  return list;
});
const totalOf = (card: Card) => card.tasks?.total ?? card.boxes?.total ?? 0;
/**
 * #75：监控信号类卡归「提醒」区，与「待我处理」的可推进任务动作桶分开（用户：系统管理员下低电量等应是提醒不是待处理）。
 * 归类以现状卡清单为准：箱子状态信号 pending 待激活 / alert 告警 / offline 离线 / low 低电量 / lid 开着盖，
 * 加上任务侧的开箱超限 overLimit（含只能取消的单、非可推进动作）——共 6 类入提醒；
 * 待我处理仅留 send/arrive/sign/returning/sampling/inspect 六个任务动作桶（R22 bucket 链接与 mine 口径不动）。
 */
const REMINDER_KEYS = new Set(["pending", "alert", "offline", "low", "lid", "overLimit"]);
/** 提醒卡语义色（落在数字与标题点，不再用待办红顶）：低电量/开箱超限/开着盖 warning、离线/待激活 info、告警 danger（提醒语义）。 */
const REMINDER_ACCENT: Record<string, "warning" | "danger" | "info"> = {
  low: "warning",
  alert: "danger",
  offline: "info",
  overLimit: "warning",
  lid: "warning",
  pending: "info",
};
const reminderAccent = (key: string) => REMINDER_ACCENT[key] || "info";
/** 提醒按严重度排：danger→warning→info（同级保持现状顺序），强信号（告警/低电量）排首行。 */
const REMINDER_SEVERITY: Record<"warning" | "danger" | "info", number> = {
  danger: 0,
  warning: 1,
  info: 2,
};
const activeAll = computed(() => cards.value.filter((card) => totalOf(card) > 0));
const quietAll = computed(() => cards.value.filter((card) => totalOf(card) === 0));
/** 待我处理：仅可推进的任务动作桶（非零）；零组折叠 chip 与全零空态沿用 R12。 */
const activeCards = computed(() => activeAll.value.filter((card) => !REMINDER_KEYS.has(card.key)));
const quietCards = computed(() => quietAll.value.filter((card) => !REMINDER_KEYS.has(card.key)));
/** 提醒：监控信号类非零卡，按严重度排；零条整区隐藏（v-if activeReminders.length）。 */
const activeReminders = computed(() =>
  activeAll.value
    .filter((card) => REMINDER_KEYS.has(card.key))
    .sort(
      (a, b) => REMINDER_SEVERITY[reminderAccent(a.key)] - REMINDER_SEVERITY[reminderAccent(b.key)]
    )
);
const reminderTotal = computed(() =>
  activeReminders.value.reduce((n, card) => n + totalOf(card), 0)
);
const todoTotal = computed(() => activeCards.value.reduce((n, card) => n + totalOf(card), 0));
/** 零组明细的展开状态：默认收起，点 chip 展开/再点收起。 */
const quietOpen = ref(false);
const showField = computed(() => {
  const d = data.value;
  if (!d) return false;
  // 只在手上真有箱子或任务时显示，空的不占地方
  return Boolean(d.myBoxes?.total) || Boolean(d.taskTodo?.mine?.total);
});

/**
 * 快捷入口：待我处理区块底部的 footer 链接（今日寄出/签收/开箱/退回没有可靠的现有数据源，
 * workbench 无今日计数、feed 截断且折叠事件无法按日拆分，按规格回退为入口，不新增后端接口）。
 * gating 与页头/侧栏菜单一致：上报记录页按「采样箱列表」权限（server/menus.js）。
 */
interface QuickLink {
  key: string;
  label: string;
  icon: Component;
  to: string;
}
const quickLinks = computed<QuickLink[]>(() => {
  const links: QuickLink[] = [];
  if (TASK_CREATE.some((perm) => can(perm)))
    links.push({ key: "create", label: "创建任务单", icon: Plus, to: "/task/create" });
  if (enableTransferInspect.value && can(TRANSFER_CREATE))
    links.push({ key: "transfer", label: "批量划拨", icon: Switch, to: "/sample/transfers" });
  if (can(BOX_PERM.list)) {
    links.push({ key: "screen", label: "实时地图", icon: MapLocation, to: "/monitor/screen" });
    links.push({ key: "reports", label: "上报记录", icon: Document, to: "/monitor/reports" });
  }
  return links;
});
/** footer 实显链接：全零空态的引导卡已有「创建任务单」按钮（同 gating），footer 去掉创建项避免重复。 */
const footerLinks = computed(() =>
  activeCards.value.length
    ? quickLinks.value
    : quickLinks.value.filter((link) => link.key !== "create")
);

/** 最近动态：全量按时间倒序；默认渲染 20 条，「加载更多」每次 +20。 */
const feedAll = computed<FeedItem[]>(() =>
  [...(data.value?.feed || [])].sort(
    (a, b) => (toDate(b.time)?.getTime() ?? 0) - (toDate(a.time)?.getTime() ?? 0)
  )
);
const feedShown = ref(20);
const feedVisible = computed(() => feedAll.value.slice(0, feedShown.value));
const feedRest = computed(() => Math.max(0, feedAll.value.length - feedShown.value));

const dayKeyOf = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
interface FeedGroup {
  key: string;
  label: string;
  items: FeedItem[];
}
/** 按日分组（今天/昨天/MM-DD），读全站时钟，跨午夜自动换标签。 */
const feedGroups = computed<FeedGroup[]>(() => {
  const now = new Date(clock.value);
  const today = dayKeyOf(now);
  const yesterday = dayKeyOf(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
  const groups: FeedGroup[] = [];
  for (const item of feedVisible.value) {
    const d = toDate(item.time);
    const key = d ? dayKeyOf(d) : "";
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.items.push(item);
    else
      groups.push({
        key,
        label: key === today ? "今天" : key === yesterday ? "昨天" : key ? key.slice(5) : "更早",
        items: [item],
      });
  }
  return groups;
});

function routeOf(task: TaskBrief) {
  if (task.kind === "调拨" || task.kind === "划拨")
    return `${task.from || "—"} → ${task.to || "—"}`;
  const label = task.displayKind || (task.kind === "采样" ? "采样后送检" : task.kind || "采样");
  if (label === "采样") return `本地采样 · ${task.to || task.from || "—"}`;
  return `${label} · ${task.to || "—"}`;
}
function boxLine(box: BoxBrief, key: string) {
  if (key === "alert") return box.alert;
  if (key === "low") return `可用电量 ${box.batteryUsable ?? "—"}%`;
  if (key === "offline") {
    // 从未上报但有占用单建单时间 → 宽限已过「建单后 X未上线」（相对+绝对）；否则回落周期口径
    const grace = graceState(box.boundTaskAt, box.last, taskOfflineGraceSec.value);
    if (grace) return `${grace.text}（${grace.abs}）`;
    return `最后上报 ${box.last ? ago(box.last) : "从未上报"}`;
  }
  if (key === "pending") return box.last ? `最近上报 ${ago(box.last)}` : "等待上报";
  return [box.address, box.last ? `${ago(box.last)}上报` : ""].filter(Boolean).join(" · ");
}
function openFeed(item: FeedItem) {
  if (item.type === "task" && item.taskId) void router.push(`/task/detail/${item.taskId}`);
  else if (item.boxId)
    void router.push({ path: `/device/boxes/${item.boxId}`, query: { tab: "event" } });
}

async function load() {
  loading.value = true;
  try {
    const next = await WorkbenchAPI.get();
    // 工作台 brief 不带 boundTaskAt：离线卡要渲染「建单后 X未上线」宽限徽标，
    // 按 id 从箱子列表（flag=offline，含 boundTaskAt）补齐这一字段。无箱子列表权限时静默跳过。
    const offline = next.boxTodo?.offline;
    if (offline?.list?.length && can(BOX_PERM.list)) {
      try {
        const page = await SampleBoxAPI.page({ flag: "offline", page: 1, pageSize: 5 });
        const atOf = new Map(page.list.map((b) => [b.id, b.boundTaskAt || ""]));
        offline.list = offline.list.map((b) => ({
          ...b,
          boundTaskAt: atOf.get(b.id) || b.boundTaskAt,
        }));
      } catch {
        /* 补齐失败不影响离线卡主体（仍按周期口径显示） */
      }
    }
    data.value = next;
    updatedAt.value = new Date();
    // 行内采样入口的服务端 actions（与工作台同轮刷新；失败 fail-closed 不显示按钮）
    await loadSampleActions();
  } finally {
    loading.value = false;
  }
}
let poll = 0;
onMounted(() => {
  void loadBoxFeatures();
  void load();
  poll = window.setInterval(() => void load(), 30000);
});
onActivated(() => void load());
onBeforeUnmount(() => window.clearInterval(poll));
</script>

<style scoped>
.block + .block {
  margin-top: 16px;
}
.section-head {
  margin-bottom: 10px;
}
.cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 12px;
}
.cards.two {
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
}
/* #75 提醒区：监控信号卡——去掉待办红顶（3px 彩顶→1px 统一浅边框），语义色落在数字与标题点（warning/info 系） */
.reminder-total {
  padding: 1px 10px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  background: var(--el-fill-color-lighter);
  border-radius: 999px;
}
.reminder-cards :deep(.todo-card) {
  border-top-color: var(--el-border-color-lighter);
  border-top-width: 1px;
}
.reminder-cards :deep(.title) {
  display: inline-flex;
  gap: 6px;
  align-items: center;
}
.reminder-cards :deep(.title)::before {
  width: 6px;
  height: 6px;
  content: "";
  background: var(--el-color-info);
  border-radius: 50%;
}
.reminder-warning :deep(.count) {
  color: var(--el-color-warning);
}
.reminder-warning :deep(.title)::before {
  background: var(--el-color-warning);
}
.reminder-danger :deep(.count) {
  color: var(--el-color-danger);
}
.reminder-danger :deep(.title)::before {
  background: var(--el-color-danger);
}
.reminder-info :deep(.count) {
  color: var(--el-color-info);
}
.reminder-info :deep(.title)::before {
  background: var(--el-color-info);
}
.line {
  display: flex;
  gap: 8px;
  align-items: center;
  justify-content: space-between;
}
.line b {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* R23/D5：「任务中」标签链（虚线边框示意可点）＋行内推进按钮区 */
.box-task-link {
  cursor: pointer;
  border-style: dashed;
}
.box-task-link:hover {
  opacity: 0.85;
}
.box-row-ops {
  display: flex;
  gap: 6px;
  justify-content: flex-end;
  margin-top: 6px;
}
/* KPI 自适应：<1200px 三列、≤640px 两列（只覆盖本页，不动 StatTiles 全局口径） */
@media (max-width: 1199px) {
  .home-tiles :deep(.stat-tiles) {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}
@media (max-width: 640px) {
  .home-tiles :deep(.stat-tiles) {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
/* 全零待办：引导空态卡 */
.todo-empty {
  background: var(--el-bg-color);
  border: 1px dashed var(--el-border-color);
  border-radius: 8px;
}
.todo-empty__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: center;
}
/* 零组折叠 chip */
.quiet-row {
  margin-top: 10px;
}
.quiet-chip {
  display: inline-flex;
  gap: 4px;
  align-items: center;
  padding: 4px 12px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  cursor: pointer;
  background: var(--el-fill-color-lighter);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 999px;
  transition:
    border-color 0.15s,
    color 0.15s;
}
.quiet-chip:hover {
  color: var(--el-color-primary);
  border-color: var(--el-color-primary-light-5);
}
.quiet-chip__arrow {
  transition: transform 0.15s;
}
.quiet-chip__arrow.open {
  transform: rotate(180deg);
}
.quiet-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 18px;
  padding: 8px 12px;
  margin: 8px 0 0;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  list-style: none;
  background: var(--el-fill-color-lighter);
  border-radius: 8px;
}
.quiet-list b {
  margin-left: 4px;
  font-variant-numeric: tabular-nums;
  color: var(--el-text-color-placeholder);
}
/* 待办区块 footer：分隔线+内 padding 与区块同体，ghost 链接无外框 */
.todo-footer {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 18px;
  align-items: center;
  padding-top: 10px;
  margin-top: 12px;
  border-top: 1px solid var(--el-border-color-lighter);
}
.todo-footer__link {
  display: inline-flex;
  gap: 4px;
  align-items: center;
  padding: 2px 0;
  font: inherit;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  cursor: pointer;
  background: none;
  border: none;
  transition: color 0.15s;
}
.todo-footer__link:hover {
  color: var(--el-color-primary);
}
/* 最近动态：限高内滚 + 按日 sticky 小标题 */
.feed-card {
  align-self: flex-start;
}
@media (max-width: 1199px) {
  .feed-card {
    margin-top: 16px;
  }
}
.feed-head__side {
  display: inline-flex;
  gap: 8px;
  align-items: center;
}
.feed-scroll {
  max-height: 520px;
  overflow-y: auto;
}
.feed-day {
  position: sticky;
  top: 0;
  z-index: 1;
  padding: 4px 6px;
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--el-text-color-secondary);
  background: var(--el-bg-color);
}
.feed-group + .feed-group .feed-day {
  border-top: 1px solid var(--el-border-color-lighter);
}
.feed {
  padding: 0;
  margin: 0;
  list-style: none;
}
.feed li {
  display: flex;
  gap: 10px;
  padding: 8px 6px;
  cursor: pointer;
  border-radius: 6px;
}
.feed li:hover {
  background: var(--el-fill-color-lighter);
}
.icon {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  color: #fff;
  background: var(--el-color-info);
  border-radius: 50%;
}
.icon.is-task {
  background: var(--el-color-primary);
}
.icon.is-pad {
  background: var(--el-color-danger);
}
.icon.is-shut {
  background: var(--el-color-success);
}
.body {
  flex: 1;
  min-width: 0;
  font-size: 13px;
}
.time {
  flex-shrink: 0;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.feed-more {
  padding: 6px 0 2px;
  text-align: center;
}
</style>
