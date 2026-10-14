<template>
  <div class="page-container">
    <el-card v-loading="loading" shadow="never">
      <el-descriptions :column="1" border>
        <el-descriptions-item label="服务器地址">{{ address }}</el-descriptions-item>
        <el-descriptions-item label="端口">{{ portText }}</el-descriptions-item>
      </el-descriptions>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import SettingsAPI from "@/api/system/settings";

const loading = ref(false);
const address = ref("");
const port = ref<number | null>(null);
const portText = computed(() => (port.value == null ? "" : String(port.value)));

async function load() {
  loading.value = true;
  try {
    const data = await SettingsAPI.get();
    address.value = data.address;
    port.value = data.port;
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>
