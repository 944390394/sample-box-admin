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

    <el-card v-loading="loading" class="database-card" shadow="never" header="数据库">
      <p class="database-tip">主机留空时继续使用 SQLite。密码只写入，不会回显。</p>
      <el-form label-width="88px">
        <el-form-item label="主机">
          <el-input
            v-model="form.host"
            :disabled="!isAdmin"
            placeholder="留空则使用 SQLite"
            clearable
          />
        </el-form-item>
        <el-form-item label="端口">
          <el-input v-model="form.port" :disabled="!isAdmin" />
        </el-form-item>
        <el-form-item label="库名">
          <el-input v-model="form.database" :disabled="!isAdmin" />
        </el-form-item>
        <el-form-item label="账号">
          <el-input v-model="form.user" :disabled="!isAdmin" />
        </el-form-item>
        <el-form-item label="密码">
          <el-input
            v-model="form.password"
            type="password"
            show-password
            autocomplete="new-password"
            :disabled="!isAdmin"
            :placeholder="passwordHint"
          />
        </el-form-item>
        <el-form-item v-if="isAdmin">
          <el-button type="primary" :loading="saving" @click="save">保存</el-button>
        </el-form-item>
      </el-form>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import SettingsAPI, { type TcpSettings } from "@/api/system/settings";
import { useUserStore } from "@/stores/user";

const userStore = useUserStore();
const loading = ref(false);
const saving = ref(false);
const settings = ref<TcpSettings | null>(null);
const form = reactive({
  host: "",
  port: "3306",
  database: "",
  user: "",
  password: "",
});
const passwordSet = ref(false);
const isAdmin = computed(() => (userStore.userInfo.roles || []).includes("ADMIN"));
const portText = computed(() => (settings.value?.port == null ? "" : String(settings.value.port)));
const listeningText = computed(() => {
  if (!settings.value) return "";
  return settings.value.listening ? "正在监听" : "未在监听";
});
const passwordHint = computed(() => (passwordSet.value ? "已设置，留空则不修改" : "请输入密码"));

async function load() {
  loading.value = true;
  try {
    settings.value = await SettingsAPI.get();
    const database = settings.value.database;
    form.host = database?.host || "";
    form.port = String(database?.port || 3306);
    form.database = database?.database || "";
    form.user = database?.user || "";
    form.password = "";
    passwordSet.value = Boolean(database?.passwordSet);
  } finally {
    loading.value = false;
  }
}

async function save() {
  saving.value = true;
  try {
    const saved = await SettingsAPI.saveDatabase({
      host: form.host.trim(),
      port: Number(form.port),
      database: form.database.trim(),
      user: form.user.trim(),
      password: form.password,
    });
    form.password = "";
    passwordSet.value = saved.passwordSet;
    await load();
    ElMessage.success("已保存");
  } finally {
    saving.value = false;
  }
}

onMounted(load);
</script>

<style lang="scss" scoped>
.database-card {
  margin-top: 16px;
}

.database-tip {
  margin: 0 0 16px;
  color: var(--el-text-color-secondary);
}
</style>
