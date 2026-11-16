<template>
  <div v-loading="loading" class="settings">
    <aside class="nav">
      <p class="nav__kicker">系统设置</p>
      <button
        v-for="item in sections"
        :key="item.id"
        type="button"
        class="nav__item"
        :class="{ 'is-on': section === item.id }"
        @click="choose(item.id)"
      >
        <span>{{ item.label }}</span>
        <small>{{ item.hint }}</small>
      </button>
    </aside>

    <section class="panel">
      <header class="panel__head">
        <h1>{{ current.title }}</h1>
        <p>{{ current.lead }}</p>
      </header>

      <div class="panel__body">
        <template v-if="section === 'access'">
          <div class="status" :class="{ 'is-on': settings?.listening }">
            <i />
            <div>
              <b>{{ settings?.listening ? "正在监听" : "未在监听" }}</b>
              <span>设备按 TCP 透传把报文送到下面这个地址，不要加路径。</span>
            </div>
          </div>
          <dl class="facts">
            <div>
              <dt>接入方式</dt>
              <dd>{{ settings?.mode || "—" }}</dd>
            </div>
            <div>
              <dt>服务器地址</dt>
              <dd>{{ settings?.address || "—" }}</dd>
            </div>
            <div>
              <dt>端口</dt>
              <dd>{{ portText || "—" }}</dd>
            </div>
            <div>
              <dt>管理端</dt>
              <dd>{{ settings?.adminUrl || "—" }}</dd>
            </div>
            <div>
              <dt>程序版本</dt>
              <dd>{{ settings?.version || "—" }}</dd>
            </div>
            <div>
              <dt>证书到期</dt>
              <dd>{{ settings?.certExpiresAt || "—" }}</dd>
            </div>
          </dl>
        </template>

        <template v-else-if="section === 'map'">
          <div class="field">
            <div class="field__label">应用密钥</div>
            <div class="field__control">
              <el-input
                v-model="draft.map.tk"
                :disabled="!isAdmin"
                maxlength="64"
                show-word-limit
                placeholder="天地图 tk"
                clearable
              />
              <p class="field__help">
                浏览器加载地图时使用。到天地图控制台开通 JavaScript API，并把本站地址加入允许列表。
              </p>
            </div>
          </div>
          <div class="field">
            <div class="field__label">安全密钥</div>
            <div class="field__control">
              <el-input
                v-model="skDraft"
                :disabled="!isAdmin || clearSk"
                type="password"
                show-password
                maxlength="128"
                :placeholder="skPlaceholder"
                autocomplete="new-password"
              />
              <p class="field__help">
                留空则不修改。瓦片请求会带上它，所以登录后的页面能读到已保存的值，输入框不再回显。
                <button
                  v-if="isAdmin && draft.map.skSet && !clearSk"
                  type="button"
                  class="text-btn"
                  @click="clearSk = true"
                >
                  清除已保存的密钥
                </button>
                <button v-else-if="clearSk" type="button" class="text-btn" @click="clearSk = false">
                  取消清除
                </button>
              </p>
            </div>
          </div>
        </template>

        <template v-else-if="section === 'policy'">
          <h2>上报</h2>
          <div class="field">
            <div class="field__label">上报间隔</div>
            <div class="field__control">
              <div class="inline">
                <el-input-number
                  v-model="draft.policy.reportIntervalSec"
                  :disabled="!isAdmin"
                  :min="60"
                  :max="86400"
                  :step="30"
                  controls-position="right"
                />
                <span class="unit">秒</span>
              </div>
              <p class="field__help">没有单独任务策略的箱子按这个间隔上报。建议不少于 60 秒。</p>
            </div>
          </div>
          <div class="field">
            <div class="field__label">定时上报</div>
            <div class="field__control">
              <div class="switch-line">
                <el-switch v-model="draft.policy.scheduledReport" :disabled="!isAdmin" />
                <span>{{ draft.policy.scheduledReport ? "只在有任务时上报" : "关闭" }}</span>
              </div>
              <p class="field__help">打开后，空闲箱子不按这个间隔上报。</p>
            </div>
          </div>
          <h2>任务</h2>
          <div class="field">
            <div class="field__label">电量阈值</div>
            <div class="field__control">
              <div class="inline">
                <el-input-number
                  v-model="draft.policy.batteryPercent"
                  :disabled="!isAdmin"
                  :min="5"
                  :max="50"
                  controls-position="right"
                />
                <span class="unit">%</span>
              </div>
              <p class="field__help">低于这个电量不再派新任务，已在途的箱子不受影响。</p>
            </div>
          </div>
          <div class="field">
            <div class="field__label">到达半径</div>
            <div class="field__control">
              <div class="inline">
                <el-input-number
                  v-model="draft.policy.arrivalRadiusM"
                  :disabled="!isAdmin"
                  :min="50"
                  :max="50000"
                  :step="100"
                  controls-position="right"
                />
                <span class="unit">米</span>
              </div>
              <p class="field__help">箱子离计划地点和收样地点都在这个距离内，算到达。</p>
            </div>
          </div>
        </template>

        <template v-else-if="section === 'brand'">
          <div class="brand">
            <label class="logo" :class="{ 'is-disabled': !isAdmin }">
              <img :src="logoPreview" alt="" />
              <input
                :disabled="!isAdmin"
                type="file"
                accept="image/png,image/jpeg,image/webp"
                @change="onLogo"
              />
            </label>
            <div>
              <b>{{ draft.brand.logoDataUrl ? "已选择新图标" : "默认图标" }}</b>
              <p>PNG、JPG 或 WebP，80KB 以内。侧栏和登录页用这一张。</p>
              <button
                v-if="isAdmin && draft.brand.logoDataUrl"
                type="button"
                class="text-btn"
                @click="draft.brand.logoDataUrl = ''"
              >
                恢复默认图标
              </button>
            </div>
          </div>
          <div class="field">
            <div class="field__label">系统名称</div>
            <div class="field__control">
              <el-input
                v-model="draft.brand.name"
                :disabled="!isAdmin"
                maxlength="20"
                show-word-limit
              />
              <p class="field__help">登录页和侧栏上的名称。</p>
            </div>
          </div>
          <div class="field">
            <div class="field__label">标题</div>
            <div class="field__control">
              <el-input
                v-model="draft.brand.title"
                :disabled="!isAdmin"
                maxlength="40"
                show-word-limit
              />
              <p class="field__help">浏览器标签上的文字。留空时用系统名称。</p>
            </div>
          </div>
        </template>

        <template v-else-if="section === 'labels'">
          <div class="label-grid">
            <section v-for="group in labelGroups" :key="group.title">
              <h2>{{ group.title }}</h2>
              <div v-for="item in group.fields" :key="item.key" class="label-row">
                <span>{{ item.fallback }}</span>
                <el-input v-model="draft.labels[item.key]" :disabled="!isAdmin" maxlength="16" />
              </div>
            </section>
          </div>
          <div class="preview">
            <span v-for="item in previewLabels" :key="item">{{ item }}</span>
          </div>
        </template>

        <template v-else-if="section === 'security'">
          <div class="field">
            <div class="field__label">闲置退出</div>
            <div class="field__control">
              <div class="inline">
                <el-input-number
                  v-model="draft.security.idleMinutes"
                  :disabled="!isAdmin"
                  :min="5"
                  :max="240"
                  controls-position="right"
                />
                <span class="unit">分钟</span>
              </div>
              <p class="field__help">
                这段时间没有键盘或指针操作，就退出到登录页。保存后立即按新时长计。
              </p>
            </div>
          </div>
          <div class="field">
            <div class="field__label">密码位数</div>
            <div class="field__control">
              <div class="inline">
                <el-input-number
                  v-model="draft.security.passwordMin"
                  :disabled="!isAdmin"
                  :min="6"
                  :max="32"
                  controls-position="right"
                />
                <span class="unit">位</span>
              </div>
              <p class="field__help">重置用户密码时至少要这么多位。</p>
            </div>
          </div>
        </template>

        <template v-else-if="section === 'integration'">
          <div class="field">
            <div class="field__label">告警回调</div>
            <div class="field__control">
              <div class="switch-line">
                <el-switch v-model="draft.integration.webhookEnabled" :disabled="!isAdmin" />
                <span>{{ draft.integration.webhookEnabled ? "已记下要通知" : "不通知" }}</span>
              </div>
              <el-input
                v-model="draft.integration.webhookUrl"
                :disabled="!isAdmin"
                placeholder="https://example.com/hooks/sample-box"
                clearable
              />
              <p class="field__help">
                地址保存在服务器配置里。告警目前仍只在系统内查看，还不会向这个地址发请求。
              </p>
            </div>
          </div>
        </template>

        <template v-else>
          <div class="note">
            {{
              form.host.trim()
                ? "保存前会先试连 MySQL，连上才切换。原来的 SQLite 文件还留在服务器上。"
                : "主机留空时继续使用本机 SQLite。"
            }}
          </div>
          <div class="field">
            <div class="field__label">主机</div>
            <div class="field__control">
              <el-input
                v-model="form.host"
                :disabled="!isAdmin"
                placeholder="留空则使用 SQLite"
                clearable
              />
            </div>
          </div>
          <div class="field">
            <div class="field__label">端口</div>
            <div class="field__control">
              <el-input v-model="form.port" :disabled="!isAdmin" />
            </div>
          </div>
          <div class="field">
            <div class="field__label">库名</div>
            <div class="field__control">
              <el-input v-model="form.database" :disabled="!isAdmin" />
            </div>
          </div>
          <div class="field">
            <div class="field__label">账号</div>
            <div class="field__control">
              <el-input v-model="form.user" :disabled="!isAdmin" />
            </div>
          </div>
          <div class="field">
            <div class="field__label">密码</div>
            <div class="field__control">
              <el-input
                v-model="form.password"
                type="password"
                show-password
                autocomplete="new-password"
                :disabled="!isAdmin"
                :placeholder="passwordHint"
              />
              <p class="field__help">密码只写入，不会回显。留空表示沿用已保存的密码。</p>
            </div>
          </div>
        </template>
      </div>

      <footer v-if="section !== 'access'" class="panel__foot">
        <span class="dirty">{{ footNote }}</span>
        <div class="actions">
          <el-button :disabled="!isAdmin || !dirty" @click="restore">还原</el-button>
          <el-button type="primary" :disabled="!isAdmin || !dirty" :loading="saving" @click="save">
            {{ section === "database" ? "保存并切换" : "保存" }}
          </el-button>
        </div>
      </footer>
    </section>
  </div>
