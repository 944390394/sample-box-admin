<template>
  <div class="page-container page-flow">
    <PageHeader
      title="角色与权限"
      subtitle="一个人可以有多个角色，权限取并集，再被所在部门的权限上限封顶。系统管理员固定拥有全部权限。"
    >
      <template #actions>
        <el-button v-if="canCreate" type="primary" :icon="Plus" @click="openForm()">
          新增角色
        </el-button>
      </template>
    </PageHeader>

    <div class="layout">
      <aside class="roles">
        <el-input v-model="keyword" :prefix-icon="Search" placeholder="搜索角色" clearable />
        <ul v-loading="loading">
          <li
            v-for="role in shownRoles"
            :key="role.id"
            :class="{ on: role.id === currentId, off: role.status !== 1 }"
            :data-test="`role-${role.code}`"
            @click="pick(role.id!)"
          >
            <div class="role-line">
              <b>{{ role.name }}</b>
              <el-tag v-if="role.status !== 1" size="small" type="info">停用</el-tag>
            </div>
            <div class="text-muted">
              {{ scopeLabel(role.dataScope) }} · {{ role.userCount || 0 }} 人
            </div>
          </li>
        </ul>
      </aside>

      <el-card v-if="current" shadow="never" class="panel">
        <div class="panel-head">
          <div>
            <h3>
              {{ current.name }}
              <el-tag size="small" type="info">{{ current.code }}</el-tag>
            </h3>
            <p class="text-muted">
              数据范围：{{ scopeLabel(current.dataScope) }}（{{
                SCOPE_HINTS[Number(current.dataScope)] || ""
              }}） · {{ current.userCount || 0 }} 人有这个角色
              <template v-if="fixed">· 固定拥有全部权限</template>
            </p>
          </div>
          <div v-if="canUpdate || canScope || canDelete" class="ops">
            <el-button
              v-if="(canUpdate || canScope) && (!fixed || isAdmin)"
              @click="openForm(current.id)"
            >
              {{ canUpdate ? "编辑" : "改数据范围" }}
            </el-button>
            <el-button
              v-if="canDelete && !fixed && current.code !== 'HOME_SWITCH'"
              type="danger"
              plain
              @click="remove"
            >
              删除
            </el-button>
          </div>
        </div>

        <el-alert
          v-if="!formulaClosed"
          type="info"
          :closable="true"
          class="notice"
          data-test="perm-formula"
          @close="closeFormula"
        >
          <template #title>权限怎么算</template>
          <ul class="formula">
            <li>
              <b>实际权限</b>
              =（这个人所有角色的权限之和）∩（从顶级部门到他所在部门，每一级「权限上限」的交集）
            </li>
            <li>
              <b>实际数据范围</b>
              = 角色里最宽的那个，但不超过所在部门这条线上最窄的「最大数据范围」
            </li>
            <li>
              <b>能转授的</b>
              = 实际权限里、角色上开了「可转授」的那些
            </li>
          </ul>
        </el-alert>

        <div v-if="!fixed" class="toolbar">
          <template v-if="editable">
            <el-select
              :model-value="''"
              placeholder="从其他角色复制"
              filterable
              style="width: 180px"
              data-test="copy-role"
              @change="copyFrom"
            >
              <el-option
                v-for="role in roles.filter((r) => r.id !== currentId)"
                :key="role.id"
                :label="role.name"
                :value="role.id!"
              />
            </el-select>
            <el-dropdown trigger="click" @command="applyTemplate">
              <el-button data-test="templates">
                常用模板
                <el-icon class="el-icon--right"><ArrowDown /></el-icon>
              </el-button>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item v-for="tpl in templates" :key="tpl.key" :command="tpl.key">
                    <div class="tpl">
                      <b>{{ tpl.label }}</b>
                      <span>{{ tpl.codes.length }} 项</span>
                      <p>{{ tpl.hint }}</p>
                    </div>
                  </el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </template>
          <span class="text-muted tip">{{ notice }}</span>
        </div>

        <div class="perm-layout">
          <PermEditor
            v-model:codes="codes"
            v-model:grant="passed"
            class="editor"
            :groups="catalog"
            :tiers="tiers"
            :show-grant="showGrant"
            :editable="editable"
            :assignable="assignable"
            :reasons="reasons"
            :original="originalSet"
            :original-grant="originalPassedSet"
            :all-fixed="fixed"
          />

          <aside class="preview" data-test="perm-preview">
            <div class="pv">
              <h4>能看到的菜单</h4>
              <ul>
                <li v-for="menu in menuPreview" :key="menu.title" :class="{ off: !menu.on }">
                  <el-icon><component :is="menu.on ? Check : Close" /></el-icon>
                  {{ menu.title }}
                </li>
              </ul>
            </div>
            <div class="pv">
              <h4>工作台卡片</h4>
              <ul v-if="cardPreview.length">
                <li v-for="card in cardPreview" :key="card.title" :class="{ off: !card.on }">
                  <el-icon><component :is="card.on ? Check : Close" /></el-icon>
                  {{ card.title }}
                  <small v-if="!card.on">（缺看内容的权限）</small>
                </li>
              </ul>
              <p v-else class="text-muted small">一张卡片都没勾</p>
            </div>
            <div class="pv">
              <h4>采样箱详情</h4>
              <ul v-if="has('device:box:detail')">
                <li v-for="tab in boxTabs" :key="tab.title" :class="{ off: !tab.on }">
                  <el-icon><component :is="tab.on ? Check : Close" /></el-icon>
                  {{ tab.title }}
                </li>
              </ul>
              <p v-else class="text-muted small">没有「打开采样箱详情」，进不了详情页</p>
            </div>
            <div class="pv">
              <h4>任务详情</h4>
              <ul v-if="has('device:box:task')">
                <li v-for="part in taskParts" :key="part.title" :class="{ off: !part.on }">
                  <el-icon><component :is="part.on ? Check : Close" /></el-icon>
                  {{ part.title }}
                </li>
              </ul>
              <p v-else class="text-muted small">没有「查看任务单」，看不到任务单</p>
            </div>
          </aside>
        </div>

        <div v-if="editable" class="save-bar" data-test="save-bar">
          <span v-if="dirty" class="diff">
            <span v-if="diff.added.length" class="add">新增 {{ diff.added.length }} 项</span>
            <span v-if="diff.removed.length" class="del">收回 {{ diff.removed.length }} 项</span>
            <span v-if="diff.grantChanged.length" class="pass">
              可转授变化 {{ diff.grantChanged.length }} 项
            </span>
          </span>
          <span v-else class="text-muted">没有改动</span>
          <el-button :disabled="!dirty" @click="reset">撤销</el-button>
          <el-button
            type="primary"
            :disabled="!dirty"
            :loading="saving"
            data-test="save-perms"
            @click="confirmOpen = true"
          >
            保存权限
          </el-button>
        </div>
      </el-card>
      <el-empty v-else class="panel" description="选一个角色查看权限" />
    </div>

    <!-- 保存前确认：按模块列出这次的增减，收回的标红 -->
    <el-dialog
      v-model="confirmOpen"
      title="确认保存权限"
      width="560px"
      style="max-width: 94vw"
      data-test="confirm-perms"
    >
      <p class="confirm-lead">
        「{{ current?.name }}」这次
        <template v-if="diff.added.length">
          新增
          <b class="add">{{ diff.added.length }}</b>
          项
        </template>
        <template v-if="diff.added.length && diff.removed.length">、</template>
        <template v-if="diff.removed.length">
          收回
          <b class="del">{{ diff.removed.length }}</b>
          项
        </template>
        <template v-if="diff.grantChanged.length">
          ，可转授变化 {{ diff.grantChanged.length }} 项
        </template>
        。
      </p>
      <el-alert
        v-if="diff.removed.length && (current?.userCount || 0) > 0"
        type="warning"
        :closable="false"
        show-icon
        class="confirm-warn"
      >
        拥有这个角色的
        {{
          current?.userCount
        }}
        个人会失去标红的项（他们别的角色里有的不受影响），下一次操作起生效。
      </el-alert>
      <div class="confirm-list">
        <section v-for="mod in diffByModule" :key="mod.key">
          <h5>{{ mod.label }}</h5>
          <div
            v-for="row in mod.rows"
            :key="row.code + row.kind"
            class="confirm-row"
            :class="row.kind"
          >
            <span class="mark">
              {{ row.kind === "add" ? "＋" : row.kind === "del" ? "－" : "⇄" }}
            </span>
            <span>{{ row.label }}</span>
            <em v-if="row.kind === 'pass-on'">开可转授</em>
            <em v-else-if="row.kind === 'pass-off'">关可转授</em>
          </div>
        </section>
      </div>
      <template #footer>
        <el-button @click="confirmOpen = false">再看看</el-button>
        <el-button type="primary" :loading="saving" data-test="confirm-save" @click="save">
          确认保存
        </el-button>
      </template>
    </el-dialog>

    <el-dialog
      v-model="form.open"
      :title="form.data.id ? '编辑角色' : '新增角色'"
      width="480px"
      style="max-width: 94vw"
    >
      <el-form ref="formRef" :model="form.data" :rules="rules" label-position="top">
        <el-form-item label="角色名称" prop="name">
          <el-input v-model="form.data.name" maxlength="32" :disabled="!formCanEdit" />
        </el-form-item>
        <el-form-item label="角色编码" prop="code">
          <el-input
            v-model="form.data.code"
            maxlength="32"
            :disabled="Boolean(form.data.id)"
            placeholder="英文大写，如 SAMPLER"
          />
          <p v-if="!form.data.id" class="text-muted small">建好后不能改。</p>
        </el-form-item>
        <el-form-item label="数据范围">
          <el-select
            v-model="form.data.dataScope"
            style="width: 100%"
            :disabled="!canScope || formIsAdmin"
          >
            <el-option
              v-for="(label, value) in SCOPES"
              :key="value"
              :label="`${label}：${SCOPE_HINTS[Number(value)]}`"
              :value="Number(value)"
            />
          </el-select>
          <p class="text-muted small">
            <template v-if="formIsAdmin">系统管理员固定是全部数据。</template>
            <template v-else-if="!canScope">
              改数据范围要有「设置角色数据范围」。
              <template v-if="!form.data.id">新角色先是「仅本人」。</template>
            </template>
            <template v-else>
              决定能看到哪些单位的采样箱、任务和人员；不能比你自己的宽，还会被所在部门的「最大数据范围」封顶。
            </template>
          </p>
        </el-form-item>
        <el-row :gutter="12">
          <el-col :span="12">
            <el-form-item label="排序">
              <el-input-number
                v-model="form.data.sort"
                :min="0"
                style="width: 100%"
                :disabled="!formCanEdit"
              />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="状态">
              <el-switch
                v-model="form.data.status"
                :active-value="1"
                :inactive-value="0"
                active-text="启用"
                :disabled="formIsAdmin || !formCanEdit"
              />
            </el-form-item>
          </el-col>
        </el-row>
      </el-form>
      <template #footer>
        <el-button @click="form.open = false">取消</el-button>
        <el-button type="primary" :loading="form.saving" @click="saveForm">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: "Role" });

