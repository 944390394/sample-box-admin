<template>
  <div class="page-container page-flow">
    <PageHeader
      title="系统设置"
      subtitle="每个分区单独保存。没有权限的分区不显示，只能查看的分区不能修改。"
    />
    <div class="settings-layout">
      <nav class="settings-nav">
        <a
          v-for="item in sections"
          :key="item.id"
          :class="{ on: activeSection === item.id }"
          @click="jump(item.id)"
        >
          {{ item.title }}
          <i v-if="dirtySections.some((d) => d.id === item.id)" class="dirty-dot" title="未保存" />
        </a>
      </nav>
      <div class="settings-main">
        <SettingsSection id="sec-access" v-loading="loading" title="接入信息">
          <InfoList :items="accessItems" label-width="140px" />
        </SettingsSection>

        <SettingsSection
          id="sec-map"
          v-loading="loading"
          title="地图"
          desc="天地图浏览器端密钥，所有看地图的页面都用它。安全密钥留空则不修改。"
        >
          <el-form label-width="140px">
            <el-form-item>
              <template #label>
                <span class="label-help">
                  应用密钥
                  <el-tag
                    :type="mapKeySource === 'none' ? 'info' : 'success'"
                    effect="plain"
                    size="small"
                  >
                    {{ MAP_SOURCE_TAG[mapKeySource] }}
                  </el-tag>
                </span>
              </template>
              <el-input
                v-model="mapForm.tk"
                :disabled="!can.map"
                :placeholder="mapTkHint"
                clearable
              />
              <div v-if="mapKeySource !== 'none'" class="form-extra">{{ mapTkHint }}</div>
            </el-form-item>
            <el-form-item>
              <template #label>
                <span class="label-help">
                  安全密钥
                  <el-tag
                    :type="mapSecretSource === 'none' ? 'info' : 'success'"
                    effect="plain"
                    size="small"
                  >
                    {{ MAP_SOURCE_TAG[mapSecretSource] }}
                  </el-tag>
                </span>
              </template>
              <el-input
                v-model="mapForm.sk"
                type="password"
                show-password
                autocomplete="new-password"
                :disabled="!can.map"
                :placeholder="mapSkHint"
              />
              <div v-if="mapSecretSource !== 'none'" class="form-extra">{{ mapSkHint }}</div>
            </el-form-item>
            <el-form-item v-if="can.map">
              <el-button type="primary" :loading="savingMap" @click="saveMap">保存</el-button>
            </el-form-item>
          </el-form>
        </SettingsSection>

        <BrandingCard
          v-if="settings"
          ref="brandingCard"
          :value="settings.branding"
          :can="can.branding"
          @dirty="brandingDirty = $event"
          @saved="onBrandingSaved"
        />

        <SettingsSection
          id="sec-labels"
          v-loading="loading"
          title="显示名称"
          :desc="`只改页面上显示的文字，数据库里的值、筛选和接口参数不变。留空恢复默认，每项最多 ${LABEL_MAX} 个字。保存后其他用户刷新页面生效。`"
        >
          <div class="label-groups">
            <section v-for="group in LABEL_GROUPS" :key="group.key" class="label-group">
              <h4>
                {{ group.title }}
                <em v-if="group.hint">{{ group.hint }}</em>
              </h4>
              <div class="label-items">
                <label v-for="item in group.items" :key="item.key" class="label-item">
                  <span>默认「{{ item.label }}」</span>
                  <el-input
                    v-model="labelForm[group.key as LabelGroup][item.key]"
                    :maxlength="LABEL_MAX"
                    :placeholder="item.label"
                    :disabled="!can.labels"
                    clearable
                  />
                </label>
              </div>
            </section>
          </div>
          <div v-if="can.labels" class="label-ops">
            <el-button type="primary" :loading="savingLabels" @click="saveLabels">保存</el-button>
            <el-button @click="resetLabels">全部恢复默认</el-button>
          </div>
        </SettingsSection>

        <SettingsSection
          v-if="settings?.security"
          id="sec-security"
          v-loading="loading"
          title="账号安全"
          desc="新建、重置密码和自己改密都按这里的规则检查。改了规则不影响已有密码，到期或被要求改密时才按新规则。"
        >
          <el-form label-width="140px">
            <div class="form-pair">
              <el-form-item label="密码最短长度">
                <el-input-number
                  v-model="secForm.minLength"
                  :min="6"
                  :max="64"
                  :disabled="!can.password"
                />
                <span class="unit">位</span>
              </el-form-item>
              <el-form-item label="定期更换">
                <el-input-number
                  v-model="secForm.expireDays"
                  :min="0"
                  :max="3650"
                  :disabled="!can.password"
                />
                <span class="unit">天，0 表示不要求</span>
              </el-form-item>
            </div>
            <el-form-item label="必须包含">
              <el-checkbox-group v-model="secForm.classes" :disabled="!can.password">
                <el-checkbox value="letter">字母</el-checkbox>
                <el-checkbox value="digit">数字</el-checkbox>
                <el-checkbox value="symbol">符号</el-checkbox>
              </el-checkbox-group>
            </el-form-item>
            <div class="form-pair">
              <el-form-item>
                <template #label>
                  <span class="label-help">
                    连续输错
                    <el-tooltip :content="HELP.lockout" placement="top">
                      <el-icon class="help-icon"><QuestionFilled /></el-icon>
                    </el-tooltip>
                  </span>
                </template>
                <el-input-number
                  v-model="secForm.lockThreshold"
                  :min="3"
                  :max="20"
                  :disabled="!can.lockout"
                />
                <span class="unit">次</span>
              </el-form-item>
              <el-form-item label="锁定时长">
                <el-input-number
                  v-model="secForm.lockMinutes"
                  :min="1"
                  :max="1440"
                  :disabled="!can.lockout"
                />
                <span class="unit">分钟</span>
              </el-form-item>
            </div>
            <el-form-item v-if="can.password || can.lockout">
              <el-button type="primary" :loading="savingSec" @click="saveSecurity">保存</el-button>
            </el-form-item>
          </el-form>
        </SettingsSection>

        <SettingsSection
          v-if="settings?.smtp || settings?.video"
          id="sec-integration"
          v-loading="loading"
          title="外部集成"
        >
          <h4 class="sub">邮件服务（SMTP）</h4>
          <p class="database-tip">
            以后用于找回密码、告警通知。密码只写入，不会回显，但有已配置标识。
          </p>
          <el-form label-width="140px">
            <el-form-item label="启用">
              <el-switch v-model="smtpForm.enabled" :disabled="!can.smtp" />
            </el-form-item>
            <el-form-item label="服务器">
              <el-input
                v-model="smtpForm.host"
                placeholder="smtp.example.com"
                :disabled="!can.smtp"
              />
            </el-form-item>
            <div class="form-pair">
              <el-form-item>
                <template #label>
                  <span class="label-help">
                    端口
                    <el-tooltip :content="HELP.smtpPort" placement="top">
                      <el-icon class="help-icon"><QuestionFilled /></el-icon>
                    </el-tooltip>
                  </span>
                </template>
                <el-input-number
                  v-model="smtpForm.port"
                  :min="1"
                  :max="65535"
                  :disabled="!can.smtp"
                />
              </el-form-item>
              <el-form-item>
                <template #label>
                  <span class="label-help">
                    加密
                    <el-tooltip :content="HELP.smtpSecure" placement="top">
                      <el-icon class="help-icon"><QuestionFilled /></el-icon>
                    </el-tooltip>
                  </span>
                </template>
                <el-select v-model="smtpForm.secure" :disabled="!can.smtp">
                  <el-option label="SSL" value="ssl" />
                  <el-option label="STARTTLS" value="starttls" />
                  <el-option label="不加密" value="none" />
                </el-select>
              </el-form-item>
            </div>
            <el-form-item label="账号">
              <el-input v-model="smtpForm.user" autocomplete="off" :disabled="!can.smtp" />
            </el-form-item>
            <el-form-item>
              <template #label>
                <span class="label-help">
                  密码
                  <el-tag :type="smtpHasPassword ? 'success' : 'info'" effect="plain" size="small">
                    {{ smtpHasPassword ? "已配置" : "未配置" }}
                  </el-tag>
                </span>
              </template>
              <el-input
                v-model="smtpForm.password"
                type="password"
                show-password
                autocomplete="new-password"
                :placeholder="smtpHasPassword ? SECRET_CONFIGURED_HINT : ''"
                :disabled="!can.smtp"
              />
              <div v-if="smtpHasPassword" class="form-extra">{{ SECRET_CONFIGURED_HINT }}</div>
            </el-form-item>
            <el-form-item label="发件人名称">
              <el-input v-model="smtpForm.fromName" :disabled="!can.smtp" />
            </el-form-item>
            <el-form-item label="发件地址">
              <el-input
                v-model="smtpForm.fromAddress"
                placeholder="noreply@example.com"
                :disabled="!can.smtp"
              />
            </el-form-item>
            <el-form-item v-if="can.smtp">
              <el-button type="primary" :loading="savingSmtp" @click="saveSmtp">保存</el-button>
              <el-button :loading="testingSmtp" @click="testSmtp()">测试连接</el-button>
              <el-input
                v-model="testTo"
                placeholder="测试收件地址"
                style="width: 200px; margin-left: 8px"
              />
              <el-button :loading="testingSmtp" :disabled="!testTo" @click="testSmtp(testTo)">
                发测试邮件
              </el-button>
            </el-form-item>
          </el-form>

          <h4 class="sub">视频平台（开箱录像）</h4>
          <p class="database-tip">
            采样任务要求录像时，分公司采样现场每次在计划地点开箱，服务器向这个地址发一条 JSON（事件
            box.opened，带任务、箱子、开箱时间和位置）。检测站不设录像。平台确定前可以先不启用，录像记录会显示「平台未接入」。
          </p>
          <el-form label-width="140px">
            <el-form-item label="启用">
              <el-switch v-model="videoForm.enabled" :disabled="!can.video" />
            </el-form-item>
            <el-form-item label="接口地址">
              <el-input
                v-model="videoForm.url"
                placeholder="https://video.example.com/api/record"
                :disabled="!can.video"
              />
            </el-form-item>
            <el-form-item>
              <template #label>
                <span class="label-help">
                  访问令牌
                  <el-tooltip :content="HELP.videoToken" placement="top">
                    <el-icon class="help-icon"><QuestionFilled /></el-icon>
                  </el-tooltip>
                  <el-tag :type="videoHasToken ? 'success' : 'info'" effect="plain" size="small">
                    {{ videoHasToken ? "已配置" : "未配置" }}
                  </el-tag>
                </span>
              </template>
              <el-input
                v-model="videoForm.token"
                type="password"
                show-password
                autocomplete="new-password"
                :placeholder="videoHasToken ? SECRET_CONFIGURED_HINT : '选填，作为 Bearer 令牌'"
                :disabled="!can.video"
              />
              <div v-if="videoHasToken" class="form-extra">{{ SECRET_CONFIGURED_HINT }}</div>
            </el-form-item>
            <el-form-item>
              <template #label>
                <span class="label-help">
                  超时
                  <el-tooltip :content="HELP.videoTimeout" placement="top">
                    <el-icon class="help-icon"><QuestionFilled /></el-icon>
                  </el-tooltip>
                </span>
              </template>
              <el-input-number
                v-model="videoForm.timeoutMs"
                :min="1000"
                :max="60000"
                :step="1000"
                :disabled="!can.video"
              />
              <span class="unit">毫秒</span>
            </el-form-item>
            <el-form-item v-if="can.video">
              <el-button type="primary" :loading="savingVideo" @click="saveVideo">保存</el-button>
              <el-button :loading="testingVideo" @click="testVideo">发测试请求</el-button>
            </el-form-item>
          </el-form>

          <template v-if="settings?.wechat">
            <h4 class="sub">微信小程序（扫箱码登录）</h4>
            <p class="database-tip">
              小程序登录时用 AppID 和 AppSecret 向微信换取用户身份，在微信公众平台「开发管理 ›
              开发设置」里查看。AppSecret 只写入，不回显，但有已配置标识。
            </p>
            <el-form label-width="140px">
              <el-form-item label="AppID">
                <el-input
                  v-model="wechatForm.appId"
                  placeholder="wx 开头的 18 位"
                  :disabled="!can.wechat"
                />
              </el-form-item>
              <el-form-item>
                <template #label>
                  <span class="label-help">
                    AppSecret
                    <el-tag
                      :type="wechatHasAppSecret ? 'success' : 'info'"
                      effect="plain"
                      size="small"
                    >
                      {{ wechatHasAppSecret ? "已配置" : "未配置" }}
                    </el-tag>
                  </span>
                </template>
                <el-input
                  v-model="wechatForm.appSecret"
                  type="password"
                  show-password
                  autocomplete="new-password"
                  :placeholder="wechatHasAppSecret ? SECRET_CONFIGURED_HINT : '还没设置'"
                  :disabled="!can.wechat"
                />
                <div v-if="wechatHasAppSecret" class="form-extra">
                  {{ SECRET_CONFIGURED_HINT }}
                </div>
              </el-form-item>
              <el-form-item v-if="can.wechat">
                <el-button type="primary" :loading="savingWechat" @click="saveWechat">
                  保存
                </el-button>
              </el-form-item>
            </el-form>
          </template>

          <h4 class="sub">规划中</h4>
          <div class="planned">
            <el-tag type="info">短信通知</el-tag>
            <el-tag type="info">Webhook 推送</el-tag>
            <span class="text-muted">接口已预留，确定服务商后开放配置。</span>
          </div>
        </SettingsSection>

        <SettingsSection
          v-if="settings?.database"
          id="sec-db"
          v-loading="loading"
          title="数据库"
          desc="主机留空时继续使用 SQLite。密码只写入，不会回显，但有已配置标识。"
        >
          <el-form label-width="140px">
            <el-form-item label="主机">
              <el-input
                v-model="form.host"
                :disabled="!can.db"
                placeholder="留空则使用 SQLite"
                clearable
              />
            </el-form-item>
            <el-form-item label="端口">
              <el-input v-model="form.port" :disabled="!can.db" />
            </el-form-item>
            <el-form-item label="库名">
              <el-input v-model="form.database" :disabled="!can.db" />
            </el-form-item>
            <el-form-item label="账号">
              <el-input v-model="form.user" :disabled="!can.db" />
            </el-form-item>
            <el-form-item>
              <template #label>
                <span class="label-help">
                  密码
                  <el-tag :type="passwordSet ? 'success' : 'info'" effect="plain" size="small">
                    {{ passwordSet ? "已配置" : "未配置" }}
                  </el-tag>
                </span>
              </template>
              <el-input
                v-model="form.password"
                type="password"
                show-password
                autocomplete="new-password"
                :disabled="!can.db"
                :placeholder="passwordSet ? SECRET_CONFIGURED_HINT : '请输入密码'"
              />
              <div v-if="passwordSet" class="form-extra">{{ SECRET_CONFIGURED_HINT }}</div>
            </el-form-item>
            <el-form-item v-if="can.db">
              <el-button type="primary" :loading="saving" @click="save">保存</el-button>
            </el-form-item>
          </el-form>
        </SettingsSection>
      </div>
      <div v-if="dirtyCount" class="save-bar">
        <span class="save-bar-text">{{ dirtyCount }} 个分区未保存</span>
        <el-button size="small" @click="discardDirty">放弃更改</el-button>
        <el-button size="small" type="primary" @click="saveAllDirty">保存全部</el-button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onBeforeRouteLeave } from "vue-router";
