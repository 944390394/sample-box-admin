<template>
  <div class="page-container">
    <el-card shadow="never">
      <div class="toolbar">
        <el-button type="primary" @click="$router.push('/task/create')">创建任务单</el-button>
      </div>
      <el-steps :active="1" align-center finish-status="success" class="steps">
        <el-step title="待采样" />
        <el-step title="采样中" />
        <el-step title="已封箱" />
        <el-step title="在途" />
        <el-step title="待核验" />
        <el-step title="已签收" />
      </el-steps>
      <el-table :data="tasks">
        <el-table-column prop="no" label="单号" width="160" />
        <el-table-column prop="name" label="名称" />
        <el-table-column prop="org" label="分公司" width="120" />
        <el-table-column prop="box" label="采样箱" width="110" />
        <el-table-column prop="place" label="计划地点" />
        <el-table-column prop="people" label="授权人员" width="110" />
        <el-table-column prop="status" label="状态" width="100" />
      </el-table>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { tasks } from "../data";
</script>

<style scoped>
.toolbar {
  margin-bottom: 16px;
}
.steps {
  margin-bottom: 18px;
}
</style>