</template>

<script setup lang="ts">
import { ElMessage, ElMessageBox } from "element-plus";
import SettingsAPI, {
  type ProductLabels,
  type ProductSettings,
  type TcpSettings,
} from "@/api/system/settings";
import fallbackLogo from "@/assets/images/logo.png";
import { useProductStore } from "@/stores/product";
import { useUserStore } from "@/stores/user";

type SectionId =
  "access" | "map" | "policy" | "brand" | "labels" | "security" | "integration" | "database";

const sections: { id: SectionId; label: string; hint: string; title: string; lead: string }[] = [
  {
    id: "access",
    label: "接入信息",
    hint: "只读",
    title: "接入信息",
    lead: "采样箱把报文送到这个 TCP 地址。这里的内容来自服务实际监听，不能在页面上改。",
  },
  {
    id: "map",
    label: "地图",
    hint: "天地图",
    title: "地图",
    lead: "采样箱位置用天地图。应用密钥和安全密钥保存在服务器配置，不写进前端仓库。",
  },
  {
    id: "policy",
    label: "默认策略",
    hint: "上报与任务",
    title: "采样箱默认策略",
    lead: "这些数值保存在系统配置里，作为以后下发任务和判断到达的默认值。设备此刻的上报间隔仍由采样箱自己决定。",
  },
  {
    id: "brand",
    label: "名称与图标",
    hint: "品牌",
    title: "名称与图标",
    lead: "登录页、侧栏和浏览器标签使用这里的名称和图标。",
  },
  {
    id: "labels",
    label: "显示名称",
    hint: "状态文案",
    title: "显示名称",
    lead: "状态短句保存在系统配置里。列表和详情目前仍用内置文案，改这里不会马上换掉那些页面上的字。",
  },
  {
    id: "security",
    label: "账号安全",
    hint: "密码与闲置",
    title: "账号安全",
    lead: "闲置退出在保存后立刻生效。密码位数用于重置用户密码。",
  },
  {
    id: "integration",
    label: "外部集成",
    hint: "回调地址",
    title: "外部集成",
    lead: "先把告警要通知的地址记下来。系统目前还不会向这个地址发请求。",
  },
  {
    id: "database",
    label: "数据库",
    hint: "连接",
    title: "数据库",
    lead: "主机留空继续用 SQLite。改成 MySQL 时会先测试连接，成功后才切换。",
  },
];