import { QuestionFilled } from "@element-plus/icons-vue";
import SettingsAPI, {
  type SecuritySettings,
  type SmtpSettings,
  type TcpSettings,
  type VideoSettings,
  type WechatSettings,
} from "@/api/system/settings";
import BrandingCard from "./BrandingCard.vue";
import SettingsSection from "./SettingsSection.vue";
import {
  dirtyIntegrationParts,
  integrationKey,
  sectionIsDirty,
  snapshotKeys,
  syncSectionSpy,
} from "./sections";
import PageHeader from "@/components/biz/PageHeader.vue";
import InfoList, { type InfoItem } from "@/components/biz/InfoList.vue";
import {
  defaultLabelSet,
  LABEL_GROUPS,
  LABEL_MAX,
  setLabels,
  type LabelGroup,
  type Labels,
} from "@/utils/labels";

/** inline 帮助文案：全部取自现有 hint/选项 label/服务端校验口径，不新造口径。 */
const HELP = {
  lockout: "连续输错几次锁定、锁定多少分钟",
  smtpPort: "1–65535，默认 465",
  smtpSecure: "SSL / STARTTLS / 不加密",
  videoToken: "选填，作为 Bearer 令牌；已设置时留空不改",
  videoTimeout: "超时要在 1000–60000 毫秒之间",
} as const;

