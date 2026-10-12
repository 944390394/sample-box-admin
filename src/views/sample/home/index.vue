<template>
  <div v-loading="!ready" class="page-container">
    <div v-if="ready && canSwitch" class="switcher">
      <span>视角</span>
      <button
        v-for="item in HOME_VIEWS"
        :key="item.id"
        type="button"
        :class="{ on: home === item.id }"
        @click="choose(item.id)"
      >
        {{ item.label }}
      </button>
    </div>
    <template v-if="ready && failed && !boxRows.length && home !== 'field'">
      <section class="panel">
        <div class="empty">
          <b>采样箱暂时没有取到</b>
          <p>稍后再打开这一页，或重新读取。</p>
          <button class="btn" type="button" @click="loadBoxes">重新读取</button>
        </div>
      </section>
    </template>

    <template v-else-if="ready">
      <div v-if="home !== 'field'" class="bar">
        <component
          :is="canOpenLife(life) ? 'button' : 'div'"
          v-for="life in LIFE_ORDER"
          :key="life"
          class="seg"
          :class="{
            warn: life === '待激活' && counts[life] > 0 && !plainPending,
            focus: life === '在途' && focusTransit && counts[life] > 0,
          }"
          :type="canOpenLife(life) ? 'button' : undefined"
          @click="canOpenLife(life) && openLife(life)"
        >
          <span>{{ life }}</span>
          <strong>{{ counts[life] }}</strong>
        </component>
        <div v-if="home === 'dispatch'" class="meta">
          <span>待激活和停用由资产管理员处理</span>
          <span>·</span>
          <template v-if="scopeFresh.short">
            <span>最近一包</span>
            <b :title="scopeFresh.full">{{ scopeFresh.short }}</b>
          </template>
          <span v-else>本范围还没有上报</span>
        </div>
        <div v-else-if="home === 'leader'" class="meta">
          <b>{{ boxRows.length }}</b>
          <span>台，</span>
          <b>{{ alertCount }}</b>
          <span>台有异常，</span>
          <b>{{ counts.待激活 }}</b>
          <span>台待激活</span>
          <span>·</span>
          <template v-if="fleetFresh.short">
            <span>最近一包</span>
            <b :title="fleetFresh.full">{{ fleetFresh.short }}</b>
          </template>
          <span v-else>还没有上报</span>
        </div>
        <div v-else class="meta">
          <span>共</span>
          <b>{{ boxRows.length }}</b>
          <span>台</span>
          <span>·</span>
          <template v-if="fleetFresh.short">
            <span>最近一包</span>
            <b :title="fleetFresh.full">{{ fleetFresh.short }}</b>
          </template>
          <span v-else>还没有上报</span>
        </div>
      </div>

      <template v-if="home === 'asset'">
        <section class="panel">
          <div class="hd">
            <span>
              采样箱
              <em>{{ boxRows.length }}</em>
            </span>
          </div>
          <div v-if="!ordered.length" class="empty">
            <b>还没有采样箱</b>
            <p>设备上电之后会出现在这里，待激活的可以去处理。</p>
          </div>
          <div v-else class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>箱号</th>
                  <th>状态</th>
                  <th>工况</th>
                  <th>最后上报</th>
                  <th>位置</th>
                  <th>异常</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="box in ordered" :key="box.id" :class="{ hot: box.life === '待激活' }">
                  <td class="box">{{ box.id }}</td>
                  <td>
                    <span class="tag" :class="lifeClass(box.life)">{{ box.life }}</span>
                  </td>
                  <td class="cond">{{ conditionText(box) }}</td>
                  <td class="when" :title="box.last">{{ shortStamp(box.last) }}</td>
                  <td class="where" :title="placeTitle(box)">{{ placeShort(box) }}</td>
                  <td>
                    <span v-if="box.alert" class="tag warning">{{ box.alert }}</span>
                  </td>
                  <td>
                    <button class="link" type="button" @click="openBox(box.id)">
                      {{ rowAction(box, "asset") }}
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
        <FeedPanel :rows="feed" @open-reports="openReports" />
      </template>

      <div v-else-if="home === 'duty'" class="cols">
        <section class="panel grow">
          <div class="hd">
            <span>
              待处理
              <em>{{ duty.pending.length }}</em>
            </span>
          </div>
          <div v-if="!duty.pending.length" class="empty">
            <b>没有待处理的采样箱</b>
            <p>新上报来了会显示在这里。</p>
          </div>
          <button
            v-for="box in duty.pending"
            :key="box.id"
            class="item"
            :class="{ hot: box.life === '待激活' }"
            type="button"
            @click="openBox(box.id)"
          >
            <span class="box">{{ box.id }}</span>
            <span class="tags">
              <span class="tag" :class="lifeClass(box.life)">{{ box.life }}</span>
              <span v-if="box.alert" class="tag warning">{{ box.alert }}</span>
            </span>
            <span class="cond">{{ conditionText(box) }}</span>
            <span class="where" :title="placeTitle(box)">{{ placeShort(box) }}</span>
            <span class="link">{{ rowAction(box, "duty") }}</span>
          </button>
          <div class="group">其余采样箱</div>
          <div v-if="!duty.rest.length" class="empty"><b>没有其他采样箱</b></div>
          <button
            v-for="box in duty.rest"
            :key="box.id"
            class="item"
            type="button"
            @click="openBox(box.id)"
          >
            <span class="box">{{ box.id }}</span>
            <span class="tags">
              <span class="tag" :class="lifeClass(box.life)">{{ box.life }}</span>
              <span v-if="box.alert" class="tag warning">{{ box.alert }}</span>
            </span>
            <span class="cond">{{ conditionText(box) }}</span>
            <span class="where" :title="placeTitle(box)">{{ placeShort(box) }}</span>
            <span class="link">查看</span>
          </button>
        </section>
        <FeedPanel class="side" :rows="feed" @open-reports="openReports" />
      </div>

      <template v-else-if="home === 'dispatch'">
        <section v-if="dispatchQuiet" class="panel">
          <div class="empty">
            <b>没有在途采样箱</b>
            <p>本范围也没有可安排的未使用采样箱。</p>
            <button class="btn" type="button" @click="openCreate">创建任务单</button>
          </div>
        </section>
        <div v-else class="cols">
          <section class="panel grow">
            <div class="hd">
              <span>
                在途
                <em>{{ dispatchView.trips.length }}</em>
              </span>
            </div>
            <div v-if="!dispatchView.trips.length" class="empty">
              <b>没有在途采样箱</b>
              <p>本范围没有正在执行的采样。</p>
            </div>
            <div v-for="trip in dispatchView.trips" :key="trip.box" class="trip">
              <div class="trip-1">
                <span class="box">{{ trip.box }}</span>
                <span class="tag primary">在途</span>
                <span v-if="trip.alert" class="tag warning">{{ trip.alert }}</span>
                <span v-if="trip.task" class="name">{{ trip.task }}</span>
                <button class="link" type="button" @click="openBox(trip.box)">查看</button>
              </div>
              <div class="trip-2">
                <span v-if="trip.person">{{ trip.person }}</span>
                <span v-if="trip.plan">{{ trip.plan }}</span>
                <span>{{ trip.cond }}</span>
                <span :title="trip.whereTitle">{{ trip.where }}</span>
              </div>
            </div>
            <div class="group">可安排</div>
            <div v-if="dispatchView.unused.length">
              <div v-for="box in dispatchView.unused" :key="box.id" class="item">
                <span class="box">{{ box.id }}</span>
                <span class="tags">
                  <span class="tag" :class="lifeClass(box.life)">{{ box.life }}</span>
                </span>
                <span class="cond">{{ conditionText(box) }}</span>
                <span class="where">未绑定</span>
                <button class="link" type="button" @click="openCreate">创建任务单</button>
              </div>
            </div>
            <div v-else class="assign">
              <span>没有可安排的未使用采样箱</span>
              <button class="btn" type="button" @click="openCreate">创建任务单</button>
            </div>
          </section>
          <div class="stack">
            <section class="panel">
              <div class="hd">
                <span>
                  这趟异常
                  <em>{{ dispatchView.alerts.length }}</em>
                </span>
              </div>
              <div v-if="!dispatchView.alerts.length" class="empty">
                <b>没有异常</b>
                <p>在途采样箱没有开箱或偏离。</p>
              </div>
              <div
                v-for="item in dispatchView.alerts"
                :key="item.box + item.rule"
                class="alert"
                :class="{ bare: !item.level }"
              >
                <span
                  v-if="item.level"
                  class="tag"
                  :class="item.level === '高' ? 'danger' : 'warning'"
                >
                  {{ item.level }}
                </span>
                <div>
                  <b>{{ item.rule }}</b>
                  <span>
                    {{ item.box }}
                    <template v-if="item.detail">· {{ item.detail }}</template>
                  </span>
                </div>
              </div>
            </section>
            <FeedPanel :rows="scopeFeed" @open-reports="openReports" />
          </div>
        </div>
      </template>

      <template v-else-if="home === 'verify'">
        <section v-if="!verifyItems.length" class="panel">
          <div class="hd">
            <span>
              待核验
              <em>0</em>
            </span>
          </div>
          <div class="empty">
            <b>没有待核验的采样箱</b>
            <p>采样中如果出现开箱或地点异常，也会列在这里。</p>
          </div>
        </section>
        <div v-else class="cols">
          <section class="panel grow">
            <div class="hd"><span>核验目录</span></div>
            <template v-for="group in verifyGroups" :key="group.title">
              <template v-if="group.items.length || group.title === '待核验'">
                <div class="group">{{ group.title }}</div>
                <div v-if="!group.items.length" class="empty"><b>没有待核验的采样箱</b></div>
                <button
                  v-for="item in group.items"
                  :key="item.id"
                  class="dir"
                  :class="{ on: selected?.id === item.id, hot: item.queue === '待核验' }"
                  type="button"
                  @click="picked = item.id"
                >
                  <span class="box">{{ item.box }}</span>
                  <span class="tags">
                    <span v-if="item.queue === '待核验'" class="tag warning">待核验</span>
                    <span v-else-if="item.alert" class="tag warning">{{ item.alert }}</span>
                    <span v-else class="tag primary">在途</span>
                  </span>
                  <span class="where">{{ item.task }}</span>
                </button>
              </template>
            </template>
          </section>
          <aside v-if="selected" class="panel side">
            <div class="hd">
              <span>核验单</span>
              <button
                v-if="selected.queue === '待核验'"
                class="btn"
                type="button"
                @click="openReceive"
              >
                去核验
              </button>
              <button v-else class="link" type="button" @click="openBox(selected.box)">
                查看采样箱
              </button>
            </div>
            <dl class="facts">
              <dt>异常原因</dt>
              <dd>{{ selected.alert || "无" }}</dd>
              <dt>任务</dt>
              <dd>{{ selected.task }}</dd>
              <dt>采样箱</dt>
              <dd>{{ selected.box }}</dd>
              <dt>开箱次数</dt>
              <dd>{{ selected.opens }}</dd>
              <dt>计划地点</dt>
              <dd>{{ selected.plan }}</dd>
              <dt>实际位置</dt>
              <dd :title="selected.actualTitle">{{ selected.actual }}</dd>
            </dl>
          </aside>
        </div>
      </template>

      <section v-else-if="home === 'leader'" class="panel">
        <div class="hd"><span>全部采样箱</span></div>
        <div v-if="!ordered.length" class="empty">
          <b>还没有采样箱</b>
          <p>设备上电之后会出现在这里。</p>
        </div>
        <div v-else class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>箱号</th>
                <th>状态</th>
                <th>工况</th>
                <th>最后上报</th>
                <th>位置</th>
                <th>异常</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="box in ordered" :key="box.id" :class="{ hot: box.life === '待激活' }">
                <td class="box">{{ box.id }}</td>
                <td>
                  <span class="tag" :class="lifeClass(box.life)">{{ box.life }}</span>
                </td>
                <td class="cond">{{ conditionText(box) }}</td>
                <td class="when" :title="box.last">{{ shortStamp(box.last) }}</td>
                <td class="where" :title="placeTitle(box)">{{ placeShort(box) }}</td>
                <td>
                  <span v-if="box.alert" class="tag warning">{{ box.alert }}</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <template v-else>
        <section class="panel">
          <div class="who">
            <b>{{ nickname }}</b>
            <span>{{ whoLine }}</span>
          </div>
          <div v-if="!field.task" class="empty">
            <b>还没有分配给你的任务</b>
            <p>调度员派单之后，采样环节和采样箱状态会出现在这里。</p>
          </div>
          <ol v-else class="steps">
            <li
              v-for="(name, index) in FIELD_STEPS"
              :key="name"
              :class="{ done: index < field.index, on: index === field.index }"
            >
              <i></i>
              {{ name }}
            </li>
          </ol>
        </section>
        <section v-if="field.task" class="panel">
          <div class="hd">
            <span>
              我的任务
              <em>1</em>
            </span>
          </div>
          <div class="grid">
            <div>
              <span>单号</span>
              <b>{{ field.task.no }}</b>
            </div>
            <div>
              <span>采样箱</span>
              <b>{{ field.task.box }}</b>
            </div>
            <div>
              <span>计划地点</span>
              <b>{{ field.task.place }}</b>
            </div>
            <div>
              <span>状态</span>
              <b>{{ field.task.status }}</b>
            </div>
            <div>
              <span>上报间隔</span>
              <b>{{ field.task.interval }}</b>
            </div>
            <div>
              <span>分公司</span>
              <b>{{ field.task.org }}</b>
            </div>
          </div>
          <div class="boxline">
            <b>{{ field.task.box }}</b>
            <span v-if="field.task.cond">{{ field.task.cond }}</span>
            <span v-if="field.task.reported" :title="field.task.reportedFull">
              最近上报 {{ field.task.reported }}
            </span>
            <span :title="field.task.whereTitle">{{ field.task.where }}</span>
          </div>
        </section>
        <section v-if="field.task && field.history" class="panel">
          <div class="hd"><span>已结束</span></div>
          <div class="done-row">
            <b>{{ field.history.name }}</b>
            <span>{{ field.history.no }}</span>
            <span>{{ field.history.box }}</span>
            <span>{{ field.history.place }}</span>
            <span class="tag success">{{ field.history.status }}</span>
          </div>
        </section>
      </template>
    </template>
  </div>
