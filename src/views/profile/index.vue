<template>
  <div v-loading="loading" class="page-container page-flow profile-page">
    <el-alert
      v-if="loadFailed"
      title="个人资料加载失败，请刷新重试"
      type="error"
      :closable="false"
    />
    <section class="profile-hero">
      <el-avatar class="profile-avatar" :size="64" :aria-label="displayName + '的文字头像'">
        {{ avatarText }}
      </el-avatar>
      <div class="profile-hero__info">
        <div class="profile-hero__title">
          <h2>{{ displayName }}</h2>
          <el-tag v-for="role in roleList" :key="role" size="small" effect="light">
            {{ role }}
          </el-tag>
        </div>
        <p>{{ userProfile.username || "—" }} / {{ userProfile.deptName || "未分配部门" }}</p>
        <span class="profile-hero__meta">加入 {{ userProfile.createTime || "—" }}</span>
      </div>
    </section>
    <div class="profile-layout">
      <aside class="profile-column">
        <section class="profile-card">
          <h3>个人资料</h3>
          <dl class="profile-info">
            <div v-for="item in profileInfo" :key="item.label">
              <dt>{{ item.label }}</dt>
              <dd :class="{ 'is-muted': item.unavailable }">{{ item.value }}</dd>
            </div>
          </dl>
        </section>
      </aside>
      <main class="profile-column">
        <section class="profile-card">
          <h3>安全设置</h3>
          <p class="profile-card__desc">账户凭证与身份验证方式</p>
          <div class="profile-security">
            <div v-for="item in securityItems" :key="item.title" class="profile-security__item">
              <span class="profile-icon" :class="{ 'is-muted': item.unavailable }">
                <el-icon><component :is="item.icon" /></el-icon>
              </span>
              <div>
                <div class="profile-security__title">
                  <strong>{{ item.title }}</strong>
                  <el-tag size="small" :type="item.unavailable ? 'info' : 'success'" effect="plain">
                    {{ item.status }}
                  </el-tag>
                </div>
                <p>{{ item.description }}</p>
                <el-button
                  v-if="item.title === '账户密码'"
                  type="primary"
                  link
                  @click="passwordOpen = true"
                >
                  修改密码
                </el-button>
              </div>
            </div>
          </div>
        </section>
        <WechatBindCard />
      </main>
    </div>
    <PasswordDialog v-model="passwordOpen" />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { Lock } from "@element-plus/icons-vue";
import UserAPI, { type UserProfileDetail } from "@/api/system/user";
import { useUserStore } from "@/stores/user";
import { userAvatarText } from "@/utils/user-avatar";
import PasswordDialog from "./PasswordDialog.vue";
import WechatBindCard from "./WechatBindCard.vue";

defineOptions({ name: "Profile" });
const userStore = useUserStore();
const userProfile = ref<UserProfileDetail>({});
const loading = ref(true);
const passwordOpen = ref(false);
const loadFailed = ref(false);
const identity = computed(() => ({
  nickname: userProfile.value.nickname || userStore.userInfo.nickname,
  username: userProfile.value.username || userStore.userInfo.username,
}));
const displayName = computed(
  () => identity.value.nickname || identity.value.username || "未命名用户"
);
const avatarText = computed(() => userAvatarText(identity.value));
const roleList = computed(() => [
  ...new Set(
    (userProfile.value.roleNames || "")
      .split(/[,，]/)
      .map((role) => role.trim())
      .filter(Boolean)
  ),
]);
const profileInfo = computed(() => [
  { label: "用户名", value: userProfile.value.username || "—" },
  {
    label: "手机号码",
    value: userProfile.value.mobile || "未填写，可请管理员在「人员」里补上",
    unavailable: !userProfile.value.mobile,
  },
  {
    label: "邮箱",
    value: userProfile.value.email || "未填写",
    unavailable: !userProfile.value.email,
  },
  {
    label: "性别",
    value: userProfile.value.gender === 1 ? "男" : userProfile.value.gender === 2 ? "女" : "未设置",
  },
  { label: "部门", value: userProfile.value.deptName || "未分配部门" },
  { label: "创建时间", value: String(userProfile.value.createTime || "—") },
]);
const securityItems = [
  {
    title: "账户密码",
    icon: Lock,
    status: "已设置",
    description: "验证原密码后设置新密码，修改后需重新登录",
    unavailable: false,
  },
];
onMounted(async () => {
  try {
    userProfile.value = await UserAPI.getProfile();
  } catch {
    loadFailed.value = true;
  } finally {
    loading.value = false;
  }
});
</script>