/** 密钥类字段统一口径：已配置时 placeholder 与 extra 灰字同文；未配置时各字段用原 placeholder。 */
const SECRET_CONFIGURED_HINT = "已配置：留空保存保持不变；填写则覆盖";

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
/** 各分区能不能改，服务端按权限给。采样箱默认策略已迁出本页（采样箱 › 默认策略）。 */
const can = computed(() => ({
  map: false,
  labels: false,
  branding: false,
  db: false,
  password: false,
  lockout: false,
  smtp: false,
  video: false,
  wechat: false,
  ...(settings.value?.can || {}),
}));
const sections = computed(() =>
  [
    { id: "sec-access", title: "接入信息", show: true },
    { id: "sec-map", title: "地图", show: true },
    { id: "sec-branding", title: "名称与图标", show: Boolean(settings.value) },
    { id: "sec-labels", title: "显示名称", show: true },
    { id: "sec-security", title: "账号安全", show: Boolean(settings.value?.security) },
    {
      id: "sec-integration",
      title: "外部集成",
      show: Boolean(settings.value?.smtp || settings.value?.video),
    },
    { id: "sec-db", title: "数据库", show: Boolean(settings.value?.database) },
  ].filter((item) => item.show)
);
const activeSection = ref("sec-access");
function jump(id: string) {
  activeSection.value = id;
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}
// #settings-refactor：分区脏状态 + sticky 保存条 + 离开守卫 + scrollspy
const savedSnap = ref<Record<string, string>>({});
const brandingDirty = ref(false);
const brandingCard = ref<InstanceType<typeof BrandingCard> | null>(null);
function onBrandingSaved(v: unknown) {
  if (settings.value) settings.value.branding = v as typeof settings.value.branding;
}
function snapOf(id: string): string {
  switch (id) {
    case "sec-map":
      return JSON.stringify(mapForm);
    case "sec-labels":
      return JSON.stringify(labelForm);
    case "sec-security":
      return JSON.stringify(secForm);
    // #26 m-04：集成区按子表单隔离快照（smtp/video/wechat 各一把），存一个不吞掉其余的未保存改动
    case "sec-integration:smtp":
      return JSON.stringify(smtpForm);
    case "sec-integration:video":
      return JSON.stringify(videoForm);
    case "sec-integration:wechat":
      return JSON.stringify(wechatForm);
    case "sec-db":
      return JSON.stringify(form);
    default:
      return "";
  }
}
function snapshotAll() {
  for (const key of snapshotKeys(sections.value.map((sec) => sec.id)))
    savedSnap.value[key] = snapOf(key);
}
function markSaved(id: string) {
  savedSnap.value[id] = snapOf(id);
}
const dirtySections = computed(() =>
  sections.value.filter((sec) =>
    sectionIsDirty(sec.id, snapOf, savedSnap.value, brandingDirty.value)
  )
);
const dirtyCount = computed(() => dirtySections.value.length);
async function saveAllDirty() {
  for (const sec of dirtySections.value) {
    if (sec.id === "sec-map") await saveMap();
    else if (sec.id === "sec-labels") await saveLabels();
    else if (sec.id === "sec-security") await saveSecurity();
    else if (sec.id === "sec-integration") {
      // #26 m-04：只保存脏的子表单（快照隔离后各自独立判脏），没改的不重复提交
      for (const part of dirtyIntegrationParts(snapOf, savedSnap.value)) {
        if (part === "smtp") await saveSmtp();
        else if (part === "video") await saveVideo();
        else await saveWechat();
      }
    } else if (sec.id === "sec-branding") await brandingCard.value?.save();
    else if (sec.id === "sec-db") await save();
  }
}
function discardDirty() {
  load();
}
let spy: IntersectionObserver | null = null;
const observedSections = new Map<string, Element>();
function syncSpy() {
  if (spy)
    syncSectionSpy(
      spy,
      observedSections,
      sections.value.map((sec) => sec.id),
      (id) => document.getElementById(id)
    );
}
function warnUnsaved(e: BeforeUnloadEvent) {
  if (dirtyCount.value) {
    e.preventDefault();
    e.returnValue = "";
  }
}
onMounted(() => {
  spy = new IntersectionObserver(
    (es) => {
      for (const e of es) if (e.isIntersecting) activeSection.value = e.target.id;
    },
    { rootMargin: "-20% 0px -70% 0px" }
  );
  syncSpy();
  window.addEventListener("beforeunload", warnUnsaved);
});
// #26 m-04：branding/security/integration/db 四区依赖 settings 异步加载后才渲染，
// onMounted 时 getElementById 取不到、永不被 observe。分区列表变化后补挂（flush post 保证 DOM 已更新）。
watch(sections, syncSpy, { flush: "post" });
onBeforeUnmount(() => {
  spy?.disconnect();
  observedSections.clear();
  window.removeEventListener("beforeunload", warnUnsaved);
});
onBeforeRouteLeave(() => {
  if (!dirtyCount.value) return true;
  return ElMessageBox.confirm(
    "有 " + dirtyCount.value + " 个分区未保存，离开将丢失修改。",
    "未保存的修改",
    { confirmButtonText: "放弃修改离开", cancelButtonText: "留下保存", type: "warning" }
  )
    .then(() => true)
    .catch(() => false);
});
const secForm = reactive<SecuritySettings>({
  minLength: 8,
  classes: ["letter", "digit"],
  expireDays: 0,
  lockThreshold: 5,
  lockMinutes: 15,
});
const smtpForm = reactive<SmtpSettings>({
  enabled: false,
  host: "",
  port: 465,
  secure: "ssl",
  user: "",
  password: "",
  passwordSet: false,
  fromName: "",
  fromAddress: "",
});
const videoForm = reactive<VideoSettings>({
  enabled: false,
  url: "",
  token: "",
  tokenSet: false,
  timeoutMs: 8000,
});
const savingSec = ref(false),
  savingSmtp = ref(false),
  testingSmtp = ref(false),
  savingVideo = ref(false),
  testingVideo = ref(false);