import type { FormInstance, FormRules } from "element-plus";
import { ArrowDown, Check, Close, Plus, Search } from "@element-plus/icons-vue";
import { onBeforeRouteLeave } from "vue-router";
import RoleAPI, { type PermGroup, type RoleTemplate } from "@/api/system/role";
import type { RoleForm, RoleItem } from "@/api/system/role/types";
import PageHeader from "@/components/biz/PageHeader.vue";
import PermEditor from "@/components/biz/PermEditor.vue";
import { usePerm } from "@/composables/usePerm";
import { useUserStore } from "@/stores/user";
import { buildIndex, fillNeeds, needsMet } from "@/utils/permDeps";

/**
 * 角色与权限：左边角色列表，右边用授权编辑器勾权限（按页面分模块、每模块 能进这页 → 能看到什么 → 能做什么），
 * 右侧实时预览这个角色能看到的菜单、工作台卡片、采样箱详情标签和任务详情内容。
 * 底部保存栏显示这次改了几项，保存前弹确认框按模块列出增减，收回的标红并写明影响几个人。
 *
 * 一个动作一个权限：新增、编辑、删除角色（sys:role:create/update/delete）、给角色分配权限（sys:role:grant）、
 * 设置角色数据范围（sys:role:scope）、给人员分配角色（sys:user:role，在人员页）各自单独授予。
 * 每项权限另有「可转授」：非管理员只能动自己可转授的权限，服务端会再校验。
 */
