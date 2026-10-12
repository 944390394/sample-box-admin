<template>
  <div class="page-container">
    <el-row :gutter="12">
      <el-col :span="8">
        <el-card shadow="never" header="扫码">
          <el-input v-model="code" placeholder="RW-202609-011" />
          <el-button class="mt" type="primary" @click="shown = true">查看核验单</el-button>
        </el-card>
      </el-col>
      <el-col :span="16">
        <el-card shadow="never" header="核验结果">
          <el-descriptions v-if="shown" :column="1" border>
            <el-descriptions-item label="任务">城东管网抽检</el-descriptions-item>
            <el-descriptions-item label="采样箱">BOX-003</el-descriptions-item>
            <el-descriptions-item label="开箱次数">
              2 次，其中 1 次发生在封箱后
            </el-descriptions-item>
            <el-descriptions-item label="计划地点">杭州余杭</el-descriptions-item>
            <el-descriptions-item label="实际位置">偏离计划地点</el-descriptions-item>
          </el-descriptions>
          <el-empty v-else description="输入任务单号后查看核验结论" />
        </el-card>
      </el-col>
    </el-row>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
const code = ref("RW-202609-011");
const shown = ref(false);
</script>

<style scoped>
.mt {
  margin-top: 12px;
}
</style>