const labelGroups: { title: string; fields: { key: keyof ProductLabels; fallback: string }[] }[] = [
  {
    title: "生命周期",
    fields: [
      { key: "lifePending", fallback: "待激活" },
      { key: "lifeIdle", fallback: "未使用" },
    ],
  },
  {
    title: "上报类型",
    fields: [
      { key: "uplinkBoot", fallback: "上电" },
      { key: "uplinkTimer", fallback: "定时" },
    ],
  },
  {
    title: "箱盖",
    fields: [
      { key: "lidOpen", fallback: "开着" },
      { key: "lidShut", fallback: "关着" },
    ],
  },
  {
    title: "充电",
    fields: [
      { key: "chargeIdle", fallback: "未充电" },
      { key: "chargeOn", fallback: "充电中" },
    ],
  },
  {
    title: "在线",
    fields: [
      { key: "online", fallback: "在线" },
      { key: "offline", fallback: "离线" },
    ],
  },
  {
    title: "指示灯",
    fields: [
      { key: "ledMcu", fallback: "STM 指示灯" },
      { key: "ledModem", fallback: "4G 模块指示灯" },
    ],
  },
];

const userStore = useUserStore();
const productStore = useProductStore();
const loading = ref(false);
const saving = ref(false);
const section = ref<SectionId>("access");
const settings = ref<TcpSettings | null>(null);
const saved = ref<ProductSettings | null>(null);
const draft = reactive<ProductSettings>(blankProduct());
const skDraft = ref("");
const clearSk = ref(false);
const form = reactive({ host: "", port: "3306", database: "", user: "", password: "" });
const loadedDatabase = reactive({ host: "", port: "3306", database: "", user: "" });
const passwordSet = ref(false);
const isAdmin = computed(() => (userStore.userInfo.roles || []).includes("ADMIN"));
const current = computed(() => sections.find((item) => item.id === section.value) || sections[0]);
const portText = computed(() => (settings.value?.port == null ? "" : String(settings.value.port)));
const passwordHint = computed(() => (passwordSet.value ? "已设置，留空则不修改" : "请输入密码"));
const skPlaceholder = computed(() => {
  if (clearSk.value) return "保存后清除";
  return draft.map.skSet ? "已设置，留空则不修改" : "选填";
});
const logoPreview = computed(() => draft.brand.logoDataUrl || fallbackLogo);
const previewLabels = computed(() =>
  labelGroups.flatMap((group) =>
    group.fields.map((item) => draft.labels[item.key] || item.fallback)
  )
);