const testTo = ref("");
async function saveSecurity() {
  savingSec.value = true;
  try {
    await SettingsAPI.saveSecurity({ ...secForm });
    ElMessage.success("已保存");
    markSaved("sec-security");
  } finally {
    savingSec.value = false;
  }
}
async function saveSmtp() {
  savingSmtp.value = true;
  try {
    Object.assign(smtpForm, await SettingsAPI.saveSmtp({ ...smtpForm }), { password: "" });
    ElMessage.success("已保存");
    markSaved(integrationKey("smtp"));
  } finally {
    savingSmtp.value = false;
  }
}
async function testSmtp(to = "") {
  testingSmtp.value = true;
  try {
    const result = await SettingsAPI.testSmtp({ ...smtpForm, to: to || undefined });
    ElMessage.success(result.sent ? "测试邮件已发出，请查收" : "连接和登录成功");
  } finally {
    testingSmtp.value = false;
  }
}
const wechatForm = reactive<WechatSettings>({ appId: "", appSecret: "", appSecretSet: false });
const savingWechat = ref(false);
async function saveWechat() {
  savingWechat.value = true;
  try {
    Object.assign(wechatForm, await SettingsAPI.saveWechat({ ...wechatForm }), { appSecret: "" });
    ElMessage.success("已保存");
    // #26 m-04：wechat 子表单同样纳入脏快照（原先整区快照不含它，改了也不计脏）
    markSaved(integrationKey("wechat"));
  } finally {
    savingWechat.value = false;
  }
}
async function saveVideo() {
  savingVideo.value = true;
  try {
    Object.assign(videoForm, await SettingsAPI.saveVideo({ ...videoForm }), { token: "" });
    ElMessage.success("已保存");
    markSaved(integrationKey("video"));
  } finally {
    savingVideo.value = false;
  }
}
async function testVideo() {
  testingVideo.value = true;
  try {
    const result = await SettingsAPI.testVideo({ ...videoForm });
    ElMessage.success(`平台返回：${result.status}`);
  } finally {
    testingVideo.value = false;
  }
}
const portText = computed(() => (settings.value?.port == null ? "" : String(settings.value.port)));
const listeningText = computed(() => {
  if (!settings.value) return "";
  return settings.value.listening ? "正在监听" : "未在监听";
});
const mapForm = reactive({ tk: "", sk: "" });
const savingMap = ref(false);
const savingLabels = ref(false);
const labelForm = reactive<Labels>(defaultLabelSet());
/**
 * 密钥字段「已配置」标识：优先用服务端 has* 布尔（不泄露秘密本体，无改密权限也能看），
 * 老响应没有 has* 键时回落既有 *Set / 值本身。标识不进表单模型，脏快照口径不变（空输入不算脏）。
 */