</template>

<script setup lang="ts">
import SampleBoxAPI from "@/api/sample/box";
import UserAPI, { type UserProfileDetail } from "@/api/system/user";
import { useUserStore } from "@/stores/user";
import { boxSession } from "../box-state";
import {
  compareBoxes,
  conditionText,
  placeShort,
  placeTitle,
  shortStamp,
  type BoxLife,
  type SampleBox,
} from "../data";
import FeedPanel from "./FeedPanel.vue";
import {
  LIFE_ORDER,
  buildDispatch,
  buildFeed,
  buildVerify,
  demoReportRows,
  dispatchBranch,
  fieldModel,
  FIELD_STEPS,
  freshOf,
  HOME_VIEWS,
  lifeClass,
  lifeCounts,
  pickHome,
  rowAction,
  canSwitchHome,
  serverReportRows,
  splitDuty,
  type HomeRole,
} from "./model";

const userStore = useUserStore();
const router = useRouter();
const serverMode = import.meta.env.VITE_MOCK_DEV_SERVER !== "true";
const remoteBoxes = ref<SampleBox[]>([]);
const remoteReports = ref<Awaited<ReturnType<typeof SampleBoxAPI.reports>>>([]);
const profile = ref<UserProfileDetail | null>(null);
const ready = ref(false);
const failed = ref(false);
const picked = ref("");
let poll = 0;