const dirty = computed(() => {
  if (section.value === "access") return false;
  if (section.value === "database") {
    return (
      form.host !== loadedDatabase.host ||
      form.port !== loadedDatabase.port ||
      form.database !== loadedDatabase.database ||
      form.user !== loadedDatabase.user ||
      form.password !== ""
    );
  }
  if (!saved.value) return false;
  if (section.value === "map") {
    return draft.map.tk !== saved.value.map.tk || skDraft.value !== "" || clearSk.value;
  }
  const id = section.value;
  if (
    id === "policy" ||
    id === "brand" ||
    id === "labels" ||
    id === "security" ||
    id === "integration"
  ) {
    return JSON.stringify(draft[id]) !== JSON.stringify(saved.value[id]);
  }
  return false;
});

const footNote = computed(() => {
  if (!isAdmin.value) return "只有系统管理员可以修改";
  if (dirty.value) return "有未保存的修改";
  return "已是最新配置";
});

function blankProduct(): ProductSettings {
  return {
    map: { tk: "", sk: "", skSet: false },
    policy: {
      reportIntervalSec: 60,
      scheduledReport: false,
      batteryPercent: 20,
      arrivalRadiusM: 2000,
    },
    brand: { name: "智采 · 采样箱", title: "智采 · 采样箱", logoDataUrl: "" },
    labels: {
      lifePending: "待激活",
      lifeIdle: "未使用",
      uplinkBoot: "上电",
      uplinkTimer: "定时",
      lidOpen: "开着",
      lidShut: "关着",
      chargeIdle: "未充电",
      chargeOn: "充电中",
      online: "在线",
      offline: "离线",
      ledMcu: "STM 指示灯",
      ledModem: "4G 模块指示灯",
    },
    security: { idleMinutes: 30, passwordMin: 8, lockAfter: 5 },
    integration: { webhookEnabled: false, webhookUrl: "" },
  };
}

