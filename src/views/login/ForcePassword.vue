<template>
  <div class="force-page">
    <el-card shadow="never" class="force-card">
      <div class="brand">智采 · 采样箱</div>
      <h1>请先修改密码</h1>
      <p class="reason">{{ reasonText }}</p>
      <el-alert v-if="rule" :title="`密码规则：${rule}`" type="info" :closable="false" show-icon />
      <el-form
        ref="formRef"
        :model="form"
        :rules="rules"
        label-position="top"
        :disabled="saving"
        class="form"
        @submit.prevent="submit"
      >
        <el-form-item label="当前密码" prop="oldPassword">
          <el-input
            v-model="form.oldPassword"
            type="password"
            show-password
            autocomplete="current-password"
            :maxlength="1024"
          />
        </el-form-item>
        <el-form-item label="新密码" prop="newPassword">
          <el-input
            v-model="form.newPassword"
            type="password"
            show-password
            autocomplete="new-password"
            :maxlength="128"
          />
        </el-form-item>
        <el-form-item label="再输一次新密码" prop="confirmPassword">
          <el-input
            v-model="form.confirmPassword"
            type="password"
            show-password
            autocomplete="new-password"
            :maxlength="128"
            @keyup.enter="submit"
          />
        </el-form-item>
      </el-form>
      <div class="ops">
        <el-button link :disabled="saving" @click="leave">退出登录</el-button>
        <el-button type="primary" :loading="saving" @click="submit">修改并重新登录</el-button>
      </div>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import type { FormInstance, FormRules } from "element-plus";
import UserAPI from "@/api/system/user";
import { useUserStore } from "@/stores";
import { redirectToLogin } from "@/utils/auth";

/**
 * 强制改密：新建账号、管理员重置或要求改密、密码超过更换周期时，登录后先到这里。
 * 改完所有登录失效，用新密码重新登录。
 */
const userStore = useUserStore();
const formRef = ref<FormInstance>();
const saving = ref(false);
const form = reactive({ oldPassword: "", newPassword: "", confirmPassword: "" });
const rule = computed(() => userStore.userInfo?.passwordRule || "");
const reasonText = computed(() =>
  userStore.userInfo?.passwordChange === "expired"
    ? "你的密码已超过系统规定的使用期限，修改后才能继续使用。"
    : "这是新账号或密码刚被管理员重置，为了账号安全，请先换成只有你自己知道的密码。"
);
const rules: FormRules = {
  oldPassword: [{ required: true, message: "请输入当前密码", trigger: "blur" }],
  newPassword: [
    { required: true, message: "请输入新密码", trigger: "blur" },
    {
      validator: (_r, v, cb) =>
        cb(v && v === form.oldPassword ? new Error("新密码不能和当前密码相同") : undefined),
      trigger: "blur",
    },
  ],
  confirmPassword: [
    { required: true, message: "请再输一次新密码", trigger: "blur" },
    {
      validator: (_r, v, cb) =>
        cb(v !== form.newPassword ? new Error("两次输入的新密码不一致") : undefined),
      trigger: "blur",
    },
  ],
};

onMounted(async () => {
  if (!userStore.userInfo?.roles?.length) {
    try {
      await userStore.getUserInfo();
    } catch {
      /* 读不到账号信息时仍可以改密或退出 */
    }
  }
});

async function submit() {
  if (saving.value || !(await formRef.value?.validate().catch(() => false))) return;
  saving.value = true;
  try {
    await UserAPI.changePassword({ ...form });
    ElMessage.success("密码已修改，请用新密码重新登录");
    await redirectToLogin("", false);
  } catch {
    /* 错误由请求拦截器提示，表单保留 */
  } finally {
    saving.value = false;
  }
}

async function leave() {
  await userStore.logout().catch(() => undefined);
  await redirectToLogin("", false);
}
</script>

<style scoped>
.force-page {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  padding: 16px;
  background: var(--el-bg-color-page);
}
.force-card {
  width: min(440px, 100%);
  padding: 8px 12px;
  border-radius: 12px;
}
.brand {
  font-size: 13px;
  color: var(--el-color-primary);
}
h1 {
  margin: 8px 0 4px;
  font-size: 22px;
}
.reason {
  margin: 0 0 16px;
  font-size: 13px;
  line-height: 1.7;
  color: var(--el-text-color-secondary);
}
.form {
  margin-top: 16px;
}
.ops {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
</style>
