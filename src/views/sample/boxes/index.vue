<template>
  <div class="page-container">
    <el-empty v-if="!canSeeList" description="当前角色不能查看采样箱">
      <el-button @click="router.push('/')">返回</el-button>
    </el-empty>

    <template v-else>
      <div class="stats">
        <button
          v-for="card in cards"
          :key="card.life"
          type="button"
          class="stat"
          :class="{
            on: lifeFilter === card.life,
            warn: card.life === '待激活' && card.count > 0,
          }"
          @click="toggle(card.life)"
        >
          <span>{{ card.life }}</span>
          <strong>{{ card.count }}</strong>
        </button>
      </div>

      <el-card shadow="never" class="block">
        <el-table :data="filtered" :row-class-name="rowClass" @row-click="onRow">
          <el-table-column label="箱号" min-width="168">
            <template #default="{ row }">
              <div class="box-id">
                <b>{{ row.id }}</b>
                <span>{{ row.imei }}</span>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="状态" width="88">
            <template #default="{ row }">
              <el-tag :type="lifeTag(row.life)" size="small">{{ row.life }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="工况" width="120">
            <template #default="{ row }">{{ row.csq }} · {{ row.battery }}</template>
          </el-table-column>
          <el-table-column label="最后上报" width="118">
            <template #default="{ row }">
              <span class="time" :title="row.last">{{ shortTime(row.last) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="位置" min-width="220">
            <template #default="{ row }">
              <div class="place">
                <span>基站 {{ lbsText(row) }}</span>
                <span>GPS {{ gpsText(row) }}</span>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="异常" min-width="140">
            <template #default="{ row }">
              <el-tag v-if="row.alert" type="warning" size="small">{{ row.alert }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column v-if="showOps" label="操作" :width="opsWidth" fixed="right">
            <template #default="{ row }">
              <div class="ops" @click.stop>
                <el-button
                  v-if="allow(BOX_PERM.detail)"
                  link
                  type="primary"
                  @click="openBox(row.id)"
                >
                  查看
                </el-button>
                <el-button
                  v-if="
                    manageActions &&
                    row.life === '待激活' &&
                    row.activateStep === '等待激活' &&
                    allow(BOX_PERM.activate)
                  "
                  link
                  type="primary"
                  @click="openActivate(row)"
                >
                  激活
                </el-button>
                <el-button
                  v-if="
                    manageActions && row.activateStep === '待设备确认' && allow(BOX_PERM.activate)
                  "
                  link
                  type="primary"
                  @click="simulate(row)"
                >
                  模拟箱子确认
                </el-button>
                <el-button
                  v-if="manageActions && row.life === '未使用' && allow(BOX_PERM.disable)"
                  link
                  type="danger"
                  @click="stop(row)"
                >
                  停用
                </el-button>
                <el-button
                  v-if="manageActions && row.life === '停用' && allow(BOX_PERM.disable)"
                  link
                  type="primary"
                  @click="resume(row)"
                >
                  恢复
                </el-button>
              </div>
            </template>
          </el-table-column>
        </el-table>
      </el-card>
    </template>

    <el-dialog v-model="activateOpen" title="激活采样箱" width="480px">
      <p v-if="current">{{ current.id }} · IMEI {{ current.imei }}</p>
      <p>核对身份后确认激活。设备密钥会在这台箱子下次上线时下发，所属固定为总公司。</p>
      <template #footer>
        <el-button @click="activateOpen = false">取消</el-button>
        <el-button type="primary" @click="doActivate">确认激活</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import SampleBoxAPI from "@/api/sample/box";
import { useUserStore } from "@/stores/user";
import { BOX_PERM, compareBoxes, gpsText, lbsText, type BoxLife, type SampleBox } from "../data";
import { boxSession, confirmDevice, disableBox, requestActivate, restoreBox } from "../box-state";

const userStore = useUserStore();
const serverMode = import.meta.env.VITE_MOCK_DEV_SERVER !== "true";
const router = useRouter();
const route = useRoute();
const remoteBoxes = ref<SampleBox[]>([]);
const boxes = computed(() => (serverMode ? remoteBoxes.value : boxSession.boxes));
const lives: BoxLife[] = ["在途", "未使用", "停用", "待激活"];
function isLife(value: string): value is BoxLife {
  return (lives as string[]).includes(value);
}

/** 筛选放在地址上。首页点状态条带 life，点当前项可以回到全部。 */
const lifeFilter = computed<BoxLife | "">({
  get() {
    const life = route.query.life;
    return typeof life === "string" && isLife(life) ? life : "";
  },
  set(life) {
    const query = { ...route.query };
    if (life) query.life = life;
    else delete query.life;
    router.replace({ query });
  },
});
const activateOpen = ref(false);
const current = ref<SampleBox | null>(null);
let poll = 0;

const canSeeList = computed(() => Object.values(BOX_PERM).some((perm) => allow(perm)));
const manageActions = computed(
  () => !serverMode && (allow(BOX_PERM.activate) || allow(BOX_PERM.disable))
);
const showOps = computed(() => allow(BOX_PERM.detail) || manageActions.value);
const opsWidth = computed(() => (manageActions.value ? 200 : 72));

const cards = computed(() =>
  lives.map((life) => ({
    life,
    count: boxes.value.filter((item) => item.life === life).length,
  }))
);

const ordered = computed(() => [...boxes.value].sort(compareBoxes));

const filtered = computed(() =>
  lifeFilter.value ? ordered.value.filter((item) => item.life === lifeFilter.value) : ordered.value
);

async function loadRemote() {
  if (!canSeeList.value) return;
  remoteBoxes.value = await SampleBoxAPI.list();
}

onMounted(() => {
  if (!serverMode) return;
  loadRemote();
  poll = window.setInterval(loadRemote, 3000);
});

onUnmounted(() => {
  window.clearInterval(poll);
});

function allow(perm: string) {
  return userStore.userInfo.perms?.includes(perm) ?? false;
}

function lifeTag(life: BoxLife) {
  if (life === "在途") return "primary";
  if (life === "未使用") return "success";
  if (life === "待激活") return "warning";
  return "info";
}

function shortTime(value: string) {
  const matched = value.match(/^\d{4}-(\d{2}-\d{2}) (\d{2}:\d{2})/);
  if (matched) return `${matched[1]} ${matched[2]}`;
  return value || "—";
}

function toggle(life: BoxLife) {
  lifeFilter.value = lifeFilter.value === life ? "" : life;
}

function openBox(id: string) {
  router.push(`/device/boxes/${id}`);
}

function onRow(row: SampleBox) {
  if (allow(BOX_PERM.detail)) openBox(row.id);
}

function rowClass() {
  return allow(BOX_PERM.detail) ? "can-open" : "";
}

function openActivate(box: SampleBox) {
  current.value = box;
  activateOpen.value = true;
}

function doActivate() {
  if (!current.value) return;
  if (requestActivate(current.value)) {
    ElMessage.success(`${current.value.id} 已等待设备确认`);
  }
  activateOpen.value = false;
}

async function simulate(box: SampleBox) {
  try {
    await ElMessageBox.confirm(
      "模拟这台箱子下次上线，并确认已经保存设备密钥。确认后状态变为未使用，所属仍是总公司。",
      "模拟箱子确认",
      { type: "warning", confirmButtonText: "确认", cancelButtonText: "取消" }
    );
  } catch {
    return;
  }
  if (confirmDevice(box)) ElMessage.success(`${box.id} 已变为未使用`);
}

async function stop(box: SampleBox) {
  try {
    await ElMessageBox.confirm(`${box.id} 停用后不能再绑定新任务。`, "停用采样箱", {
      type: "warning",
      confirmButtonText: "停用",
      cancelButtonText: "取消",
    });
  } catch {
    return;
  }
  if (disableBox(box)) ElMessage.success(`${box.id} 已停用`);
}

async function resume(box: SampleBox) {
  try {
    await ElMessageBox.confirm(`恢复 ${box.id} 后，状态变为未使用。`, "恢复采样箱", {
      type: "warning",
      confirmButtonText: "恢复",
      cancelButtonText: "取消",
    });
  } catch {
    return;
  }
  if (restoreBox(box)) ElMessage.success(`${box.id} 已恢复为未使用`);
}
</script>

<style scoped>
.stats {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
}
.stat {
  display: flex;
  gap: 12px;
  align-items: baseline;
  justify-content: space-between;
  padding: 10px 14px;
  text-align: left;
  cursor: pointer;
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color);
  border-radius: 8px;
}
.stat strong {
  font-size: 20px;
  line-height: 1;
}
.stat.on {
  background: var(--el-color-primary-light-9);
  border-color: var(--el-color-primary);
}
.stat.warn {
  background: var(--el-color-warning-light-9);
  border-color: var(--el-color-warning);
}
.stat.warn.on {
  box-shadow: inset 0 0 0 1px var(--el-color-warning);
}
.block {
  margin-top: 12px;
}
.box-id {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.box-id span,
.place {
  font-size: 12px;
  line-height: 1.4;
  color: var(--el-text-color-secondary);
}
.place {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.time {
  white-space: nowrap;
}
.ops {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 8px;
}
:deep(tr.can-open) {
  cursor: pointer;
}
@media (max-width: 800px) {
  .stats {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