const mapHasKey = computed(() => Boolean(settings.value?.map?.hasKey ?? settings.value?.map?.tk));
const mapHasSecret = computed(() =>
  Boolean(settings.value?.map?.hasSecret ?? settings.value?.map?.sk)
);
/**
 * 天地图密钥生效来源：服务器配置优先，未配置时回落构建内置（.env 的 VITE_TIANDITU_*，
 * 与 TiandituMap 的 fallback 同口径）。标识要反映「生效密钥」而不是仅服务器存储，
 * 否则内置密钥生效时界面误报未配置。内置键本就在浏览器 bundle 里，标注来源不泄密。
 */
const builtinTk = String(import.meta.env.VITE_TIANDITU_TK ?? "");
const builtinSk = String(import.meta.env.VITE_TIANDITU_SK ?? "");
const mapKeySource = computed(() => (mapHasKey.value ? "server" : builtinTk ? "builtin" : "none"));
const mapSecretSource = computed(() =>
  mapHasSecret.value ? "server" : builtinSk ? "builtin" : "none"
);
const MAP_SOURCE_TAG = { server: "已配置", builtin: "内置生效", none: "未配置" } as const;
const MAP_BUILTIN_HINT = "当前使用构建内置密钥；填写并保存后改用服务器值";
const mapTkHint = computed(() =>
  mapKeySource.value === "server"
    ? SECRET_CONFIGURED_HINT
    : mapKeySource.value === "builtin"
      ? MAP_BUILTIN_HINT
      : "天地图 tk"
);
const mapSkHint = computed(() =>
  mapSecretSource.value === "server"
    ? SECRET_CONFIGURED_HINT
    : mapSecretSource.value === "builtin"
      ? MAP_BUILTIN_HINT
      : "选填"
);
const smtpHasPassword = computed(() => Boolean(smtpForm.hasPassword ?? smtpForm.passwordSet));
const videoHasToken = computed(() => Boolean(videoForm.hasToken ?? videoForm.tokenSet));
const wechatHasAppSecret = computed(() =>
  Boolean(wechatForm.hasAppSecret ?? wechatForm.appSecretSet)
);

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
    passwordSet.value = Boolean(database?.hasDbPassword ?? database?.passwordSet);
    mapForm.tk = settings.value.map?.tk || "";
    mapForm.sk = "";
    if (settings.value.security) Object.assign(secForm, settings.value.security);
    if (settings.value.smtp) Object.assign(smtpForm, settings.value.smtp, { password: "" });
    if (settings.value.video) Object.assign(videoForm, settings.value.video, { token: "" });
    if (settings.value.wechat) Object.assign(wechatForm, settings.value.wechat, { appSecret: "" });
    if (settings.value.labels) {
      setLabels(settings.value.labels);
      fillLabels(settings.value.labels as Labels);
    }
    snapshotAll();
  } finally {
    loading.value = false;
  }
}

