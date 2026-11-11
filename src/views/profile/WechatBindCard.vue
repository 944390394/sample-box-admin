<template>
  <section class="profile-card">
    <h3>微信绑定</h3>
    <p class="profile-card__desc">
      绑定后打开「{{ brandTitle }}」小程序自动登录，扫箱码就能看状态、签收、建任务单
    </p>
    <div v-if="state.bound" class="wx-row">
      <el-avatar :size="44" :src="state.avatar || undefined">
        {{ (state.nickname || "微").slice(0, 1) }}
      </el-avatar>
      <div class="wx-info">
        <strong>{{ state.nickname || "微信用户" }}</strong>
        <p>
          绑定于
          <TimeText :value="state.boundAt" mode="short" />
          · 最近登录
          <TimeText :value="state.lastLoginAt" />
        </p>
      </div>
      <el-button @click="openQr">换一个微信</el-button>
      <el-button type="danger" plain @click="unbind">解绑</el-button>
    </div>
    <div v-else class="wx-row">
      <div class="wx-info">
        <strong>还没有绑定微信</strong>
        <p>在网页上生成二维码，用小程序一扫就绑好，手机上不用输密码</p>
      </div>
      <el-button type="primary" @click="openQr">扫码绑定</el-button>
    </div>

    <el-dialog
      v-model="qrOpen"
      :title="state.bound ? '换一个微信' : '用小程序扫码绑定微信'"
      width="560px"
      style="max-width: 94vw"
      @closed="stop"
    >
      <div class="bind">
        <div class="bind-qr">
          <div class="qr">
            <img v-if="image" :src="image" alt="微信绑定二维码" :class="{ dim: left <= 0 }" />
            <div v-if="left <= 0" class="expired">
              <span>二维码已过期</span>
              <el-button type="primary" size="small" @click="refresh">刷新</el-button>
            </div>
          </div>
          <p class="countdown">
            {{
              left > 0
                ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")} 后过期 · 只能用一次`
                : "请刷新后再扫"
            }}
          </p>
        </div>
        <div class="bind-steps">
          <div class="step-group">
            <ol>
              <li>在微信里打开「{{ brandTitle }}」小程序；</li>
              <li>
                没登录时，在登录页点「扫网页上的绑定二维码」；已登录的在首页点「扫码」也可以；
              </li>
              <li>扫这个二维码并确认。</li>
            </ol>
          </div>
          <p class="hint">绑好后这里会自动显示已绑定。</p>
        </div>
      </div>
    </el-dialog>
  </section>
</template>

<script setup lang="ts">
import QRCode from "qrcode";
import UserAPI from "@/api/system/user";
import type { MyWechat } from "@/api/system/user/types";
import TimeText from "@/components/biz/TimeText.vue";
import { useBranding } from "@/composables/useBranding";

/**
 * 个人中心的微信绑定：看我绑的是哪个微信、解绑；没绑或要换绑时生成二维码给小程序扫。
 * 二维码 5 分钟有效、只能用一次；打开期间每 2 秒查一次，绑好了自动关掉。
 */
const state = ref<MyWechat>({ bound: false });
const { branding } = useBranding();
const brandTitle = computed(() => branding.title);
const qrOpen = ref(false);
const image = ref("");
const left = ref(0);
let expiresAt = 0;
let timer = 0;
let boundBefore = "";

async function load() {
  state.value = await UserAPI.myWechat();
}

async function refresh() {
  const { ticket, expiresAt: until } = await UserAPI.wechatTicket();
  expiresAt = new Date(until).getTime();
  image.value = await QRCode.toDataURL(`${window.location.origin}/qr/bind/?t=${ticket}`, {
    width: 480,
    margin: 1,
    errorCorrectionLevel: "M",
  });
  tick();
}

function tick() {
  left.value = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
}

async function openQr() {
  boundBefore = state.value.bound ? `${state.value.boundAt}` : "";
  qrOpen.value = true;
  try {
    await refresh();
  } catch {
    qrOpen.value = false;
    return;
  }
  window.clearInterval(timer);
  timer = window.setInterval(async () => {
    tick();
    if (left.value <= 0) return;
    try {
      const next = await UserAPI.myWechat();
      // 换绑时看绑定时间有没有变
      if (next.bound && `${next.boundAt}` !== boundBefore) {
        state.value = next;
        qrOpen.value = false;
        ElMessage.success(`已绑定微信${next.nickname ? `「${next.nickname}」` : ""}`);
      }
    } catch {
      /* 下一轮再查 */
    }
  }, 2000);
}

function stop() {
  window.clearInterval(timer);
  image.value = "";
}

async function unbind() {
  try {
    await ElMessageBox.confirm("解绑后这个微信打开小程序不再自动登录，需要重新绑定。", "解绑微信", {
      type: "warning",
      confirmButtonText: "解绑",
      cancelButtonText: "取消",
    });
  } catch {
    return;
  }
  await UserAPI.unbindMyWechat();
  ElMessage.success("已解绑微信");
  await load();
}

onMounted(() => void load().catch(() => undefined));
onBeforeUnmount(stop);
</script>

<style scoped>
/* 卡片外框由个人中心页给（.profile-card），标题和说明在这里对齐那边的字号 */
h3 {
  margin: 0 0 16px;
  font-size: 15px;
}
.profile-card__desc {
  margin: -8px 0 16px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.wx-row {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: center;
}
.wx-info {
  flex: 1;
  min-width: 200px;
}
.wx-info p {
  margin: 4px 0 0;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}
/* 绑定弹窗：左边二维码，右边扫码步骤 */
.bind {
  display: flex;
  gap: 24px;
  align-items: flex-start;
}
.bind-qr {
  flex: none;
}
.bind-steps {
  flex: 1;
  min-width: 0;
}
.step-group {
  margin-bottom: 14px;
}
.step-group ol {
  padding-left: 20px;
  margin: 0;
  font-size: 13px;
  line-height: 1.8;
  color: var(--el-text-color-regular);
}
.hint {
  padding: 8px 12px;
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--el-color-success-dark-2);
  background: var(--el-color-success-light-9);
  border-radius: 6px;
}
@media (max-width: 640px) {
  .bind {
    flex-direction: column;
    align-items: center;
  }
}
.qr {
  position: relative;
  display: flex;
  justify-content: center;
}
.qr img {
  width: 240px;
  height: 240px;
}
.qr img.dim {
  opacity: 0.15;
}
.expired {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
  align-items: center;
  justify-content: center;
  font-weight: 600;
}
.countdown {
  margin: 8px 0 12px;
  font-size: 13px;
  color: var(--el-text-color-secondary);
  text-align: center;
}
</style>
