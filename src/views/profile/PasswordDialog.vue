<template>
  <el-dialog
    v-model="visible"
    title="修改密码"
    width="min(460px, 94vw)"
    :close-on-click-modal="false"
    :close-on-press-escape="!saving"
    :show-close="!saving"
    @closed="clear"
  >
    <el-alert
      title="修改后所有已登录会话将失效，请使用新密码重新登录。"
      type="info"
      :closable="false"
    />
    <el-form
      ref="formRef"
      :model="form"
      :rules="rules"
      label-position="top"
      :disabled="saving"
      class="password-form"
      @submit.prevent="submit"
    >
      <el-form-item label="原密码" prop="oldPassword">
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
          :placeholder="userStore.userInfo?.passwordRule || ''"
          :maxlength="128"
        />
      </el-form-item>
      <el-form-item label="确认新密码" prop="confirmPassword">
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
    <template #footer>
      <el-button :disabled="saving" @click="visible = false">取消</el-button>
      <el-button type="primary" :loading="saving" @click="submit">确认修改</el-button>
    </template>
  </el-dialog>
</template>
<script setup lang="ts">
import { reactive, ref } from "vue";
import { ElMessage, type FormInstance, type FormRules } from "element-plus";
import UserAPI from "@/api/system/user";
import { redirectToLogin } from "@/utils/auth";
import { useUserStore } from "@/stores";
const userStore = useUserStore();
const visible = defineModel<boolean>({ default: false });
const saving = ref(false),
  formRef = ref<FormInstance>();
const form = reactive({ oldPassword: "", newPassword: "", confirmPassword: "" });
const rules: FormRules = {
  oldPassword: [{ required: true, message: "请输入原密码", trigger: "blur" }],
  newPassword: [
    { required: true, message: "请输入新密码", trigger: "blur" },
    {
      validator: (_r, v, cb) =>
        cb(v === form.oldPassword ? new Error("新密码不能与原密码相同") : undefined),
      trigger: "blur",
    },
  ],
  confirmPassword: [
    { required: true, message: "请确认新密码", trigger: "blur" },
    {
      validator: (_r, v, cb) =>
        cb(v !== form.newPassword ? new Error("两次输入的新密码不一致") : undefined),
      trigger: "blur",
    },
  ],
};
function clear() {
  Object.assign(form, { oldPassword: "", newPassword: "", confirmPassword: "" });
  formRef.value?.clearValidate();
}
async function submit() {
  if (saving.value || !(await formRef.value?.validate().catch(() => false))) return;
  if (saving.value) return;
  saving.value = true;
  try {
    await UserAPI.changePassword({ ...form });
    visible.value = false;
    clear();
    ElMessage.success("密码修改成功，请使用新密码重新登录");
    await redirectToLogin("", false);
  } catch {
    /* 接口拦截器显示错误，保留表单供用户修正。 */
  } finally {
    saving.value = false;
  }
}
</script>
<style scoped>
.password-form {
  margin-top: 20px;
}
</style>
