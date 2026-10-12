<template>
  <div class="page-container">
    <el-card shadow="never">
      <el-table :data="commands">
        <el-table-column prop="time" label="创建时间" width="120" />
        <el-table-column prop="box" label="采样箱" width="120" />
        <el-table-column prop="cmd" label="指令" />
        <el-table-column prop="by" label="下达人" width="120" />
        <el-table-column prop="status" label="状态" width="140" />
      </el-table>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { commands } from "../data";
</script>
