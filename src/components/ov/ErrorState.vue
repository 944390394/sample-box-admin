<template>
  <el-alert type="warning" :closable="false" show-icon class="ov-error">
    <template #title>
      {{ message }}
      <el-button link type="primary" size="small" :loading="retrying" @click="emit('retry')">
        重试
      </el-button>
      <!-- 额外出口（如「返回我的总览」）：错态不能只留重试，范围外/不存在的资源重试永远不会成功 -->
      <slot />
    </template>
  </el-alert>
</template>

<script setup lang="ts">
withDefaults(defineProps<{ message?: string; retrying?: boolean }>(), {
  message: "加载失败",
  retrying: false,
});
const emit = defineEmits<{ retry: [] }>();
</script>

<style scoped>
.ov-error {
  margin-bottom: 12px;
}
</style>
