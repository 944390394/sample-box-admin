<template>
  <div class="page-container">
    <el-card class="page-search" shadow="never">
      <el-form :inline="true" label-width="auto">
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
        <el-form-item label="操作者">
          <el-input v-model="actor" clearable placeholder="姓名或编号" @keyup.enter="search" />
        </el-form-item>
        <el-form-item label="对象">
          <el-input
            v-model="targetId"
            clearable
            placeholder="用户、部门或箱子"
            @keyup.enter="search"
          />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" @click="search">查询</el-button>
        </el-form-item>
      </el-form>
    </el-card>

    <el-card class="page-content" shadow="never">
      <el-table v-loading="loading" :data="list" border>
        <el-table-column prop="createdAt" label="时间" min-width="188" />
        <el-table-column prop="orgName" label="组织" min-width="120" />
        <el-table-column prop="actorName" label="操作者" min-width="120" />
        <el-table-column prop="action" label="动作" width="120" />
        <el-table-column label="对象" min-width="160">
          <template #default="{ row }">{{ targetText(row) }}</template>
        </el-table-column>
        <el-table-column label="结果" width="90" align="center">
          <template #default="{ row }">
            <el-tag :type="row.result === '成功' ? 'success' : 'danger'" size="small">
              {{ row.result }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="ip" label="来源 IP" min-width="140" />
      </el-table>
      <div class="pager">
        <el-button :disabled="pageIndex === 0" @click="prev">上一页</el-button>
        <el-button :disabled="!nextCursor" @click="next">下一页</el-button>
      </div>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import OperationLogAPI, {
  type OperationLogCursor,
  type OperationLogItem,
} from "@/api/system/operation-log";

defineOptions({
  name: "OperationLog",
  inheritAttrs: false,
});

const loading = ref(false);
const list = ref<OperationLogItem[]>([]);
const actor = ref("");
const targetId = ref("");
const range = ref<[string, string]>(defaultRange());
const cursors = ref<(OperationLogCursor | null)[]>([null]);
const pageIndex = ref(0);
const nextCursor = ref<OperationLogCursor | null>(null);

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

function targetText(row: unknown) {
  const item = row as OperationLogItem;
  return [item.targetType, item.targetId].filter(Boolean).join(" ");
}

async function load() {
  const [from, to] = range.value || [];
  if (!from || !to) {
    ElMessage.warning("请选择时间");
    return;
  }
  loading.value = true;
  try {
    const cursor = cursors.value[pageIndex.value];
    const page = await OperationLogAPI.page({
      from,
      to,
      limit: 20,
      actor: actor.value.trim() || undefined,
      targetId: targetId.value.trim() || undefined,
      cursorTime: cursor?.time,
      cursorId: cursor?.id,
    });
    list.value = page.list;
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

onMounted(load);
</script>

<style lang="scss" scoped>
.pager {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 12px;
}
</style>
