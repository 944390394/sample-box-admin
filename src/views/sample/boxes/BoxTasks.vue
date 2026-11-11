<template>
  <div>
    <el-table
      v-loading="loading"
      :data="rows"
      empty-text="这台箱子还没参与过任务"
      class="clickable"
      @row-click="(row: PolicyTask) => router.push(`/task/detail/${row.id}`)"
    >
      <el-table-column label="任务" min-width="200">
        <template #default="{ row }">
          <b>{{ row.name }}</b>
          <div class="text-muted">{{ row.id }}</div>
        </template>
      </el-table-column>
      <el-table-column label="类型" width="80" prop="kind" />
      <el-table-column label="路线 / 地点" min-width="200">
        <template #default="{ row }">
          {{
            row.kind === "调拨"
              ? `${row.fromOrg || "—"} → ${row.toOrg || "—"}`
              : row.org || row.place || "—"
          }}
        </template>
      </el-table-column>
      <el-table-column label="状态" width="100">
        <template #default="{ row }">
          <el-tag size="small" :type="taskTone(row.status)">{{ row.status }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="创建" width="160">
        <template #default="{ row }">
          {{ row.createdBy || "—" }} ·
          <TimeText :value="row.createdAt" mode="short" />
        </template>
      </el-table-column>
    </el-table>
    <DataPager v-model:page="page" :total="total" :page-size="20" />
  </div>
</template>

<script setup lang="ts">
import PolicyAPI, { type PolicyTask } from "@/api/sample/report-policy";
import DataPager from "@/components/biz/DataPager.vue";
import TimeText from "@/components/biz/TimeText.vue";
import { taskTone } from "@/utils/tone";

/** 采样箱详情 · 任务：这台箱子参与过的全部任务，点开看任务详情。 */
const props = defineProps<{ boxId: string }>();
const router = useRouter();
const rows = ref<PolicyTask[]>([]);
const total = ref(0);
const page = ref(1);
const loading = ref(false);

async function load() {
  loading.value = true;
  try {
    const result = await PolicyAPI.tasks({ boxId: props.boxId, page: page.value });
    rows.value = result.list;
    total.value = result.total;
  } finally {
    loading.value = false;
  }
}
watch(page, load);
onMounted(load);
</script>

<style scoped>
.clickable :deep(.el-table__row) {
  cursor: pointer;
}
</style>
