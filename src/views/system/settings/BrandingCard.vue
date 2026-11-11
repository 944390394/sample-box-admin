<template>
  <el-card id="sec-branding" class="database-card" shadow="never" header="名称与图标">
    <p class="database-tip">
      网页后台的登录页、侧栏、浏览器标签，以及小程序的登录页、首页标题都用这里的名称和图标。小程序在微信里显示的名称和头像（分享卡片、最近使用）要到微信公众平台修改。
    </p>
    <div class="branding">
      <div class="logo-box">
        <img :src="form.logo || defaultLogo" alt="系统图标" />
        <template v-if="can">
          <el-upload
            :auto-upload="false"
            :show-file-list="false"
            accept="image/png,image/jpeg,image/webp"
            :on-change="onFile"
          >
            <el-button size="small">换图标</el-button>
          </el-upload>
          <el-button v-if="form.logo" size="small" link @click="form.logo = ''">恢复默认</el-button>
        </template>
        <span class="hint">PNG / JPG / WebP，建议正方形</span>
      </div>
      <el-form label-width="80px" class="fields">
        <el-form-item label="系统名称">
          <el-input
            v-model="form.title"
            maxlength="20"
            show-word-limit
            :disabled="!can"
            placeholder="智采 · 采样箱"
          />
        </el-form-item>
        <el-form-item label="标语">
          <el-input
            v-model="form.slogan"
            maxlength="40"
            show-word-limit
            :disabled="!can"
            placeholder="小程序登录页名称下面的一行字，可留空"
          />
        </el-form-item>
        <el-form-item v-if="can">
          <el-button type="primary" :loading="saving" @click="save">保存</el-button>
        </el-form-item>
      </el-form>
    </div>
  </el-card>
</template>

<script setup lang="ts">
import SettingsAPI, { type BrandingSettings } from "@/api/system/settings";
import defaultLogo from "@/assets/images/logo.png";
import { applyBranding } from "@/composables/useBranding";
import type { UploadFile } from "element-plus";

/** 系统设置 › 名称与图标。上传的图标在浏览器里缩到最长边 256 像素再存，保存后网页立即换上。 */
const props = defineProps<{ value?: BrandingSettings; can: boolean }>();
const form = reactive<BrandingSettings>({ title: "", slogan: "", logo: "" });
const saving = ref(false);

watch(
  () => props.value,
  (value) => value && Object.assign(form, value),
  { immediate: true }
);

/** 读图片 → 缩到 256 以内 → PNG data URL。 */
function shrink(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("读不出这张图片"));
    reader.onload = () => {
      const image = new Image();
      image.onerror = () => reject(new Error("这不是有效的图片"));
      image.onload = () => {
        const scale = Math.min(1, 256 / Math.max(image.width, image.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(image.width * scale));
        canvas.height = Math.max(1, Math.round(image.height * scale));
        canvas.getContext("2d")?.drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/png"));
      };
      image.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

async function onFile(file: UploadFile) {
  if (!file.raw) return;
  try {
    const url = await shrink(file.raw);
    if (url.length > 300000) {
      ElMessage.warning("图标太大，请换一张简单些的图片");
      return;
    }
    form.logo = url;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "图片读取失败");
  }
}

async function save() {
  saving.value = true;
  try {
    const saved = await SettingsAPI.saveBranding({ ...form });
    Object.assign(form, saved);
    applyBranding(saved);
    ElMessage.success("已保存，小程序下次打开时生效");
  } finally {
    saving.value = false;
  }
}
</script>

<style scoped>
.branding {
  display: flex;
  flex-wrap: wrap;
  gap: 24px;
  align-items: flex-start;
}
.logo-box {
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: center;
  width: 140px;
}
.logo-box img {
  width: 96px;
  height: 96px;
  object-fit: contain;
  background: var(--el-fill-color-lighter);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 20px;
}
.hint {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  text-align: center;
}
.fields {
  flex: 1;
  min-width: 280px;
  max-width: 560px;
}
</style>
