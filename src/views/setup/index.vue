<template>
  <div class="setup-page">
    <el-card class="setup-card" shadow="never">
      <h1>连接数据库</h1>
      <p class="desc">
        第一次安装会建表，并写入总公司、分公司、合作采样机构和初始人员。安装完成后再次启动只补充新的表结构，不会清空已有数据。
      </p>
      <el-alert
        v-if="mockOn"
        class="mb"
        type="info"
        show-icon
        :closable="false"
        title="当前开发仍在使用本地名单。要让部门、角色、用户写入数据库，先运行 pnpm server，再把 VITE_MOCK_DEV_SERVER 改为 false，并把 VITE_APP_API_URL 改为 http://localhost:8000。"
      />
      <el-form label-width="96px">
        <el-form-item label="数据库">
          <el-radio-group v-model="form.dialect">
            <el-radio value="sqlite">SQLite</el-radio>
            <el-radio value="mysql">MySQL</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item v-if="form.dialect === 'sqlite'" label="文件">
          <el-input v-model="form.sqlitePath" />
        </el-form-item>
        <template v-else>
          <el-form-item label="主机">
            <el-input v-model="form.host" />
          </el-form-item>
          <el-form-item label="端口">
            <el-input v-model.number="form.port" />
          </el-form-item>
          <el-form-item label="用户名">
            <el-input v-model="form.user" />
          </el-form-item>
          <el-form-item label="密码">
            <el-input v-model="form.password" type="password" show-password />
          </el-form-item>
          <el-form-item label="库名">
            <el-input v-model="form.database" placeholder="先建好空库，这里只建表" />
          </el-form-item>
        </template>
        <el-form-item>
          <el-button :loading="testing" @click="onTest">测试连接</el-button>
          <el-button type="primary" :loading="installing" @click="onInstall">开始安装</el-button>
        </el-form-item>
      </el-form>
      <p class="hint">安装后的管理员是 admin，密码 123456。这次会建采样箱和原始上报表。</p>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { ElMessage } from "element-plus";
import { useRouter } from "vue-router";
import SetupAPI, { type SetupForm } from "@/api/setup";
import { markSetupInstalled } from "@/router/guards/permission";

const router = useRouter();
const mockOn = import.meta.env.VITE_MOCK_DEV_SERVER === "true";
const testing = ref(false);
const installing = ref(false);
const form = reactive<SetupForm>({
  dialect: "sqlite",
  sqlitePath: "server/data/sample-box.db",
  host: "127.0.0.1",
  port: 3306,
  user: "root",
  password: "",
  database: "sample_box",
});

async function onTest() {
  testing.value = true;
  try {
    await SetupAPI.test(form);
    ElMessage.success("连接成功");
  } finally {
    testing.value = false;
  }
}

async function onInstall() {
  installing.value = true;
  try {
    await SetupAPI.install(form);
    ElMessage.success("安装完成");
    markSetupInstalled(true);
    router.replace("/login");
  } finally {
    installing.value = false;
  }
}
</script>

<style scoped>
.setup-page {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  background: var(--el-bg-color-page);
}
.setup-card {
  width: 560px;
}
h1 {
  margin: 0 0 8px;
  font-size: 22px;
}
.desc,
.hint {
  line-height: 1.6;
  color: var(--el-text-color-secondary);
}
.mb {
  margin-bottom: 16px;
}
</style>