const SCOPES: Record<number, string> = {
  1: "全部数据",
  2: "本单位及下级",
  3: "本单位",
  4: "仅本人",
};
const SCOPE_HINTS: Record<number, string> = {
  1: "所有单位的箱子、任务和人员",
  2: "自己单位和下属单位的",
  3: "只有自己单位的",
  4: "只有自己保管的箱子和经手的任务",
};
const SETTINGS = [
  "sys:settings:view",
  "sys:settings:map",
  "sys:settings:branding",
  "sys:settings:labels",
  "sys:settings:db",
  "sys:settings:password",
  "sys:settings:lockout",
  "sys:settings:smtp",
  "sys:settings:video",
  "sys:settings:wechat",
  "device:box:policyDefault",
  "sys:settings:battery-reserve",
  "sys:settings:arrive-radius",
];
/** 菜单和看到它需要的权限（任意一个即可），和服务端 menus.js 一致。 */
const MENUS: { title: string; perms: string[] }[] = [
  { title: "工作台", perms: [] },
  { title: "总览", perms: ["monitor:overview"] },
  { title: "任务单", perms: ["device:box:task"] },
  { title: "创建任务单", perms: ["task:create:transfer", "task:create:sample"] },
  { title: "采样箱", perms: ["device:box:list"] },
  { title: "实时地图", perms: ["device:box:list"] },
  {
    title: "组织 · 部门",
    perms: [
      "sys:dept:view",
      "sys:dept:create",
      "sys:dept:update",
      "sys:dept:type",
      "sys:dept:address",
      "sys:dept:camera",
      "sys:dept:leader",
      "sys:dept:delete",
    ],
  },
  {
    title: "组织 · 人员",
    perms: [
      "sys:user:view",
      "sys:user:create",
      "sys:user:update",
      "sys:user:disable",
      "sys:user:enable",
      "sys:user:delete",
    ],
  },
  {
    title: "组织 · 角色与权限",
    perms: [
      "sys:role:view",
      "sys:role:create",
      "sys:role:update",
      "sys:role:delete",
      "sys:role:grant",
      "sys:role:scope",
    ],
  },
  { title: "系统 · 系统设置", perms: SETTINGS },
  { title: "系统 · 操作日志", perms: ["sys:oplog:read"] },
  { title: "系统 · 系统日志", perms: ["sys:runtime-log:read"] },
];
/** 有这几项之一，「可转授」才有意义：能把权限再授给别人。 */
const GRANTING = ["sys:role:grant", "sys:user:role", "sys:dept:limit"];
const FORMULA_KEY = "role-formula-closed";

