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
        </a>
      </nav>
      <div class="settings-main">
        <el-card id="sec-access" v-loading="loading" shadow="never" header="接入信息">
          <InfoList :items="accessItems" label-width="96px" />
        </el-card>

        <el-card
          id="sec-map"
          v-loading="loading"
          class="database-card"
          shadow="never"
          header="地图"
        >
          <p class="database-tip">
            天地图浏览器端密钥，所有看地图的页面都用它。安全密钥留空则不修改。
          </p>
          <el-form label-width="88px">
            <el-form-item label="应用密钥">
              <el-input
                v-model="mapForm.tk"
                :disabled="!can.map"
                placeholder="天地图 tk"
                clearable
              />
            </el-form-item>
            <el-form-item label="安全密钥">
              <el-input
                v-model="mapForm.sk"
                type="password"
                show-password
                autocomplete="new-password"
                :disabled="!can.map"
                :placeholder="mapSkHint"
              />
            </el-form-item>
            <el-form-item v-if="can.map">
              <el-button type="primary" :loading="savingMap" @click="saveMap">保存</el-button>
            </el-form-item>
          </el-form>
        </el-card>

        <el-card
          id="sec-box"
          v-loading="loading"
          class="database-card"
          shadow="never"
          header="采样箱默认策略与任务"
        >
          <p class="database-tip">
            只用于没有单箱、任务或批量设置的箱子；开关箱、上电、插拔充电器仍然马上上报。建议 60
            秒，并只在充电时定时上报。
          </p>
          <el-form label-width="140px">
            <el-form-item label="上报周期">
              <el-input-number
                v-model="boxForm.reportPeriodSec"
                :min="5"
                :max="3600"
                :step="5"
                :disabled="!can.box"
              />
              <span class="unit">秒</span>
            </el-form-item>
            <el-form-item label="定时上报">
              <el-switch v-model="boxForm.reportOnlyWhenCharging" :disabled="!can.box" />
              <span class="unit">只在充电时</span>
            </el-form-item>
            <el-form-item label="电量预留">
              <el-input-number
                v-model="boxForm.batteryReserve"
                :min="0"
                :max="80"
                :disabled="!can.batteryReserve"
              />
              <span class="unit">%，从总电量底部扣掉，不计入可用电量</span>
            </el-form-item>
            <el-form-item label="任务到达半径">
              <el-input-number
                v-model="boxForm.arriveRadiusM"
                :min="100"
                :max="50000"
                :step="500"
                :disabled="!can.arriveRadius"
              />
              <span class="unit">
                米，箱子离寄出、收货地址或计划地点在这个范围内算到达；基站定位误差常有一两公里
              </span>
            </el-form-item>
            <el-form-item v-if="canSetPolicy">
              <el-button type="primary" :loading="savingBox" @click="saveBox">保存</el-button>
            </el-form-item>
          </el-form>
        </el-card>

        <BrandingCard v-if="settings" :value="settings.branding" :can="can.branding" />

        <el-card
          id="sec-labels"
          v-loading="loading"
          class="database-card"
          shadow="never"
          header="显示名称"
        >
          <p class="database-tip">
            只改页面上显示的文字，数据库里的值、筛选和接口参数不变。留空恢复默认，每项最多
            {{ LABEL_MAX }} 个字。保存后其他用户刷新页面生效。
          </p>
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
        </el-card>

        <el-card
          v-if="settings?.security"
          id="sec-security"
          v-loading="loading"
          class="database-card"
          shadow="never"
          header="账号安全"
        >
          <p class="database-tip">
            新建、重置密码和自己改密都按这里的规则检查。改了规则不影响已有密码，到期或被要求改密时才按新规则。
          </p>
          <el-form label-width="140px">
            <el-form-item label="密码最短长度">
              <el-input-number
                v-model="secForm.minLength"
                :min="6"
                :max="64"
                :disabled="!can.password"
              />
              <span class="unit">位</span>
            </el-form-item>
            <el-form-item label="必须包含">
              <el-checkbox-group v-model="secForm.classes" :disabled="!can.password">
                <el-checkbox value="letter">字母</el-checkbox>
                <el-checkbox value="digit">数字</el-checkbox>
                <el-checkbox value="symbol">符号</el-checkbox>
              </el-checkbox-group>
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
            <el-form-item label="登录失败锁定">
              连续输错
              <el-input-number
                v-model="secForm.lockThreshold"
                :min="3"
                :max="20"
                size="small"
                :disabled="!can.lockout"
              />
              次，锁定
              <el-input-number
                v-model="secForm.lockMinutes"
                :min="1"
                :max="1440"
                size="small"
                :disabled="!can.lockout"
              />
              分钟
            </el-form-item>
            <el-form-item v-if="can.password || can.lockout">
              <el-button type="primary" :loading="savingSec" @click="saveSecurity">保存</el-button>
            </el-form-item>
          </el-form>
        </el-card>

        <el-card
          v-if="settings?.smtp || settings?.video"
          id="sec-integration"
          v-loading="loading"
          class="database-card"
          shadow="never"
          header="外部集成"
        >
          <h4 class="sub">邮件服务（SMTP）</h4>
          <p class="database-tip">以后用于找回密码、告警通知。密码只写入，不会回显。</p>
          <el-form label-width="110px">
            <el-form-item label="启用">
              <el-switch v-model="smtpForm.enabled" :disabled="!can.smtp" />
            </el-form-item>
            <el-row :gutter="12">
              <el-col :md="12" :span="24">
                <el-form-item label="服务器">
                  <el-input
                    v-model="smtpForm.host"
                    placeholder="smtp.example.com"
                    :disabled="!can.smtp"
                  />
                </el-form-item>
              </el-col>
              <el-col :md="6" :span="12">
                <el-form-item label="端口">
                  <el-input-number
                    v-model="smtpForm.port"
                    :min="1"
                    :max="65535"
                    :disabled="!can.smtp"
                    style="width: 100%"
                  />
                </el-form-item>
              </el-col>
              <el-col :md="6" :span="12">
                <el-form-item label="加密">
                  <el-select v-model="smtpForm.secure" :disabled="!can.smtp">
                    <el-option label="SSL" value="ssl" />
                    <el-option label="STARTTLS" value="starttls" />
                    <el-option label="不加密" value="none" />
                  </el-select>
                </el-form-item>
              </el-col>
              <el-col :md="12" :span="24">
                <el-form-item label="账号">
                  <el-input v-model="smtpForm.user" autocomplete="off" :disabled="!can.smtp" />
                </el-form-item>
              </el-col>
              <el-col :md="12" :span="24">
                <el-form-item label="密码">
                  <el-input
                    v-model="smtpForm.password"
                    type="password"
                    show-password
                    autocomplete="new-password"
                    :placeholder="smtpForm.passwordSet ? '已设置，留空不改' : ''"
                    :disabled="!can.smtp"
                  />
                </el-form-item>
              </el-col>
              <el-col :md="12" :span="24">
                <el-form-item label="发件人名称">
                  <el-input v-model="smtpForm.fromName" :disabled="!can.smtp" />
                </el-form-item>
              </el-col>
              <el-col :md="12" :span="24">
                <el-form-item label="发件地址">
                  <el-input
                    v-model="smtpForm.fromAddress"
                    placeholder="noreply@example.com"
                    :disabled="!can.smtp"
                  />
                </el-form-item>
              </el-col>
            </el-row>
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
            采样任务要求录像时，采样机构每次在计划地点开箱，服务器向这个地址发一条 JSON（事件
            box.opened，带任务、箱子、开箱时间和位置）。平台确定前可以先不启用，录像记录会显示「平台未接入」。
          </p>
          <el-form label-width="110px">
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
            <el-form-item label="访问令牌">
              <el-input
                v-model="videoForm.token"
                type="password"
                show-password
                autocomplete="new-password"
                :placeholder="videoForm.tokenSet ? '已设置，留空不改' : '选填，作为 Bearer 令牌'"
                :disabled="!can.video"
              />
            </el-form-item>
            <el-form-item label="超时">
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
              开发设置」里查看。AppSecret 只写入，不回显。
            </p>
            <el-form label-width="110px">
              <el-form-item label="AppID">
                <el-input
                  v-model="wechatForm.appId"
                  placeholder="wx 开头的 18 位"
                  :disabled="!can.wechat"
                />
              </el-form-item>
              <el-form-item label="AppSecret">
                <el-input
                  v-model="wechatForm.appSecret"
                  type="password"
                  show-password
                  autocomplete="new-password"
                  :placeholder="wechatForm.appSecretSet ? '已设置，留空不改' : '还没设置'"
                  :disabled="!can.wechat"
                />
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
        </el-card>

        <el-card
          v-if="settings?.database"
          id="sec-db"
          v-loading="loading"
          class="database-card"
          shadow="never"
          header="数据库"
        >
          <p class="database-tip">主机留空时继续使用 SQLite。密码只写入，不会回显。</p>
          <el-form label-width="88px">
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
            <el-form-item label="密码">
              <el-input
                v-model="form.password"
                type="password"
                show-password
                autocomplete="new-password"
                :disabled="!can.db"
                :placeholder="passwordHint"
              />
            </el-form-item>
            <el-form-item v-if="can.db">
              <el-button type="primary" :loading="saving" @click="save">保存</el-button>
            </el-form-item>
          </el-form>
        </el-card>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import SettingsAPI, {
  type SecuritySettings,
  type SmtpSettings,
  type TcpSettings,
  type VideoSettings,
  type WechatSettings,
} from "@/api/system/settings";
import BrandingCard from "./BrandingCard.vue";
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
// 默认上报策略、电量预留、到达半径各自授权，有任意一项就能保存（服务端按改了哪样再查）
const canSetPolicy = computed(() =>
  Boolean(can.value.box || can.value.batteryReserve || can.value.arriveRadius)
);
/** 各分区能不能改，服务端按权限给。 */
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
  box: false,
  batteryReserve: false,
  arriveRadius: false,
  ...(settings.value?.can || {}),
}));
const sections = computed(() =>
  [
    { id: "sec-access", title: "接入信息", show: true },
    { id: "sec-map", title: "地图", show: true },
    { id: "sec-box", title: "默认策略与任务", show: true },
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
  } finally {
    savingSec.value = false;
  }
}
async function saveSmtp() {
  savingSmtp.value = true;
  try {
    Object.assign(smtpForm, await SettingsAPI.saveSmtp({ ...smtpForm }), { password: "" });
    ElMessage.success("已保存");
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
  } finally {
    savingWechat.value = false;
  }
}
async function saveVideo() {
  savingVideo.value = true;
  try {
    Object.assign(videoForm, await SettingsAPI.saveVideo({ ...videoForm }), { token: "" });
    ElMessage.success("已保存");
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
const mapSkSet = ref(false);
const savingMap = ref(false);
const savingBox = ref(false);
const boxForm = reactive({
  reportPeriodSec: 60,
  reportOnlyWhenCharging: false,
  batteryReserve: 20,
  arriveRadiusM: 2000,
});
const savingLabels = ref(false);
const labelForm = reactive<Labels>(defaultLabelSet());
const passwordHint = computed(() => (passwordSet.value ? "已设置，留空则不修改" : "请输入密码"));
const mapSkHint = computed(() => (mapSkSet.value ? "已设置，留空则不修改" : "选填"));

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
    mapForm.tk = settings.value.map?.tk || "";
    mapForm.sk = "";
    mapSkSet.value = Boolean(settings.value.map?.sk);
    boxForm.reportPeriodSec = settings.value.box?.reportPeriodSec || 60;
    if (settings.value.security) Object.assign(secForm, settings.value.security);
    if (settings.value.smtp) Object.assign(smtpForm, settings.value.smtp, { password: "" });
    if (settings.value.video) Object.assign(videoForm, settings.value.video, { token: "" });
    if (settings.value.wechat) Object.assign(wechatForm, settings.value.wechat, { appSecret: "" });
    boxForm.reportOnlyWhenCharging = Boolean(settings.value.box?.reportOnlyWhenCharging);
    boxForm.batteryReserve = settings.value.box?.batteryReserve ?? 20;
    boxForm.arriveRadiusM = settings.value.box?.arriveRadiusM ?? 2000;
    if (settings.value.labels) {
      setLabels(settings.value.labels);
      fillLabels(settings.value.labels as Labels);
    }
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

async function saveBox() {
  savingBox.value = true;
  try {
    await SettingsAPI.saveBox({
      reportPeriodSec: boxForm.reportPeriodSec,
      reportOnlyWhenCharging: boxForm.reportOnlyWhenCharging,
      batteryReserve: boxForm.batteryReserve,
      arriveRadiusM: boxForm.arriveRadiusM,
    });
    await load();
    ElMessage.success("已保存");
  } finally {
    savingBox.value = false;
  }
}

async function saveMap() {
  savingMap.value = true;
  try {
    await SettingsAPI.saveMap({ tk: mapForm.tk.trim(), sk: mapForm.sk });
    mapForm.sk = "";
    await load();
    ElMessage.success("已保存");
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

function resetLabels() {
  fillLabels(defaultLabelSet());
}

async function saveLabels() {
  savingLabels.value = true;
  try {
    const saved = await SettingsAPI.saveLabels(JSON.parse(JSON.stringify(labelForm)));
    setLabels(saved);
    fillLabels(saved as Labels);
    ElMessage.success("已保存");
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
.settings-main {
  flex: 1;
  min-width: 0;
}
.settings-main > .el-card {
  scroll-margin-top: 12px;
}
.sub {
  margin: 8px 0 4px;
  font-size: 14px;
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
}
.database-card {
  margin-top: 16px;
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
