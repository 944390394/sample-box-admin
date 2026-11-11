<template>
  <el-dialog
    :model-value="modelValue"
    title="箱码"
    width="420px"
    style="max-width: 94vw"
    @update:model-value="(v: boolean) => emit('update:modelValue', v)"
  >
    <div class="label">
      <img v-if="image" :src="image" alt="箱码" />
      <b>{{ box.name || box.id }}</b>
      <span>IMEI {{ box.id }}</span>
      <small>微信扫码查看箱子状态、签收、建任务单</small>
    </div>
    <p class="tip">
      二维码内容是
      <code>{{ link }}</code>
      。在微信公众平台配置「扫普通链接二维码打开小程序」后，微信扫码直接进小程序的箱子页；不在微信里扫会打开网页后台。
    </p>
    <template #footer>
      <el-button @click="copy">复制链接</el-button>
      <el-button type="primary" :disabled="!image" @click="download">下载标签图片</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import QRCode from "qrcode";

/** 箱码：贴在箱子上的二维码标签。内容是固定链接 + IMEI，换小程序、换服务器都不用重印。 */
const props = defineProps<{ modelValue: boolean; box: { id: string; name?: string } }>();
const emit = defineEmits<{ "update:modelValue": [open: boolean] }>();
const image = ref("");
const link = computed(() => boxQrLink(props.box.id));

/** 箱码链接。小程序按 id 参数取箱号；微信后台「扫普通链接二维码」的规则前缀填 `<域名>/qr/box/`。 */
function boxQrLink(id: string) {
  return `${window.location.origin}/qr/box/?id=${encodeURIComponent(id)}`;
}

watch(
  () => [props.modelValue, link.value] as const,
  async ([open, text]) => {
    if (!open) return;
    image.value = await QRCode.toDataURL(text, {
      width: 480,
      margin: 1,
      errorCorrectionLevel: "M",
    });
  },
  { immediate: true }
);

async function copy() {
  try {
    await navigator.clipboard.writeText(link.value);
    ElMessage.success("已复制");
  } catch {
    ElMessage.warning("浏览器不允许复制，请手动选中链接");
  }
}

/** 二维码下面印名称和 IMEI，存成一张 PNG，直接拿去打印贴纸。 */
async function download() {
  const qr = new Image();
  qr.src = image.value;
  await qr.decode();
  const canvas = document.createElement("canvas");
  canvas.width = 560;
  canvas.height = 700;
  const g = canvas.getContext("2d");
  if (!g) return;
  g.fillStyle = "#fff";
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.drawImage(qr, 40, 30, 480, 480);
  g.fillStyle = "#111";
  g.textAlign = "center";
  g.font = "bold 40px sans-serif";
  g.fillText(props.box.name || props.box.id, 280, 570, 500);
  g.font = "26px monospace";
  g.fillText(`IMEI ${props.box.id}`, 280, 615, 500);
  g.fillStyle = "#666";
  g.font = "22px sans-serif";
  g.fillText("微信扫码查看箱子状态", 280, 660, 500);
  const a = document.createElement("a");
  a.href = canvas.toDataURL("image/png");
  a.download = `箱码_${props.box.name || props.box.id}.png`;
  a.click();
}
</script>

<style scoped>
.label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  align-items: center;
  padding: 12px;
  border: 1px dashed var(--el-border-color);
  border-radius: 8px;
}
.label img {
  width: 240px;
  height: 240px;
}
.label b {
  font-size: 18px;
}
.label span {
  font-family: monospace;
  color: var(--el-text-color-regular);
}
.label small {
  color: var(--el-text-color-secondary);
}
.tip {
  margin: 12px 0 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--el-text-color-secondary);
  word-break: break-all;
}
</style>