const can = usePerm();
const userStore = useUserStore();
const isAdmin = computed(() => (userStore.userInfo.roles || []).includes("ADMIN"));
const canCreate = computed(() => can("sys:role:create"));
const canUpdate = computed(() => can("sys:role:update"));
const canDelete = computed(() => can("sys:role:delete"));
const canGrant = computed(() => can("sys:role:grant"));
const canScope = computed(() => can("sys:role:scope"));
const roles = ref<RoleItem[]>([]);
const loading = ref(false);
const keyword = ref("");
const currentId = ref("");
const catalog = ref<PermGroup[]>([]);
const tiers = ref<Record<string, string>>({});
const templates = ref<RoleTemplate[]>([]);
const codes = ref(new Set<string>());
const original = ref<string[]>([]);
/** 开了「可转授」的权限码，和保存前的样子。 */
const passed = ref(new Set<string>());
const originalPassed = ref<string[]>([]);
const fixed = ref(false);
/** 我能改的权限码（自己可转授的）；null 表示全部。 */
const assignable = ref<Set<string> | null>(null);
const reasons = ref<Record<string, string>>({});
const saving = ref(false);
const confirmOpen = ref(false);
const formulaClosed = ref(readFlag());

const index = computed(() => buildIndex(catalog.value));
const shownRoles = computed(() =>
  roles.value.filter((r) => !keyword.value || `${r.name}${r.code}`.includes(keyword.value))
);
const current = computed(() => roles.value.find((r) => r.id === currentId.value) || null);
const editable = computed(() => canGrant.value && !fixed.value);
const originalSet = computed(() => new Set(original.value));
const originalPassedSet = computed(() => new Set(originalPassed.value));
const showGrant = computed(
  () => fixed.value || GRANTING.some((code) => codes.value.has(code)) || passed.value.size > 0
);
const notice = computed(() => {
  if (fixed.value) return "";
  if (!canGrant.value)
    return canUpdate.value || canCreate.value
      ? "你可以新建、编辑角色，但没有「给角色分配权限」，这里只能查看。"
      : "只能查看。";
  const parts = ["勾一项会自动补上它的前置。"];
  if (assignable.value) parts.push("灰掉的项你不能动，鼠标移到锁图标上看原因。");
  if (!showGrant.value) parts.push("这个角色没有授权类权限，不用设「可转授」。");
  return parts.join("");
});