function applyProduct(product: ProductSettings) {
  saved.value = JSON.parse(JSON.stringify(product));
  Object.assign(draft, JSON.parse(JSON.stringify(product)));
  skDraft.value = "";
  clearSk.value = false;
  productStore.apply(product);
}

function restore() {
  if (section.value === "database" && settings.value) {
    form.host = loadedDatabase.host;
    form.port = loadedDatabase.port;
    form.database = loadedDatabase.database;
    form.user = loadedDatabase.user;
    form.password = "";
    return;
  }
  if (!saved.value) return;
  const copy = JSON.parse(JSON.stringify(saved.value)) as ProductSettings;
  if (section.value === "map") {
    draft.map.tk = copy.map.tk;
    draft.map.skSet = copy.map.skSet;
    skDraft.value = "";
    clearSk.value = false;
    return;
  }
  const id = section.value;
  if (
    id === "policy" ||
    id === "brand" ||
    id === "labels" ||
    id === "security" ||
    id === "integration"
  ) {
    Object.assign(draft[id], copy[id]);
  }
}

async function choose(id: SectionId) {
  if (id === section.value) return;
  if (dirty.value) {
    try {
      await ElMessageBox.confirm("这一栏还有没保存的修改。", "切换栏目", {
        confirmButtonText: "放弃修改",
        cancelButtonText: "留在这里",
        type: "warning",
      });
    } catch {
      return;
    }
    restore();
  }
  section.value = id;
}

function onLogo(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
    ElMessage.warning("请上传 PNG、JPG 或 WebP");
    return;
  }
  if (file.size > 80 * 1024) {
    ElMessage.warning("图标需小于 80KB");
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    draft.brand.logoDataUrl = String(reader.result || "");
  };
  reader.readAsDataURL(file);
}

