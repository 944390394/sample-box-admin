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
      </template>
    </PageHeader>

    <el-skeleton v-if="!data && loading" :rows="6" animated />
    <template v-else-if="data">
      <StatTiles v-if="tiles.length" :items="tiles" :max="6" @update:model-value="openTile" />

      <el-row :gutter="12">
        <el-col :lg="16" :span="24">
          <section class="block">
            <div class="card-head section-head">
              <span class="card-head__title">待我处理</span>
              <span
                class="text-muted"
                title="能推进的任务（一张单只算一次）加待激活的箱子；低电、开着盖等是提醒，不算件数"
              >
                {{
                  todoTotal
                    ? `共 ${todoTotal} 件`
                    : activeCards.length
                      ? "只有提醒，没有要你推进的事"
                      : "暂时没有要你处理的事"
                }}
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
                <TodoCard
                  v-else-if="card.boxes"
                  :title="card.title"
                  :hint="card.hint"
                  :tone="card.tone"
                  :bucket="card.boxes"
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
              </template>
            </div>
            <el-empty v-else :image-size="64" description="都处理完了" />
            <p v-if="quietCards.length" class="text-muted quiet">
              没有待办：{{ quietCards.map((c) => c.title).join("、") }}
            </p>
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
                    <el-tag size="small" :type="lifeTone(item.life)">
                      {{ lifeLabel(item.life) }}
                    </el-tag>
                  </div>
                  <div class="text-muted">{{ boxLine(item, "mine") }}</div>
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
                <span class="text-muted">任务流转和开关箱</span>
              </div>
            </template>
            <ul v-if="feed.length" class="feed">
              <li v-for="(item, index) in feed" :key="index" @click="openFeed(item)">
                <span class="icon" :class="item.type === 'task' ? 'is-task' : `is-${item.kind}`">
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
            <el-empty v-else :image-size="56" description="最近没有动态" />
          </el-card>
        </el-col>
      </el-row>
    </template>
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: "SampleHome" });

import {
  DataBoard,
  Lock,
  MapLocation,
  Plus,
  Promotion,
  Refresh,
  SwitchButton,
  Unlock,
} from "@element-plus/icons-vue";
import WorkbenchAPI, {
  todoCount,
  type BoxBrief,
  type Bucket,
  type FeedItem,
  type TaskBrief,
  type Workbench,
} from "@/api/sample/workbench";
import PageHeader from "@/components/biz/PageHeader.vue";
import StatTiles, { type StatTile } from "@/components/biz/StatTiles.vue";
import TimeText from "@/components/biz/TimeText.vue";
import { usePerm } from "@/composables/usePerm";
import { useUserStore } from "@/stores/user";
import { lifeLabel } from "@/utils/labels";
import { ago, toDate } from "@/utils/time";
import { lifeTone, taskTone } from "@/utils/tone";
import { BOX_PERM, TASK_CREATE } from "../data";
import TodoCard from "./TodoCard.vue";

/**
 * 工作台：一页看「要我处理什么」。
 * 每张卡片单独授权（角色页「工作台」模块），勾了且有看里面内容的权限才显示；
 * 有数量的卡片在前，没有待办的折成一行。30 秒刷新一次。
 */
const router = useRouter();
const can = usePerm();
const userStore = useUserStore();
const data = ref<Workbench | null>(null);
const loading = ref(false);
const updatedAt = ref<Date | null>(null);

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
    },
    {
      key: "life:未使用",
      label: lifeLabel("未使用"),
      value: stats.counts["未使用"] ?? 0,
      tone: "success",
    },
    {
      key: "flag:offline",
      label: "离线",
      value: stats.flags.offline ?? 0,
      tone: stats.flags.offline ? "warning" : "default",
    },
  ];
  if (stats.flags.low != null)
    list.push({
      key: "flag:low",
      label: "低电量",
      value: stats.flags.low ?? 0,
      tone: stats.flags.low ? "danger" : "default",
    });
  if (tasks?.moving)
    list.push({
      key: "task:moving",
      label: "运送中的任务",
      value: tasks.moving.total,
      tone: "primary",
    });
  return list;
});
function openTile(key: string) {
  if (!key) return;
  if (key === "task:moving") void router.push({ path: "/task/tasks", query: { status: "进行中" } });
  else void router.push({ path: "/device/boxes", query: { tile: key } });
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
const cards = computed<Card[]>(() => {
  const d = data.value;
  if (!d) return [];
  const list: Card[] = [];
  const t = d.taskTodo;
  const mine = { path: "/task/tasks", query: { mine: "1" } };
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
        more: mine,
      },
      t.send
    );
    push(
      {
        key: "arrive",
        title: "待确认到达",
        hint: "箱子到了收货地址后确认",
        tone: "primary",
        more: mine,
      },
      t.arrive
    );
    push(
      { key: "sign", title: "待签收", hint: "扫箱码做签收核验", tone: "warning", more: mine },
      t.sign
    );
    push(
      {
        key: "returning",
        title: "待接收退回",
        hint: "被拒收、正退回本单位的箱子，到了以后扫码接收",
        tone: "warning",
        more: mine,
      },
      t.returning
    );
    push(
      {
        key: "sampling",
        title: "采样待推进",
        hint: "开始采样、封箱、寄回",
        tone: "primary",
        more: mine,
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
    push(
      {
        key: "overLimit",
        title: "开箱超限",
        hint: "任务期间开箱次数超过上限",
        tone: "danger",
        more: { path: "/task/tasks", query: { status: "进行中" } },
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
      key: "offline",
      title: "在途但离线",
      hint: "超过 3 个上报周期没上报",
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
const activeCards = computed(() => cards.value.filter((card) => totalOf(card) > 0));
const quietCards = computed(() => cards.value.filter((card) => totalOf(card) === 0));
// 和顶栏铃铛同一个数：卡片之间会重叠（一张单可能既待签收又开箱超限），不能把卡片数加起来
const todoTotal = computed(() => (data.value ? todoCount(data.value) : 0));
const showField = computed(() => {
  const d = data.value;
  if (!d) return false;
  // 只在手上真有箱子或任务时显示，空的不占地方
  return Boolean(d.myBoxes?.total) || Boolean(d.taskTodo?.mine?.total);
});

const feed = computed<FeedItem[]>(() =>
  [...(data.value?.feed || [])]
    .sort((a, b) => (toDate(b.time)?.getTime() ?? 0) - (toDate(a.time)?.getTime() ?? 0))
    .slice(0, 20)
);

function routeOf(task: TaskBrief) {
  return task.kind === "调拨"
    ? `${task.from || "—"} → ${task.to || "—"}`
    : `采样 · ${task.to || "—"}`;
}
function boxLine(box: BoxBrief, key: string) {
  if (key === "alert") return box.alert;
  if (key === "low") return `可用电量 ${box.batteryUsable ?? "—"}%`;
  if (key === "offline") return `最后上报 ${box.last ? ago(box.last) : "从未上报"}`;
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
    data.value = await WorkbenchAPI.get();
    updatedAt.value = new Date();
  } finally {
    loading.value = false;
  }
}
let poll = 0;
onMounted(() => {
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
.quiet {
  margin: 10px 0 0;
}
.feed-card {
  height: 100%;
}
@media (max-width: 1199px) {
  .feed-card {
    margin-top: 16px;
  }
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
</style>
