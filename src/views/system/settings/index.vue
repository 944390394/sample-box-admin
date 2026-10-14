<template>
  <div class="page-container">
    <el-card v-loading="loading" shadow="never">
      <el-descriptions :column="1" border>
        <el-descriptions-item label="接入方式">{{ settings?.mode }}</el-descriptions-item>
        <el-descriptions-item label="服务器地址">{{ settings?.address }}</el-descriptions-item>
        <el-descriptions-item label="端口">{{ portText }}</el-descriptions-item>
        <el-descriptions-item label="说明">{{ settings?.hint }}</el-descriptions-item>
        <el-descriptions-item label="管理端地址">{{ settings?.adminUrl }}</el-descriptions-item>
        <el-descriptions-item label="TCP 监听">{{ listeningText }}</el-descriptions-item>
        <el-descriptions-item label="程序版本">{{ settings?.version }}</el-descriptions-item>
        <el-descriptions-item label="证书到期日">
          {{ settings?.certExpiresAt }}
        </el-descriptions-item>
      </el-descriptions>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import SettingsAPI, { type TcpSettings } from "@/api/system/settings";

const loading = ref(false);
const settings = ref<TcpSettings | null>(null);
const portText = computed(() => (settings.value?.port == null ? "" : String(settings.value.port)));
const listeningText = computed(() => {
  if (!settings.value) return "";
  return settings.value.listening ? "正在监听" : "未在监听";
});

async function load() {
  loading.value = true;
  try {
    settings.value = await SettingsAPI.get();
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>
