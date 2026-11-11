<template>
  <span v-if="place">
    {{ place.address || "已定位，未填地址文字" }}
    <el-tag v-if="place.custom" size="small" type="info">自定义</el-tag>
    <el-tag v-if="place.lng == null" size="small" type="warning">无坐标</el-tag>
    <el-tag v-else-if="place.radiusM" size="small" type="info">误差 {{ place.radiusM }} 米</el-tag>
  </span>
  <span v-else>{{ fallback || "—" }}</span>
</template>

<script setup lang="ts">
import type { Place } from "@/api/sample/report-policy";

defineProps<{ place?: Place | null; fallback?: string }>();
</script>