/** 只比较目录里列出的权限，老数据里不再显示的码不算。 */
const diff = computed(() => {
  const added: string[] = [];
  const removed: string[] = [];
  const grantChanged: string[] = [];
  for (const item of index.value.items) {
    const was = originalSet.value.has(item.code);
    const now = codes.value.has(item.code);
    if (!was && now) added.push(item.code);
    if (was && !now) removed.push(item.code);
    if (was && now && originalPassedSet.value.has(item.code) !== passed.value.has(item.code))
      grantChanged.push(item.code);
    if (!was && now && passed.value.has(item.code)) grantChanged.push(item.code);
  }
  return { added, removed, grantChanged };
});
const dirty = computed(() =>
  Boolean(diff.value.added.length || diff.value.removed.length || diff.value.grantChanged.length)
);
const diffByModule = computed(() =>
  catalog.value
    .map((group) => {
      const rows: { code: string; label: string; kind: string }[] = [];
      for (const item of group.items) {
        if (diff.value.added.includes(item.code))
          rows.push({ code: item.code, label: item.label, kind: "add" });
        if (diff.value.removed.includes(item.code))
          rows.push({ code: item.code, label: item.label, kind: "del" });
        if (diff.value.grantChanged.includes(item.code))
          rows.push({
            code: item.code,
            label: item.label,
            kind: passed.value.has(item.code) ? "pass-on" : "pass-off",
          });
      }
      return { key: group.key, label: group.label, rows };
    })
    .filter((mod) => mod.rows.length)
);

const scopeLabel = (value?: number) => SCOPES[Number(value) === 5 ? 3 : Number(value)] || "—";
const has = (code: string) => fixed.value || codes.value.has(code);
const any = (...list: string[]) => list.some(has);
const menuPreview = computed(() =>
  MENUS.map((m) => ({ title: m.title, on: !m.perms.length || any(...m.perms) }))
);
/** 卡片要「勾了这张」且有看里面内容的权限（目录里的前置）才显示，和服务端一致。 */
const cardPreview = computed(() =>
  (catalog.value.find((g) => g.key === "workbench")?.items || [])
    .filter((item) => has(item.code))
    .map((item) => ({
      title: item.label.replace(/「|」|卡片/g, ""),
      on: fixed.value || needsMet(item, codes.value),
    }))
);
const boxTabs = computed(() => [
  { title: "概览", on: true },
  { title: "电量、箱盖、信号", on: any("device:box:power", "device:box:lid", "device:box:signal") },
  {
    title: "轨迹",
    on: has("device:box:track") || (has("device:box:task") && has("device:box:location")),
  },
  {
    title: "事件",
    on: any("device:box:event-lid", "device:box:event-boot", "device:box:event-charge"),
  },
  { title: "任务", on: has("device:box:task") },
  { title: "上报记录", on: has("device:box:log") },
  {
    title: "ICCID、IMSI、固件版本",
    on: any("device:box:iccid", "device:box:imsi", "device:box:firmware"),
  },
]);
const taskParts = computed(() => [
  { title: "地图和轨迹", on: has("device:box:location") },
  { title: "箱子电量", on: has("device:box:power") },
  { title: "箱盖状态", on: has("device:box:lid") },
  { title: "开关箱记录", on: has("device:box:event-lid") },
  { title: "上报记录", on: has("task:log") },
  { title: "开箱录像", on: has("task:video") },
  { title: "监控画面", on: has("task:camera") },
  { title: "确认寄出", on: has("task:send") },
  { title: "签收", on: has("task:sign") },
  { title: "拒收", on: has("task:reject") },
  { title: "强制签收", on: has("task:force-sign") },
  { title: "取消任务", on: has("task:cancel") },
]);