async function save() {
  // #settings-refactor audit-5：数据库切换不可逆影响，二次确认
  try {
    await ElMessageBox.confirm(
      "切换数据库会改变全部业务数据的存放位置，保存后需重启服务生效；请确认已备份原库。继续？",
      "切换数据库",
      { confirmButtonText: "确认切换", cancelButtonText: "取消", type: "warning" }
    );
  } catch {
    return;
  }
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
    passwordSet.value = Boolean(saved.hasDbPassword ?? saved.passwordSet);
    await load();
    ElMessage.success("已保存");
    markSaved("sec-db");
  } finally {
    saving.value = false;
  }
}

async function saveMap() {
  savingMap.value = true;
  try {
    await SettingsAPI.saveMap({ tk: mapForm.tk.trim(), sk: mapForm.sk });
    mapForm.sk = "";
    await load();
    ElMessage.success("已保存");
    markSaved("sec-map");
  } finally {
    savingMap.value = false;
  }
}

function fillLabels(source: Labels) {
  for (const group of LABEL_GROUPS) {
    const key = group.key as LabelGroup;
    labelForm[key] = { ...source[key] };
  }
}

async function resetLabels() {
  // #settings-refactor audit-5：恢复默认覆盖当前编辑，二次确认
  try {
    await ElMessageBox.confirm("全部显示名称恢复默认，当前未保存的修改将丢失。继续？", "恢复默认", {
      confirmButtonText: "恢复默认",
      cancelButtonText: "取消",
      type: "warning",
    });
  } catch {
    return;
  }
  fillLabels(defaultLabelSet());
}