const naturalHome = computed(() =>
  pickHome(userStore.userInfo.roles || [], userStore.userInfo.perms || [])
);
const canSwitch = computed(() =>
  canSwitchHome(userStore.userInfo.roles || [], userStore.userInfo.perms || [])
);
const chosen = ref<HomeRole | "">("");
const home = computed(() => (canSwitch.value && chosen.value ? chosen.value : naturalHome.value));
const nickname = computed(() => userStore.userInfo.nickname || userStore.userInfo.username || "");
const whoLine = computed(() =>
  [profile.value?.deptName, profile.value?.roleNames].filter(Boolean).join(" · ")
);
const boxRows = computed(() => (serverMode ? remoteBoxes.value : boxSession.boxes));
const ordered = computed(() => [...boxRows.value].sort(compareBoxes));
const counts = computed(() =>
  lifeCounts(home.value === "dispatch" ? dispatchView.value.scope : boxRows.value)
);
const alertCount = computed(() => boxRows.value.filter((box) => box.alert).length);
const plainPending = computed(
  () => home.value === "dispatch" || home.value === "verify" || home.value === "leader"
);
const focusTransit = computed(() => home.value === "dispatch");
const duty = computed(() => splitDuty(boxRows.value));
const allFeed = computed(() =>
  buildFeed(
    serverMode ? serverReportRows(remoteReports.value) : demoReportRows(boxSession.logs),
    serverMode ? boxRows.value : boxSession.boxes
  )
);
const feed = computed(() => allFeed.value.slice(0, 8));
const fleetFresh = computed(() => freshOf(allFeed.value));
const dispatchView = computed(() =>
  buildDispatch(
    boxRows.value,
    serverMode,
    serverMode ? "" : dispatchBranch(userStore.userInfo.username || "")
  )
);
const scopeIds = computed(() => new Set(dispatchView.value.scope.map((box) => box.id)));
const scopeFeed = computed(() =>
  allFeed.value.filter((row) => scopeIds.value.has(row.box)).slice(0, 8)
);
const scopeFresh = computed(() => freshOf(scopeFeed.value));
const dispatchQuiet = computed(
  () =>
    !dispatchView.value.trips.length &&
    !dispatchView.value.unused.length &&
    !dispatchView.value.alerts.length
);
const verifyView = computed(() => buildVerify(boxRows.value, serverMode));
const verifyGroups = computed(() => [
  { title: "待核验", items: verifyView.value.pending },
  { title: "采样中有异常", items: verifyView.value.watching },
  { title: "其他在途，无异常", items: verifyView.value.calm },
]);
const verifyItems = computed(() => verifyGroups.value.flatMap((group) => group.items));
const selected = computed(
  () => verifyItems.value.find((item) => item.id === picked.value) || verifyItems.value[0] || null
);
const field = computed(() =>
  fieldModel(
    userStore.userInfo.roles || [],
    nickname.value,
    profile.value?.deptName || "",
    boxRows.value,
    serverMode
  )
);