function readFlag() {
  try {
    return localStorage.getItem(FORMULA_KEY) === "1";
  } catch {
    return false;
  }
}
function closeFormula() {
  formulaClosed.value = true;
  try {
    localStorage.setItem(FORMULA_KEY, "1");
  } catch {
    /* 存不了就下次再显示 */
  }
}

function canChange(code: string) {
  return editable.value && (!assignable.value || assignable.value.has(code));
}
/**
 * 用一份勾选替换当前的：只动我能改的项，不能改的保持原样；缺的前置自动补上。
 * grantOption 不传时保留原来的可转授开关（只留仍然拥有的）。
 */
function applyCodes(list: string[], grantOption?: string[]) {
  const want = new Set(list);
  const next = new Set(codes.value);
  let skipped = 0;
  for (const item of index.value.items) {
    if (want.has(item.code) === next.has(item.code)) continue;
    if (!canChange(item.code)) {
      skipped += 1;
      continue;
    }
    if (want.has(item.code)) next.add(item.code);
    else next.delete(item.code);
  }
  fillNeeds(next, index.value, canChange);
  const nextPassed = new Set(
    grantOption
      ? [...passed.value].filter((code) => !canChange(code)).concat(grantOption.filter(canChange))
      : passed.value
  );
  codes.value = next;
  passed.value = new Set([...nextPassed].filter((code) => next.has(code)));
  return skipped;
}
async function copyFrom(id: string) {
  const source = roles.value.find((r) => r.id === id);
  if (!source) return;
  const result = await RoleAPI.getPerms(id);
  const skipped = applyCodes(result.codes, result.grantOption);
  ElMessage.success(
    `已带入「${source.name}」的勾选${skipped ? `，其中 ${skipped} 项你不能改，保持原样` : ""}。没保存前可以撤销`
  );
}
function applyTemplate(key: string) {
  const tpl = templates.value.find((t) => t.key === key);
  if (!tpl) return;
  const skipped = applyCodes(tpl.codes);
  ElMessage.success(
    `已套用模板「${tpl.label}」${skipped ? `，其中 ${skipped} 项你不能改，保持原样` : ""}。没保存前可以撤销`
  );
}
function reset() {
  codes.value = new Set(original.value);
  passed.value = new Set(originalPassed.value);
}