async function load() {
  loading.value = true;
  try {
    const data = await SettingsAPI.get();
    settings.value = data;
    const database = data.database;
    form.host = database?.host || "";
    form.port = String(database?.port || 3306);
    form.database = database?.database || "";
    form.user = database?.user || "";
    form.password = "";
    loadedDatabase.host = form.host;
    loadedDatabase.port = form.port;
    loadedDatabase.database = form.database;
    loadedDatabase.user = form.user;
    passwordSet.value = Boolean(database?.passwordSet);
    if (data.product) applyProduct(data.product);
  } finally {
    loading.value = false;
  }
}

async function save() {
  if (section.value === "database") {
    try {
      await ElMessageBox.confirm("保存后会按这个地址重新连接数据库。", "切换数据库", {
        confirmButtonText: "保存并切换",
        cancelButtonText: "取消",
        type: "warning",
      });
    } catch {
      return;
    }
    saving.value = true;
    try {
      const savedDatabase = await SettingsAPI.saveDatabase({
        host: form.host.trim(),
        port: Number(form.port),
        database: form.database.trim(),
        user: form.user.trim(),
        password: form.password,
      });
      form.password = "";
      passwordSet.value = savedDatabase.passwordSet;
      await load();
      ElMessage.success("已保存");
    } finally {
      saving.value = false;
    }
    return;
  }

  saving.value = true;
  try {
    const body: Partial<ProductSettings> = {};
    if (section.value === "map") {
      body.map = {
        tk: draft.map.tk.trim(),
        sk: skDraft.value,
        skSet: draft.map.skSet,
        clearSk: clearSk.value,
      };
    } else if (section.value === "policy") body.policy = { ...draft.policy };
    else if (section.value === "brand") body.brand = { ...draft.brand };
    else if (section.value === "labels") body.labels = { ...draft.labels };
    else if (section.value === "security") body.security = { ...draft.security };
    else if (section.value === "integration") body.integration = { ...draft.integration };
    const product = await SettingsAPI.saveProduct(body);
    applyProduct(product);
    ElMessage.success("已保存");
  } finally {
    saving.value = false;
  }
}

onMounted(load);
</script>

<style lang="scss" scoped>
.settings {
  display: flex;
  gap: 12px;
  height: 100%;
  min-height: 0;
}

.nav,
.panel {
  background: var(--content-bg);
  border: 1px solid var(--card-border);
  border-radius: var(--card-radius);
  box-shadow: var(--card-shadow);
}

.nav {
  flex: 0 0 196px;
  padding: 14px 10px;
  overflow: auto;
}

.nav__kicker {
  margin: 2px 10px 10px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.nav__item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  align-items: flex-start;
  width: 100%;
  padding: 8px 10px;
  margin: 0;
  color: var(--el-text-color-primary);
  text-align: left;
  cursor: pointer;
  background: transparent;
  border: 0;
  border-radius: 8px;

  small {
    font-size: 12px;
    color: var(--el-text-color-secondary);
  }

  &.is-on {
    color: var(--el-color-primary);
    background: var(--el-color-primary-light-9);

    small {
      color: var(--el-color-primary);
    }
  }

  &:focus-visible {
    outline: 2px solid var(--el-color-primary);
    outline-offset: 1px;
  }
}

.panel {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
}

.panel__head {
  flex-shrink: 0;
  padding: 20px 24px 0;

  h1 {
    margin: 0;
    font-size: 18px;
    font-weight: 600;
  }

  p {
    max-width: 680px;
    margin: 6px 0 0;
    font-size: 13px;
    line-height: 1.6;
    color: var(--el-text-color-secondary);
  }
}

.panel__body {
  flex: 1;
  min-height: 0;
  padding: 20px 24px 8px;
  overflow: auto;
}

.panel__foot {
  display: flex;
  flex-shrink: 0;
  gap: 12px;
  align-items: center;
  justify-content: space-between;
  padding: 12px 24px;
  border-top: 1px solid var(--card-border);
}