function choiceKey() {
  return `sample-home-view:${userStore.userInfo.userId || "0"}`;
}

function restoreChoice() {
  if (!canSwitch.value) {
    chosen.value = "";
    return;
  }
  const raw = sessionStorage.getItem(choiceKey());
  chosen.value = HOME_VIEWS.some((item) => item.id === raw) ? (raw as HomeRole) : "";
}

function choose(id: HomeRole) {
  if (!canSwitch.value || id === home.value) return;
  chosen.value = id;
  sessionStorage.setItem(choiceKey(), id);
  stop();
  start();
}

function canOpenLife(life: BoxLife) {
  if (home.value === "dispatch") return life === "在途" || life === "未使用";
  return true;
}

function openLife(life: BoxLife) {
  router.push({ path: "/device/boxes", query: { life } });
}

function openBox(id: string) {
  router.push(`/device/boxes/${id}`);
}

function openCreate() {
  router.push("/task/create");
}

function openReceive() {
  router.push("/task/receive");
}

function openReports() {
  router.push("/monitor/reports");
}

async function loadBoxes() {
  if (!serverMode || home.value === "field") {
    ready.value = true;
    return;
  }
  try {
    const [list, rows] = await Promise.all([SampleBoxAPI.list(), SampleBoxAPI.reports()]);
    remoteBoxes.value = list;
    remoteReports.value = rows;
    failed.value = false;
  } catch {
    failed.value = true;
  } finally {
    ready.value = true;
  }
}