async function loadRoles() {
  loading.value = true;
  try {
    const page = await RoleAPI.getPage({ pageNum: 1, pageSize: 200 });
    roles.value = page.list;
    if (!currentId.value && roles.value.length) await pick(roles.value[0].id!);
  } finally {
    loading.value = false;
  }
}
async function confirmDiscard(title: string) {
  if (!dirty.value || !editable.value) return true;
  try {
    await ElMessageBox.confirm("当前角色的权限还没保存，离开后会丢失。", title, {
      type: "warning",
      confirmButtonText: "不保存，离开",
      cancelButtonText: "留下",
    });
    return true;
  } catch {
    return false;
  }
}
async function pick(id: string) {
  if (id === currentId.value || !(await confirmDiscard("切换角色"))) return;
  currentId.value = id;
  const result = await RoleAPI.getPerms(id);
  fixed.value = result.fixed;
  assignable.value = result.assignable ? new Set(result.assignable) : null;
  reasons.value = result.reasons || {};
  original.value = result.codes;
  codes.value = new Set(result.codes);
  originalPassed.value = result.grantOption || [];
  passed.value = new Set(originalPassed.value);
}
async function save() {
  if (!current.value) return;
  saving.value = true;
  try {
    await RoleAPI.savePerms(
      current.value.id!,
      [...codes.value],
      [...passed.value].filter((code) => codes.value.has(code))
    );
    original.value = [...codes.value];
    originalPassed.value = [...passed.value];
    confirmOpen.value = false;
    ElMessage.success("已保存，相关人员下一次操作就按新权限");
  } finally {
    saving.value = false;
  }
}
async function remove() {
  if (!current.value) return;
  const n = current.value.userCount || 0;
  try {
    await ElMessageBox.confirm(
      `删除角色「${current.value.name}」后，${n ? `拥有这个角色的 ${n} 个人` : "拥有这个角色的人"}会失去对应权限。`,
      "删除角色",
      {
        type: "warning",
        confirmButtonText: "删除",
        cancelButtonText: "取消",
      }
    );
  } catch {
    return;
  }
  await RoleAPI.deleteByIds(current.value.id!);
  ElMessage.success("已删除");
  currentId.value = "";
  original.value = [...codes.value];
  originalPassed.value = [...passed.value];
  await loadRoles();
}

onBeforeRouteLeave(() => confirmDiscard("离开页面"));

const formRef = ref<FormInstance>();
const form = reactive({ open: false, saving: false, data: {} as RoleForm });
const formIsAdmin = computed(() => form.data.code === "ADMIN" && Boolean(form.data.id));
/** 新建看「新增角色」，编辑已有的看「编辑角色」。 */
const formCanEdit = computed(() => (form.data.id ? canUpdate.value : canCreate.value));
const rules: FormRules = {
  name: [{ required: true, message: "请填写角色名称", trigger: "blur" }],
  code: [
    { required: true, message: "请填写角色编码", trigger: "blur" },
    {
      // 只校验新建：老角色的编码不能改，格式不对也照样能保存别的
      validator: (_rule, value, done) =>
        form.data.id || /^[A-Z][A-Z0-9_]{1,31}$/.test(String(value || ""))
          ? done()
          : done(new Error("英文大写字母开头，可含数字和下划线")),
      trigger: "blur",
    },
  ],
};
async function openForm(id = "") {
  form.data = id
    ? await RoleAPI.getFormData(id)
    : {
        name: "",
        code: "",
        dataScope: canScope.value ? 3 : 4,
        sort: roles.value.length + 1,
        status: 1,
      };
  if (Number(form.data.dataScope) === 5) form.data.dataScope = 3;
  form.open = true;
}
async function saveForm() {
  if (!(await formRef.value?.validate().catch(() => false))) return;
  form.saving = true;
  try {
    if (form.data.id) await RoleAPI.update(form.data.id, form.data);
    else await RoleAPI.create(form.data);
    ElMessage.success("已保存");
    form.open = false;
    await loadRoles();
  } finally {
    form.saving = false;
  }
}

onMounted(async () => {
  const result = await RoleAPI.permCatalog();
  catalog.value = result.groups;
  tiers.value = result.tiers || {};
  templates.value = result.templates || [];
  await loadRoles();
});
</script>

