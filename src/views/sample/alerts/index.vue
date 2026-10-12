<template>
  <div class="page-container">
    <el-row :gutter="12">
      <el-col v-for="item in alerts" :key="item.rule + item.box" :span="12" class="col">
        <el-card shadow="never">
          <el-tag :type="item.level === '高' ? 'danger' : 'warning'">{{ item.level }}</el-tag>
          <h3>{{ item.rule }}</h3>
          <p>{{ item.box }} · {{ item.detail }}</p>
          <span>{{ item.time }}</span>
        </el-card>
      </el-col>
    </el-row>
  </div>
</template>

<script setup lang="ts">
import { alerts } from "../data";
</script>

<style scoped>
.col {
  margin-bottom: 12px;
}
h3 {
  margin: 10px 0 6px;
}
p {
  margin: 0;
}
span {
  display: block;
  margin-top: 8px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
</style>