<style lang="scss" scoped>
.profile-page {
  gap: var(--page-gap);
}
.profile-hero,
.profile-card {
  background: var(--content-bg);
  border: 1px solid var(--card-border);
  border-radius: var(--card-radius);
  box-shadow: var(--card-shadow);
}
.profile-hero {
  display: flex;
  gap: 16px;
  align-items: center;
  padding: 24px;
}
.profile-avatar {
  flex-shrink: 0;
  font-size: 26px;
  font-weight: 600;
  color: var(--el-color-primary);
  background: var(--el-color-primary-light-9);
}
.profile-hero__info {
  min-width: 0;
  overflow-wrap: anywhere;
}
.profile-hero__title {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
}
.profile-hero h2 {
  margin: 0;
  font-size: 22px;
}
.profile-hero p {
  margin: 6px 0;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}
.profile-hero__meta {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.profile-layout {
  display: grid;
  grid-template-columns: minmax(300px, 380px) minmax(0, 1fr);
  gap: var(--page-gap);
  align-items: start;
}
.profile-column {
  display: grid;
  gap: var(--page-gap);
  min-width: 0;
}
.profile-card {
  padding: 20px;
}
.profile-card h3 {
  margin: 0 0 16px;
  font-size: 15px;
}
.profile-card__desc {
  margin: -8px 0 16px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.profile-info {
  margin: 0;
  font-size: 13px;
}
.profile-info > div {
  display: grid;
  grid-template-columns: 80px minmax(0, 1fr);
  gap: 12px;
  padding: 12px 0;
  border-bottom: 1px solid var(--el-border-color-extra-light);
}
.profile-info > div:first-child {
  padding-top: 0;
}
.profile-info > div:last-child {
  padding-bottom: 0;
  border: 0;
}
.profile-info dt {
  color: var(--el-text-color-secondary);
}
.profile-info dd {
  min-width: 0;
  margin: 0;
  overflow-wrap: anywhere;
}
.profile-stats {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
.profile-stats > div {
  padding: 14px;
  background: var(--el-fill-color-lighter);
  border-radius: 8px;
}
.profile-stats span {
  display: block;
  margin-bottom: 4px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.profile-stats strong {
  font-size: 22px;
}
.profile-stats small {
  font-size: 12px;
  font-weight: 400;
  color: var(--el-text-color-secondary);
}
.profile-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.profile-tags .el-tag {
  margin: 0;
}
.profile-security {
  display: grid;
  gap: 12px;
}
.profile-security__item {
  display: grid;
  grid-template-columns: 40px minmax(0, 1fr);
  gap: 12px;
  align-items: center;
  padding: 14px;
  border: 1px solid var(--el-border-color-extra-light);
  border-radius: 8px;
}
.profile-icon {
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  font-size: 20px;
  color: var(--el-color-primary);
  background: var(--el-color-primary-light-9);
  border-radius: 8px;
}
.profile-icon.is-muted {
  background: var(--el-fill-color-light);
}
.profile-security__title {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  font-size: 14px;
}
.profile-security__item p {
  margin: 6px 0 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--el-text-color-secondary);
  overflow-wrap: anywhere;
}
.is-muted {
  color: var(--el-text-color-secondary);
}
@media (width <= 800px) {
  .profile-layout {
    grid-template-columns: minmax(0, 1fr);
    gap: 12px;
  }
  .profile-column {
    gap: 12px;
  }
  .profile-hero,
  .profile-card {
    padding: 16px;
  }
  .profile-hero h2 {
    font-size: 20px;
  }
}
</style>