.dirty {
  font-size: 13px;
  color: var(--el-text-color-secondary);
}

.actions {
  display: flex;
  gap: 8px;
}

.status {
  display: flex;
  gap: 12px;
  align-items: flex-start;
  max-width: 720px;
  padding: 14px 16px;
  margin-bottom: 18px;
  background: var(--el-fill-color-light);
  border-radius: 8px;

  i {
    flex: 0 0 8px;
    width: 8px;
    height: 8px;
    margin-top: 6px;
    background: var(--el-text-color-placeholder);
    border-radius: 50%;
  }

  b {
    display: block;
    margin-bottom: 4px;
  }

  span {
    font-size: 13px;
    line-height: 1.5;
    color: var(--el-text-color-secondary);
  }

  &.is-on i {
    background: var(--el-color-success);
  }
}

.facts {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 280px));
  gap: 16px 32px;
  margin: 0;

  dt {
    margin-bottom: 4px;
    font-size: 12px;
    color: var(--el-text-color-secondary);
  }

  dd {
    margin: 0;
    word-break: break-all;
  }
}

.field {
  display: grid;
  grid-template-columns: 112px minmax(0, 460px);
  gap: 12px;
  margin-bottom: 18px;
}

.field__label {
  padding-top: 6px;
  font-size: 14px;
}

.field__help {
  margin: 6px 0 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--el-text-color-secondary);
}

.inline,
.switch-line {
  display: flex;
  gap: 8px;
  align-items: center;
}

.unit {
  color: var(--el-text-color-secondary);
}

h2 {
  margin: 4px 0 14px;
  font-size: 13px;
  font-weight: 600;
  color: var(--el-text-color-secondary);
}

.note {
  max-width: 640px;
  padding: 10px 12px;
  margin-bottom: 16px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--el-text-color-regular);
  background: var(--el-fill-color-light);
  border-radius: 8px;
}

.brand {
  display: flex;
  gap: 16px;
  align-items: center;
  margin-bottom: 20px;

  b {
    display: block;
    margin-bottom: 4px;
  }

  p {
    margin: 0;
    font-size: 12px;
    line-height: 1.6;
    color: var(--el-text-color-secondary);
  }
}

.logo {
  position: relative;
  display: grid;
  flex: 0 0 72px;
  place-items: center;
  width: 72px;
  height: 72px;
  overflow: hidden;
  cursor: pointer;
  background: var(--el-fill-color-light);
  border: 1px dashed var(--el-border-color);
  border-radius: 12px;

  img {
    width: 40px;
    height: 40px;
    object-fit: contain;
  }

  input {
    position: absolute;
    inset: 0;
    cursor: pointer;
    opacity: 0;
  }

  &.is-disabled {
    cursor: not-allowed;
  }
}

.text-btn {
  padding: 0;
  margin-left: 8px;
  color: var(--el-color-primary);
  cursor: pointer;
  background: none;
  border: 0;
}

.label-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 320px));
  gap: 8px 40px;

  h2 {
    margin-bottom: 8px;
  }
}

.label-row {
  display: grid;
  grid-template-columns: 96px minmax(0, 1fr);
  gap: 8px;
  align-items: center;
  margin-bottom: 8px;

  span {
    font-size: 13px;
    color: var(--el-text-color-secondary);
  }
}

.preview {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 8px;

  span {
    padding: 2px 8px;
    font-size: 12px;
    color: var(--el-text-color-regular);
    background: var(--el-fill-color-light);
    border-radius: 999px;
  }
}

@media (max-width: 860px) {
  .settings {
    flex-direction: column;
  }

  .nav {
    flex-basis: auto;
    overflow: auto;
    white-space: nowrap;
  }

  .nav__item {
    width: auto;
  }

  .facts,
  .label-grid,
  .field {
    grid-template-columns: 1fr;
  }
}
</style>