<style scoped>
.layout {
  display: flex;
  gap: 12px;
  align-items: flex-start;
}
.roles {
  position: sticky;
  top: 0;
  display: flex;
  flex: 0 0 220px;
  flex-direction: column;
  gap: 8px;
  max-height: calc(100vh - 140px);
  padding: 12px;
  overflow: auto;
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
}
.roles ul {
  padding: 0;
  margin: 0;
  list-style: none;
}
.roles li {
  padding: 8px 10px;
  cursor: pointer;
  border-radius: 6px;
}
.roles li:hover {
  background: var(--el-fill-color-lighter);
}
.roles li.on {
  background: var(--el-color-primary-light-9);
}
.roles li.off b {
  color: var(--el-text-color-secondary);
}
.role-line {
  display: flex;
  gap: 6px;
  align-items: center;
}
/* el-card 和卡片体的 overflow 不是 visible 时，里面的模块目录、保存栏 sticky 会失效 */
.panel {
  flex: 1;
  min-width: 0;
  overflow: visible;
}
.panel :deep(.el-card__body) {
  overflow: visible;
}
.panel-head {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: flex-start;
  justify-content: space-between;
  margin-bottom: 12px;
}
.panel-head h3 {
  margin: 0;
}
.panel-head p {
  margin: 4px 0 0;
}
.ops {
  display: flex;
  gap: 8px;
}
.notice {
  margin-bottom: 12px;
}
.formula {
  padding-left: 18px;
  margin: 4px 0 0;
  line-height: 1.7;
}
.toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 12px;
  align-items: center;
  margin-bottom: 12px;
}
.toolbar .tip {
  font-size: 12px;
}
.tpl {
  max-width: 320px;
  padding: 2px 0;
  line-height: 1.5;
}
.tpl span {
  margin-left: 8px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.tpl p {
  margin: 0;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  white-space: normal;
}
.perm-layout {
  display: flex;
  gap: 16px;
  align-items: flex-start;
}
.editor {
  flex: 1;
  min-width: 0;
}
.preview {
  position: sticky;
  top: 0;
  flex: 0 0 220px;
  padding: 12px;
  background: var(--el-fill-color-lighter);
  border-radius: 8px;
}
.preview h4 {
  margin: 0 0 6px;
}
.pv {
  margin-bottom: 14px;
}
.pv small {
  font-size: 11px;
}
.preview ul {
  padding: 0;
  margin: 0;
  list-style: none;
}
.preview li {
  display: flex;
  gap: 6px;
  align-items: center;
  padding: 3px 0;
  font-size: 13px;
  color: var(--el-color-success);
}
.preview li.off {
  color: var(--el-text-color-placeholder);
}
.small {
  margin: 4px 0 0;
  font-size: 12px;
}
.save-bar {
  position: sticky;
  bottom: 0;
  z-index: 3;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  justify-content: flex-end;
  padding: 12px 0 4px;
  margin-top: 12px;
  background: var(--el-bg-color);
  border-top: 1px solid var(--el-border-color-lighter);
}
.diff {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  margin-right: auto;
  font-size: 13px;
}
.add {
  color: var(--el-color-success);
}
.del {
  color: var(--el-color-danger);
}
.pass {
  color: var(--el-color-primary);
}
.confirm-lead {
  margin: 0 0 10px;
}
.confirm-warn {
  margin-bottom: 10px;
}
.confirm-list {
  max-height: 50vh;
  overflow: auto;
}
.confirm-list h5 {
  margin: 10px 0 4px;
  font-size: 13px;
}
.confirm-row {
  display: flex;
  gap: 6px;
  align-items: center;
  padding: 2px 0;
  font-size: 13px;
}
.confirm-row .mark {
  width: 16px;
  font-weight: 700;
  text-align: center;
}
.confirm-row.add {
  color: var(--el-color-success-dark-2);
}
.confirm-row.del {
  color: var(--el-color-danger);
}
.confirm-row.pass-on,
.confirm-row.pass-off {
  color: var(--el-color-primary);
}
.confirm-row em {
  font-size: 12px;
  font-style: normal;
  color: var(--el-text-color-secondary);
}
@media (max-width: 1440px) {
  .perm-layout {
    flex-direction: column;
  }
  .preview {
    position: static;
    display: grid;
    flex: none;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 0 16px;
    width: 100%;
  }
}
@media (max-width: 1000px) {
  .layout {
    flex-direction: column;
  }
  .roles {
    position: static;
    flex: none;
    width: 100%;
    max-height: none;
  }
  .roles ul {
    display: flex;
    gap: 6px;
    overflow-x: auto;
  }
  .roles li {
    flex: none;
    border: 1px solid var(--el-border-color-lighter);
  }
}
</style>