async function saveLabels() {
  savingLabels.value = true;
  try {
    const saved = await SettingsAPI.saveLabels(JSON.parse(JSON.stringify(labelForm)));
    setLabels(saved);
    fillLabels(saved as Labels);
    ElMessage.success("已保存");
    markSaved("sec-labels");
  } finally {
    savingLabels.value = false;
  }
}

onMounted(load);

/** 接入信息：给设备和 DTU 配置用的地址和端口，名称在左、值在右，地址和端口可以一键复制。 */
const accessItems = computed<InfoItem[]>(() => [
  { label: "接入方式", value: settings.value?.mode || "—" },
  { label: "服务器地址", value: settings.value?.address || "—", mono: true, copy: true },
  { label: "端口", value: portText.value || "—", mono: true, copy: true },
  { label: "说明", value: settings.value?.hint || "—" },
  { label: "管理端地址", value: settings.value?.adminUrl || "—", mono: true, copy: true },
  { label: "TCP 监听", value: listeningText.value || "—" },
  { label: "程序版本", value: settings.value?.version || "—", mono: true },
  { label: "证书到期日", value: settings.value?.certExpiresAt || "—" },
]);
</script>

<style lang="scss" scoped>
.settings-layout {
  display: flex;
  gap: var(--page-gap);
  align-items: flex-start;
}
.settings-nav {
  position: sticky;
  top: 0;
  display: flex;
  flex: 0 0 150px;
  flex-direction: column;
  gap: 2px;
  padding: 8px;
  background: var(--content-bg);
  border: 1px solid var(--card-border);
  border-radius: var(--card-radius);
}
.settings-nav a {
  padding: 6px 10px;
  font-size: 13px;
  color: var(--el-text-color-regular);
  cursor: pointer;
  border-radius: 6px;
}
.settings-nav a:hover,
.settings-nav a.on {
  color: var(--el-color-primary);
  background: var(--el-color-primary-light-9);
}
/* 超宽屏内容约束：分区内容区封顶 1280 居中，不再无限拉伸；导航保持 sticky */
.settings-main {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
  max-width: 1280px;
  margin-inline: auto;
}
/* 表单栅格统一：label 140 右对齐（el-form label-width），control 弹性封顶 480，行距 16，stepper 统一宽 */
.settings-main :deep(.el-form-item) {
  margin-bottom: 16px;
}
.settings-main :deep(.el-form > .el-form-item:last-child) {
  margin-bottom: 0;
}
.settings-main :deep(.el-form-item__content > .el-input),
.settings-main :deep(.el-form-item__content > .el-select) {
  width: 100%;
  max-width: 480px;
}
.settings-main :deep(.el-input-number) {
  width: 180px;
}
/* 短字段成对双列，窄屏回落单列 */
.form-pair {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  column-gap: 24px;
}
.label-help {
  display: inline-flex;
  gap: 4px;
  align-items: center;
}
/* 密钥「已配置/未配置」tag 收紧内边距：140px label 里「文字+帮助图标+tag」最长组合（访问令牌）不换行 */
.label-help .el-tag {
  padding-inline: 4px;
}
.help-icon {
  font-size: 14px;
  color: var(--el-text-color-secondary);
  cursor: help;
}
/* form-item 内容换行的一行灰字帮助 */
.form-extra {
  flex-basis: 100%;
  margin-top: 4px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--el-text-color-secondary);
}
.sub {
  margin: 20px 0 4px;
  font-size: 14px;
  font-weight: 600;
}
.sub:first-child {
  margin-top: 0;
}
.planned {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
@media (max-width: 900px) {
  .settings-layout {
    flex-direction: column;
    align-items: stretch;
  }
  /* 窄屏：导航变成一行横向滑动的标签，不占高度 */
  .settings-nav {
    position: static;
    flex: none;
    flex-direction: row;
    flex-wrap: nowrap;
    width: 100%;
    padding: 6px;
    overflow-x: auto;
  }
  .settings-nav a {
    flex-shrink: 0;
    white-space: nowrap;
  }
  .form-pair {
    grid-template-columns: minmax(0, 1fr);
  }
}
/* #settings-refactor：脏点 + sticky 保存条 */
.dirty-dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  margin-left: 6px;
  vertical-align: middle;
  background: var(--el-color-warning);
  border-radius: 50%;
}
.save-bar {
  position: fixed;
  bottom: 16px;
  left: 50%;
  z-index: 60;
  display: flex;
  gap: 12px;
  align-items: center;
  padding: 10px 16px;
  background: var(--el-bg-color-overlay, #fff);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 10px;
  box-shadow: 0 4px 16px rgb(0 0 0 / 12%);
  transform: translateX(-50%);
}
.save-bar-text {
  flex: 1;
  font-size: 13px;
  color: var(--el-color-warning);
}

.database-tip {
  margin: 0 0 16px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--el-text-color-secondary);
}

.label-groups {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 16px 24px;
}

.label-group h4 {
  margin: 0 0 8px;
  font-size: 14px;
  font-weight: 600;

  em {
    margin-left: 6px;
    font-size: 12px;
    font-style: normal;
    font-weight: normal;
    color: var(--el-text-color-secondary);
  }
}

.label-items {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px 12px;
}

.label-item {
  display: flex;
  flex-direction: column;
  gap: 4px;

  span {
    font-size: 12px;
    color: var(--el-text-color-secondary);
  }
}

.label-ops {
  margin-top: 16px;
}

@media (max-width: 600px) {
  .label-groups {
    grid-template-columns: minmax(0, 1fr);
  }
}

.unit {
  margin-left: 8px;
  color: var(--el-text-color-secondary);
}
</style>
