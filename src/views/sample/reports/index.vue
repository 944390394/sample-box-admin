<template>
  <div class="page-container">
    <el-card shadow="never">
      <template v-if="serverMode">
        <el-form :inline="true">
          <el-form-item label="采样箱">
            <el-select v-model="boxId" filterable placeholder="选择采样箱" style="width: 180px">
              <el-option v-for="box in boxes" :key="box.id" :label="box.id" :value="box.id" />
            </el-select>
          </el-form-item>
          <el-form-item label="时间">
            <el-date-picker
              v-model="range"
              :editable="false"
              type="datetimerange"
              range-separator="~"
              start-placeholder="开始时间"
              end-placeholder="结束时间"
              value-format="YYYY-MM-DD HH:mm:ss"
              style="width: 380px"
            />
          </el-form-item>
          <el-form-item>
            <el-button type="primary" @click="search">查询</el-button>
          </el-form-item>
        </el-form>
        <el-table v-loading="loading" :data="rows">
          <el-table-column prop="time" label="时间" min-width="188" />
          <el-table-column prop="box" label="采样箱" width="110" />
          <el-table-column prop="text" label="类型" width="110" />
          <el-table-column label="基站" min-width="180">
            <template #default="{ row }">{{ coord(row.lbsLng, row.lbsLat) }}</template>
          </el-table-column>
          <el-table-column label="GPS" min-width="180">
            <template #default="{ row }">{{ coord(row.gpsLng, row.gpsLat) }}</template>
          </el-table-column>
          <el-table-column label="原文" width="90">
            <template #default="{ row }">
              <el-button link type="primary" @click="openRaw(row)">查看</el-button>
            </template>
          </el-table-column>
        </el-table>
        <div class="pager">
          <el-button :disabled="pageIndex === 0" @click="prev">上一页</el-button>
          <el-button :disabled="!nextCursor" @click="next">下一页</el-button>
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

    <el-dialog v-model="rawOpen" title="上报原文" width="640px">
      <pre class="raw">{{ rawText }}</pre>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import SampleBoxAPI, { type BoxLogItem } from "@/api/sample/box";
import type { SampleBox } from "@/views/sample/data";

import { reports } from "../data";

const serverMode = import.meta.env.VITE_MOCK_DEV_SERVER !== "true";
const loading = ref(false);
const boxes = ref<SampleBox[]>([]);
const boxId = ref("");
const rows = ref<BoxLogItem[]>([]);
const range = ref<[string, string]>(defaultRange());
const cursors = ref<({ time: string; id: string } | null)[]>([null]);
const pageIndex = ref(0);
const nextCursor = ref<{ time: string; id: string } | null>(null);
const rawOpen = ref(false);
const rawText = ref("");

function pad(value: number) {
  return String(value).padStart(2, "0");
}

function formatDate(date: Date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function defaultRange(): [string, string] {
  const end = new Date();
  const start = new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000);
  return [formatDate(start), formatDate(end)];
}

function coord(lng: number | null, lat: number | null) {
  if (lng == null || lat == null) return "—";
  return `${lng.toFixed(7)}, ${lat.toFixed(7)}`;
}

async function loadBoxes() {
  boxes.value = await SampleBoxAPI.list();
  if (!boxId.value && boxes.value[0]) boxId.value = boxes.value[0].id;
}

async function load() {
  const [from, to] = range.value || [];
  if (!boxId.value || !from || !to) return;
  loading.value = true;
  try {
    const cursor = cursors.value[pageIndex.value];
    const page = await SampleBoxAPI.logs(boxId.value, {
      from,
      to,
      limit: 20,
      cursorTime: cursor?.time,
      cursorId: cursor?.id,
    });
    rows.value = page.list;
    nextCursor.value = page.nextCursor;
  } finally {
    loading.value = false;
  }
}

function search() {
  cursors.value = [null];
  pageIndex.value = 0;
  load();
}

function next() {
  if (!nextCursor.value) return;
  cursors.value = cursors.value.slice(0, pageIndex.value + 1);
  cursors.value.push(nextCursor.value);
  pageIndex.value += 1;
  load();
}

function prev() {
  if (pageIndex.value === 0) return;
  pageIndex.value -= 1;
  load();
}

async function openRaw(row: unknown) {
  const item = row as BoxLogItem;
  if (!item.id) return;
  const data = await SampleBoxAPI.raw(boxId.value, item.id, item.time);
  try {
    rawText.value = JSON.stringify(JSON.parse(data.raw), null, 2);
  } catch {
    rawText.value = data.raw;
  }
  rawOpen.value = true;
}

onMounted(async () => {
  if (!serverMode) return;
  await loadBoxes();
  await load();
});
</script>

<style lang="scss" scoped>
.pager {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 12px;
}

.raw {
  margin: 0;
  overflow: auto;
  white-space: pre-wrap;
}
</style>