async function loadProfile() {
  if (home.value !== "field") return;
  try {
    profile.value = await UserAPI.getProfile();
  } catch {
    profile.value = null;
  }
}

function start() {
  void loadBoxes();
  void loadProfile();
  if (!serverMode || home.value === "field" || poll) return;
  poll = window.setInterval(() => void loadBoxes(), 3000);
}

function stop() {
  window.clearInterval(poll);
  poll = 0;
}

onMounted(() => {
  restoreChoice();
  start();
});
onActivated(() => {
  restoreChoice();
  start();
});
onDeactivated(stop);
onUnmounted(stop);
</script>

<script lang="ts">
export default { name: "SampleHome" };
</script>

<style scoped>
.switcher {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  justify-content: flex-end;
}
.switcher span {
  font-size: 13px;
  color: var(--el-text-color-secondary);
}
.switcher button {
  height: 28px;
  padding: 0 10px;
  margin: 0;
  font: inherit;
  font-size: 13px;
  color: var(--el-text-color-regular);
  cursor: pointer;
  background: var(--content-bg);
  border: 1px solid var(--card-border);
  border-radius: 6px;
}
.switcher button.on {
  color: #fff;
  background: var(--el-color-primary);
  border-color: var(--el-color-primary);
}
.bar,
.panel {
  background: var(--content-bg);
  border: 1px solid var(--card-border);
  border-radius: var(--card-radius);
  box-shadow: var(--card-shadow);
}
.bar {
  display: flex;
  align-items: stretch;
  min-height: 52px;
  overflow: hidden;
}
.seg {
  display: flex;
  gap: 8px;
  align-items: baseline;
  padding: 0 18px;
  margin: 0;
  font: inherit;
  font-size: 14px;
  color: var(--el-text-color-regular);
  white-space: nowrap;
  background: transparent;
  border: 0;
  border-right: 1px solid var(--el-border-color-lighter);
}
button.seg {
  cursor: pointer;
}
.seg strong {
  font-size: 20px;
  font-weight: 650;
  font-variant-numeric: tabular-nums;
  color: var(--el-text-color-primary);
}
.seg.warn {
  color: var(--el-color-warning);
  background: var(--el-color-warning-light-9);
}
.seg.warn strong {
  color: var(--el-color-warning);
}
.seg.focus {
  color: var(--el-color-primary);
  background: var(--el-color-primary-light-9);
}
.seg.focus strong {
  color: var(--el-color-primary);
}
.meta {
  display: flex;
  gap: 4px;
  align-items: center;
  padding: 0 16px;
  margin-left: auto;
  font-size: 13px;
  color: var(--el-text-color-secondary);
  white-space: nowrap;
}
.meta b {
  font-weight: 650;
  color: var(--el-text-color-primary);
}
.cols {
  display: flex;
  gap: 12px;
  align-items: stretch;
}
.grow {
  flex: 1;
  min-width: 0;
}
.side {
  flex: 0 0 420px;
}
.stack {
  display: flex;
  flex: 0 0 380px;
  flex-direction: column;
  gap: 12px;
}
.panel {
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.hd {
  display: flex;
  gap: 12px;
  align-items: center;
  justify-content: space-between;
  height: 44px;
  padding: 0 16px;
  font-size: 14px;
  font-weight: 650;
  border-bottom: 1px solid var(--card-border);
}
.hd em {
  margin-left: 8px;
  font-style: normal;
  font-weight: 500;
  color: var(--el-text-color-secondary);
}
.group {
  display: flex;
  align-items: center;
  height: 32px;
  padding: 0 16px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  background: var(--el-fill-color-light);
  border-top: 1px solid var(--el-border-color-lighter);
  border-bottom: 1px solid var(--el-border-color-lighter);
}
.item,
.dir {
  display: grid;
  gap: 8px 12px;
  align-items: center;
  width: 100%;
  min-height: 48px;
  padding: 8px 16px;
  margin: 0;
  font: inherit;
  color: inherit;
  text-align: left;
  background: transparent;
  border: 0;
  border-bottom: 1px solid var(--el-border-color-lighter);
}
.item {
  grid-template-columns: 88px minmax(0, 1fr) auto auto auto;
}
.dir {
  grid-template-columns: 88px minmax(0, 1fr) auto;
  cursor: pointer;
}
button.item:hover {
  background: var(--el-fill-color-light);
}
button.item.hot:hover {
  background: var(--el-color-warning-light-9);
}
button.dir:hover {
  background: var(--el-fill-color-light);
}
button.dir.on:hover {
  background: var(--el-color-primary-light-8);
}
button.dir.hot.on:hover {
  background: var(--el-color-warning-light-8);
}
.item.hot,
tr.hot td {
  background: var(--el-color-warning-light-9);
}
.item.hot {
  box-shadow: inset 3px 0 0 var(--el-color-warning);
}
tr.hot td:first-child {
  box-shadow: inset 3px 0 0 var(--el-color-warning);
}
.dir.on {
  background: var(--el-color-primary-light-9);
  box-shadow: inset 3px 0 0 var(--el-color-primary);
}
.dir.hot.on {
  background: var(--el-color-warning-light-9);
  box-shadow: inset 3px 0 0 var(--el-color-warning);
}
.box {
  font-weight: 650;
}
.tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  min-width: 0;
}
.tag {
  display: inline-flex;
  align-items: center;
  height: 22px;
  padding: 0 8px;
  font-size: 12px;
  font-weight: 400;
  color: var(--el-text-color-regular);
  white-space: nowrap;
  background: var(--el-fill-color);
  border-radius: 4px;
}
.tag.primary {
  color: var(--el-color-primary);
  background: var(--el-color-primary-light-9);
}
.tag.warning {
  color: var(--el-color-warning);
  background: var(--el-color-warning-light-9);
}
.tag.success {
  color: var(--el-color-success);
  background: var(--el-color-success-light-9);
}
.tag.info {
  color: var(--el-text-color-secondary);
  background: var(--el-fill-color);
}
.tag.danger {
  color: var(--el-color-danger);
  background: var(--el-color-danger-light-9);
}
.cond {
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  color: var(--el-text-color-regular);
  text-align: right;
  white-space: nowrap;
}
.where,
.when {
  font-size: 13px;
  color: var(--el-text-color-secondary);
  white-space: nowrap;
}
.where {
  text-align: right;
}
.item .where {
  max-width: 16em;
  line-height: 1.4;
  white-space: normal;
}
.link {
  padding: 0;
  margin: 0;
  font: inherit;
  font-size: 13px;
  font-weight: 400;
  color: var(--el-color-primary);
  white-space: nowrap;
  cursor: pointer;
  background: none;
  border: 0;
}
.btn {
  display: inline-flex;
  align-items: center;
  height: 32px;
  padding: 0 14px;
  font: inherit;
  font-size: 13px;
  color: #fff;
  cursor: pointer;
  background: var(--el-color-primary);
  border: 0;
  border-radius: 6px;
}
.trip {
  padding: 12px 16px;
  border-bottom: 1px solid var(--el-border-color-lighter);
}
.trip-1,
.trip-2 {
  display: flex;
  gap: 8px;
  align-items: center;
  min-width: 0;
}
.trip-1 {
  margin-bottom: 8px;
}
.trip-1 .name {
  font-weight: 650;
}
.trip-1 .link {
  margin-left: auto;
}
.trip-2 {
  gap: 0;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.trip-2 span + span::before {
  margin: 0 8px;
  color: var(--el-border-color);
  content: "·";
}
.alert.bare {
  grid-template-columns: minmax(0, 1fr);
}
.alert {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 8px;
  align-items: center;
  min-height: 52px;
  padding: 8px 16px;
  border-bottom: 1px solid var(--el-border-color-lighter);
}
.alert b {
  display: block;
  font-size: 13px;
}
.alert span {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.table-wrap {
  overflow-x: auto;
}
table {
  width: 100%;
  font-size: 13px;
  border-collapse: collapse;
}
th {
  height: 36px;
  padding: 0 14px;
  font-size: 12px;
  font-weight: 500;
  color: var(--el-text-color-secondary);
  text-align: left;
  white-space: nowrap;
  background: var(--el-fill-color-light);
}
td {
  height: 46px;
  padding: 0 14px;
  white-space: nowrap;
  border-top: 1px solid var(--el-border-color-lighter);
}
td.cond,
td.when {
  text-align: left;
}
td.where {
  text-align: left;
  white-space: nowrap;
}
.facts {
  display: grid;
  grid-template-columns: 88px 1fr;
  margin: 0;
}
.facts dt,
.facts dd {
  display: flex;
  align-items: center;
  min-height: 44px;
  padding: 0 16px;
  margin: 0;
  font-size: 13px;
  border-bottom: 1px solid var(--el-border-color-lighter);
}
.facts dt {
  color: var(--el-text-color-secondary);
}
.facts dd:last-of-type,
.facts dt:last-of-type {
  border-bottom: 0;
}
.empty {
  padding: 22px 16px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--el-text-color-secondary);
}
.empty b {
  display: block;
  margin-bottom: 4px;
  font-size: 14px;
  color: var(--el-text-color-primary);
}
.empty p {
  margin: 0;
}
.empty .btn {
  margin-top: 12px;
}
.assign {
  display: flex;
  gap: 12px;
  align-items: center;
  justify-content: space-between;
  min-height: 56px;
  padding: 10px 16px;
  margin-top: auto;
  font-size: 13px;
  color: var(--el-text-color-secondary);
  background: var(--el-fill-color-light);
}
.who {
  padding: 16px 16px 4px;
}
.who b {
  font-size: 18px;
}
.who span {
  display: block;
  margin-top: 4px;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}
.steps {
  display: flex;
  padding: 0;
  margin: 8px 8px 16px;
  list-style: none;
}
.steps li {
  position: relative;
  flex: 1;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  text-align: center;
}
.steps li::before {
  position: absolute;
  top: 4px;
  left: -50%;
  width: 100%;
  height: 2px;
  content: "";
  background: var(--el-border-color);
}
.steps li:first-child::before {
  display: none;
}
.steps i {
  position: relative;
  z-index: 1;
  display: block;
  width: 10px;
  height: 10px;
  margin: 0 auto 8px;
  background: var(--el-border-color);
  border-radius: 50%;
}
.steps .done {
  color: var(--el-color-success);
}
.steps .done i,
.steps .done::before,
.steps .on::before {
  background: var(--el-color-success);
}
.steps .on {
  font-weight: 650;
  color: var(--el-color-primary);
}
.steps .on i {
  background: var(--el-color-primary);
  box-shadow: 0 0 0 4px var(--el-color-primary-light-9);
}
.grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 14px 24px;
  padding: 16px;
}
.grid span {
  display: block;
  margin-bottom: 4px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.grid b {
  font-size: 14px;
  font-weight: 650;
}
.boxline {
  display: flex;
  gap: 8px;
  align-items: center;
  min-height: 44px;
  padding: 0 12px;
  margin: 0 16px 16px;
  font-size: 13px;
  color: var(--el-text-color-regular);
  background: var(--el-fill-color-light);
  border-radius: 6px;
}
.done-row {
  display: flex;
  gap: 16px;
  align-items: center;
  min-height: 48px;
  padding: 0 16px;
  font-size: 13px;
}
.done-row span {
  color: var(--el-text-color-secondary);
}
@media (max-width: 1100px) {
  .cols,
  .stack {
    flex-direction: column;
  }
  .side,
  .stack {
    flex-basis: auto;
    width: 100%;
  }
}
</style>
