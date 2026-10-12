<template>
  <div class="page-container">
    <el-card shadow="never">
      <el-table v-if="serverMode" :data="rows">
        <el-table-column prop="time" label="时间" min-width="188" />
        <el-table-column prop="box" label="采样箱" width="110" />
        <el-table-column prop="text" label="类型" width="110" />
        <el-table-column label="基站" min-width="180">
          <template #default="{ row }">{{ coord(row.lbsLng, row.lbsLat) }}</template>
        </el-table-column>
        <el-table-column label="GPS" min-width="180">
          <template #default="{ row }">{{ coord(row.gpsLng, row.gpsLat) }}</template>
        </el-table-column>
      </el-table>
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
  </div>
</template>

<script setup lang="ts">
import SampleBoxAPI, { type BoxLogItem } from "@/api/sample/box";
import { reports } from "../data";

const serverMode = import.meta.env.VITE_MOCK_DEV_SERVER !== "true";
const rows = ref<BoxLogItem[]>([]);
let poll = 0;

function coord(lng: number | null, lat: number | null) {
  if (lng == null || lat == null) return "—";
  return `${lng.toFixed(7)}, ${lat.toFixed(7)}`;
}

async function load() {
  rows.value = await SampleBoxAPI.reports();
}

onMounted(() => {
  if (!serverMode) return;
  load();
  poll = window.setInterval(load, 3000);
});

onUnmounted(() => window.clearInterval(poll));
</script>
