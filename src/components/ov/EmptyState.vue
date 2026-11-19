<template>
  <div class="ov-empty">
    <el-empty :description="description" :image-size="70">
      <slot />
    </el-empty>
  </div>
</template>

<script setup lang="ts">
withDefaults(defineProps<{ description?: string }>(), { description: "暂无数据" });
</script>

<style scoped>
.ov-empty {
  padding: 8px 0;
}
</style>
