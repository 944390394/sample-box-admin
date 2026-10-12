<template>
  <div class="screen">
    <header>
      <h1>采样箱监测大屏</h1>
      <span>{{ clock }}</span>
    </header>
    <div class="board">
      <el-card shadow="never" header="箱体状态">
        <div
          v-for="box in boxes"
          :key="box.id"
          class="row"
          :class="{ on: activeId === box.id }"
          @click="locate(box)"
        >
          <b>{{ box.id }}</b>
          <span>
            {{ box.life }}
            <em v-if="box.alert">· 异常</em>
          </span>
          <span class="place">基站 {{ lbsText(box) }}</span>
          <span class="place">GPS {{ gpsText(box) }}</span>
        </div>
      </el-card>
      <el-card shadow="never" class="map-card">
        <template #header>
          <div class="map-title">
            <span>采样箱位置</span>
            <small>天地图 · 点击箱号定位</small>
          </div>
        </template>
        <TiandituMap
          :points="points"
          :active-id="activeId"
          :focus-token="focusToken"
          @select="activeId = $event"
        />
      </el-card>
      <el-card shadow="never" header="异常流">
        <div v-for="item in alertRows" :key="item.rule + item.time" class="row">
          <b>{{ item.rule }}</b>
          <span>{{ item.box }} · {{ item.time }}</span>
        </div>
      </el-card>
    </div>
  </div>
</template>

<script setup lang="ts">
import SampleBoxAPI from "@/api/sample/box";
import { alerts, gpsText, lbsText, mapCoord, type SampleBox } from "../data";
import { boxSession } from "../box-state";

const serverMode = import.meta.env.VITE_MOCK_DEV_SERVER !== "true";
const clock = ref("");
const activeId = ref("");
const focusToken = ref(0);
const remoteBoxes = ref<SampleBox[]>([]);
let timer = 0;
let poll = 0;

const boxes = computed(() => (serverMode ? remoteBoxes.value : boxSession.boxes));
const alertRows = computed(() => (serverMode ? [] : alerts));

async function loadRemote() {
  remoteBoxes.value = await SampleBoxAPI.list();
}

const points = computed(() =>
  boxes.value.flatMap((box) => {
    const at = mapCoord(box);
    if (!at) return [];
    return [
      {
        id: box.id,
        lng: at.lng,
        lat: at.lat,
        title: box.id,
        status: box.alert ? "异常" : box.life,
        lines: [
          `基站 ${lbsText(box)}`,
          `GPS ${gpsText(box)}`,
          box.alert ? `${box.life} · 异常 · ${box.alert}` : `${box.life} · ${box.owner}`,
        ],
      },
    ];
  })
);

function tick() {
  clock.value = new Date().toLocaleString("zh-CN", { hour12: false });
}

function locate(box: (typeof boxSession.boxes)[number]) {
  if (!mapCoord(box)) {
    ElMessage.info(`${box.id} 还没有坐标`);
    return;
  }
  activeId.value = box.id;
  focusToken.value += 1;
}

onMounted(() => {
  tick();
  timer = window.setInterval(tick, 1000);
  if (!serverMode) return;
  loadRemote();
  poll = window.setInterval(loadRemote, 3000);
});
onUnmounted(() => {
  window.clearInterval(timer);
  window.clearInterval(poll);
});
</script>

<style scoped>
header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}
h1 {
  margin: 0;
  font-size: 22px;
}
.board {
  display: grid;
  grid-template-columns: 220px 1fr 260px;
  gap: 12px;
}
.board > * {
  min-width: 0;
}
.row {
  display: flex;
  flex-direction: column;
  min-width: 0;
  padding: 8px;
  cursor: pointer;
  border-bottom: 1px solid var(--el-border-color-lighter);
  border-radius: 6px;
}
.row b,
.row span {
  min-width: 0;
  overflow-wrap: anywhere;
  white-space: normal;
}
.place {
  line-height: 1.45;
  color: var(--el-text-color-secondary);
}
.row.on {
  background: var(--el-color-primary-light-9);
}
.row em {
  font-style: normal;
  color: #b45309;
}
.map-card :deep(.el-card__body) {
  height: 560px;
  padding: 0;
}
.map-title {
  display: flex;
  gap: 12px;
  align-items: baseline;
  justify-content: space-between;
}
.map-title small {
  font-weight: 400;
  color: var(--el-text-color-secondary);
}
@media (max-width: 1100px) {
  .board {
    grid-template-columns: 1fr;
  }
}
</style>
