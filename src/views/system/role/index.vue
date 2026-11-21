<template>
  <div class="page-container page-flow role-page">
    <div class="role-head">
      <PageHeader
        title="角色与权限"
        subtitle="给角色配功能权限与数据范围：多角色取并集、被所在部门权限上限封顶，系统管理员固定拥有全部权限。"
      >
        <template #actions>
          <el-button v-if="canCreate" type="primary" :icon="Plus" @click="openForm()">
            新增角色
          </el-button>
        </template>
      </PageHeader>
    </div>

    <!-- <900px：左角色列收成顶部下拉选择（拖拽排序在宽屏列表里） -->
    <div v-if="narrow" class="role-switch">
      <span class="role-switch-label">当前角色</span>
      <el-select
        :model-value="currentId"
        filterable
        placeholder="选择角色"
        class="role-switch-select"
        data-test="role-switch"
        @change="onSwitch"
      >
        <el-option v-for="role in roles" :key="role.id" :label="role.name" :value="role.id!">
          <span class="opt-name">{{ role.name }}</span>
          <span class="opt-code">{{ role.code }}</span>
          <el-tag v-if="role.status !== 1" size="small" type="info">停用</el-tag>
        </el-option>
      </el-select>
    </div>

    <div class="layout">
      <aside v-if="!narrow" class="roles">
        <div class="roles-head">
          <b>角色列表</b>
          <span class="roles-count">{{ shownRoles.length }}</span>
        </div>
        <div class="roles-search">
          <el-input v-model="keyword" :prefix-icon="Search" placeholder="搜索角色" clearable />
        </div>
        <p v-if="canUpdate && keyword" class="text-muted sort-hint" data-test="sort-hint">
          清空搜索后排序
        </p>
        <ul v-loading="loading">
          <li
            v-for="role in shownRoles"
            :key="role.id"
            :class="{
              on: role.id === currentId,
              off: role.status !== 1,
              dragging: dragId === role.id,
              'drop-before': dropId === role.id && !dropAfter,
              'drop-after': dropId === role.id && dropAfter,
            }"
            :draggable="canDrag"
            :data-test="`role-${role.code}`"
            @click="pick(role.id!)"
            @dragstart="onDragStart(role, $event)"
            @dragover="onDragOver(role, $event)"
            @dragleave="onDragLeave(role, $event)"
            @drop="onDrop(role, $event)"
            @dragend="resetDrag"
          >
            <div class="role-line">
              <button
                v-if="canUpdate"
                type="button"
                class="drag-handle"
                :data-test="`role-drag-${role.code}`"
                :aria-label="`调整「${role.name}」的顺序：拖动，或聚焦后按 Alt+上/下方向键移动一位`"
                :disabled="!canDrag"
                @click.stop
                @keydown.alt.up.prevent="moveByKeyboard(role, -1)"
                @keydown.alt.down.prevent="moveByKeyboard(role, 1)"
              >
                <el-icon><Rank /></el-icon>
              </button>
              <b>{{ role.name }}</b>
              <el-tag v-if="role.status !== 1" size="small" type="info">停用</el-tag>
              <span class="role-users">{{ role.userCount || 0 }} 人</span>
            </div>
            <div class="role-meta">
              <span class="role-code">{{ role.code }}</span>
              <el-tag size="small" type="info" effect="plain">
                {{ scopeShort(role.dataScope) }}
              </el-tag>
            </div>
          </li>
        </ul>
      </aside>

      <section v-if="current" class="panel">
        <div class="panel-head">
          <div class="panel-title">
            <h3>
              {{ current.name }}
              <span class="code-tag">{{ current.code }}</span>
            </h3>
            <p class="text-muted">
              数据范围：{{ scopeLabel(current.dataScope) }}（{{
                SCOPE_HINTS[Number(current.dataScope)] || ""
              }}） · {{ current.userCount || 0 }} 人有这个角色
              <template v-if="fixed">· 固定拥有全部权限</template>
            </p>
          </div>
          <div class="panel-ops">
            <el-button
              v-if="previewDrawerMode"
              :icon="View"
              data-test="preview-open"
              @click="previewOpen = true"
            >
              预览
            </el-button>
            <div v-if="canUpdate || canScope || canDelete || canAudit" class="ops">
              <el-button v-if="canAudit" data-test="role-audit-open" @click="openAudit">
                授权审计
              </el-button>
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

        <!-- #26 B4：数据范围也是授权的一部分——和权限一起草稿、一起确认保存。
             选 5（自定义）时出部门多选树（scoped options，壳节点禁选）。 -->
        <div v-if="!fixed" class="scope-row" data-test="scope-row">
          <span class="scope-label">数据范围</span>
          <RoleScopePicker
            v-model="scopeDraft"
            v-model:dept-ids="deptDraft"
            :options="deptOptions"
            :disabled="!canScope"
            :my-scope="myScope"
            class="scope-picker"
          />
          <el-tag v-if="scopeDirty" size="small" type="warning" effect="plain">未保存</el-tag>
        </div>

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
        </div>

        <div v-if="editable || canScope" class="save-bar" data-test="save-bar">
          <span v-if="dirty" class="diff">
            <span v-if="diff.added.length" class="add">新增 {{ diff.added.length }} 项</span>
            <span v-if="diff.removed.length" class="del">收回 {{ diff.removed.length }} 项</span>
            <span v-if="diff.grantChanged.length" class="pass">
              可转授变化 {{ diff.grantChanged.length }} 项
            </span>
            <span v-if="scopeDirty" class="pass">
              数据范围 {{ scopeLabel(originalScope) }} → {{ scopeLabel(scopeDraft) }}
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
            保存授权
          </el-button>
        </div>
      </section>
      <el-empty v-else class="panel" description="选一个角色查看权限" />

      <!-- 右栏独立预览卡（第三栏）：与角色卡/编辑器卡平级，sticky 吸顶 -->
      <aside v-if="current && !previewDrawerMode" class="preview" data-test="perm-preview">
        <RolePreviewPanel
          :menus="menuPreview"
          :loading="previewLoading"
          :cards="cardPreview"
          :box-tabs="boxTabs"
          :task-parts="taskParts"
          :can-detail="has('device:box:detail')"
          :can-task="has('device:box:task')"
        />
      </aside>
    </div>

    <!-- <1200px：右预览栏改抽屉，同一预览组件、同一份数据 -->
    <el-drawer
      v-if="previewDrawerMode"
      v-model="previewOpen"
      title="权限预览"
      size="340px"
      append-to-body
      class="role-preview-drawer"
    >
      <div data-test="perm-preview">
        <RolePreviewPanel
          :menus="menuPreview"
          :loading="previewLoading"
          :cards="cardPreview"
          :box-tabs="boxTabs"
          :task-parts="taskParts"
          :can-detail="has('device:box:detail')"
          :can-task="has('device:box:task')"
        />
      </div>
    </el-drawer>

    <!-- 保存前确认：按模块列出这次的增减，收回的标红；数据范围变化单列 -->
    <el-dialog
      v-model="confirmOpen"
      title="确认保存授权"
      width="560px"
      style="max-width: 94vw"
      data-test="confirm-perms"
    >
      <p class="confirm-lead">「{{ current?.name }}」这次{{ changeSummary }}。</p>
      <el-alert
        v-if="diff.removed.length && (current?.userCount || 0) > 0"
        type="warning"
        :closable="false"
        show-icon
        class="confirm-warn"
      >
        拥有这个角色的
        {{ current?.userCount }}
        个人会失去标红的项（他们别的角色里有的不受影响），下一次操作起生效。
      </el-alert>
      <div v-if="scopeDirty" class="confirm-scope" data-test="confirm-scope">
        <h5>数据范围</h5>
        <p>
          {{ scopeLabel(originalScope) }} →
          <b class="hl">{{ scopeLabel(scopeDraft) }}</b>
          <template v-if="scopeDraft === 5">
            <template v-if="deptDraft.length">
              ：{{
                draftDeptNames.join("、")
              }}（各单位含其下级，再被所在部门的「最大数据范围」封顶）
            </template>
            <template v-else>
              ：没勾选任何单位，拥有这个角色的将看不到任何单位的箱子、任务和人员。
            </template>
          </template>
        </p>
      </div>
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
          <RoleScopePicker
            v-model="form.data.dataScope"
            v-model:dept-ids="form.data.deptIds"
            :options="deptOptions"
            :disabled="!canScope"
            :my-scope="myScope"
            :admin-fixed="formIsAdmin"
            :creating="!form.data.id"
          />
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

    <!-- #26 B4：授权审计抽屉（只读）——谁在何时把哪些权限/可转授/范围授给该角色 -->
    <RoleAuditDrawer v-model="audit.open" :role-id="audit.roleId" :role-name="audit.roleName" />
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: "Role" });

import type { FormInstance, FormRules } from "element-plus";
import { ArrowDown, Plus, Rank, Search, View } from "@element-plus/icons-vue";
import { onBeforeRouteLeave } from "vue-router";
import RoleAPI, {
  type PermGroup,
  type RoleTemplate,
  type MenuPreviewItem,
} from "@/api/system/role";
import type { RoleForm, RoleItem } from "@/api/system/role/types";
import DeptAPI from "@/api/system/dept";
import type { OptionItem } from "@/api/common";
import PageHeader from "@/components/biz/PageHeader.vue";
import PermEditor from "@/components/biz/PermEditor.vue";
import RoleScopePicker from "./components/RoleScopePicker.vue";
import RoleAuditDrawer from "./components/RoleAuditDrawer.vue";
import RolePreviewPanel from "./components/RolePreviewPanel.vue";
import { usePerm } from "@/composables/usePerm";
import { useUserStore } from "@/stores/user";
import { buildIndex, fillNeeds, needsMet } from "@/utils/permDeps";

/**
 * 角色与权限（企业级三栏，阿里云 RAM 基线）：左 260px 角色列表卡（搜索＋滚动列表＋
 * 拖拽排序把手 hover 显形，Alt+↑/↓ 键盘兜底；PUT /roles/reorder 持久化，角色下拉、
 * 人员表单角色选择同序；搜索过滤态禁拖），中 flex 权限编辑器卡（按页面分模块、
 * 每模块 能进这页 → 能看到什么 → 能做什么，sticky 组头＋双 checkbox 密排），
 * 右 300px 只读预览 sticky 卡（菜单/工作台卡片/采样箱详情/任务详情四页签；
 * 菜单走服务端 menusFor 同一实现，不再前端自抄菜单表）。
 * 响应式：<1200px 预览改「预览」按钮抽屉；<900px 角色列改顶部下拉。
 * 数据范围（1–4 预设 + 5 自定义部门多选树）和权限一起草稿、一起 diff 确认保存；
 * 套用模板时一键带入 suggestedScope；「授权审计」抽屉只读回看谁在何时授了什么。
 * 底部保存栏显示这次改了几项，保存前弹确认框按模块列出增减，收回的标红并写明影响几个人。
 *
 * 一个动作一个权限：新增、编辑、删除角色（sys:role:create/update/delete）、给角色分配权限（sys:role:grant）、
 * 设置角色数据范围（sys:role:scope）、给人员分配角色（sys:user:role，在人员页）各自单独授予。
 * 每项权限另有「可转授」：非管理员只能动自己可转授的权限，服务端会再校验。
 * 自定义范围 D3：orgIds ⊆ 自己 manageOrgIds，仅 scope≤2 的角色可授 5，与部门上限取交集封顶（服务端兜底）。
 */
const SCOPES: Record<number, string> = {
  1: "全部数据",
  2: "本单位及下级",
  3: "本单位",
  4: "仅本人",
  5: "自定义部门数据",
};
/** 左列表 scope tag 用的短标签（呈现层，完整口径仍在面板头/选择器）。 */
const SCOPES_SHORT: Record<number, string> = {
  1: "全部",
  2: "本单位及下级",
  3: "本单位",
  4: "仅本人",
  5: "自定义",
};
const SCOPE_HINTS: Record<number, string> = {
  1: "所有单位的箱子、任务和人员",
  2: "自己单位和下属单位的",
  3: "只有自己单位的",
  4: "只有自己保管的箱子和经手的任务",
  5: "只看勾选的单位（含其下级）",
};
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
/** 授权审计抽屉入口：能看角色（view/update/scope/grant 任一）就能看审计。 */
const canAudit = computed(
  () => can("sys:role:view") || canUpdate.value || canScope.value || canGrant.value
);
const roles = ref<RoleItem[]>([]);
const loading = ref(false);
const keyword = ref("");
/* ---- 左列表拖拽排序（sys:role:update）：乐观更新＋失败回滚；键盘 Alt+↑/↓ 兜底 ---- */
const dragId = ref("");
const dropId = ref("");
const dropAfter = ref(false);
const orderSaving = ref(false);
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

/* ---- 响应式呈现：<1200 预览抽屉；<900 角色下拉（逻辑不变，只换载体） ---- */
const previewDrawerMode = useMediaQuery("(max-width: 1199px)");
const narrow = useMediaQuery("(max-width: 899px)");
const previewOpen = ref(false);

/* ---- #26 B4：数据范围草稿 + 菜单预览单源 + 授权审计 ---- */
/** 自己最宽的数据范围（permCatalog.myScope）：D3 前端预校验用。 */
const myScope = ref(4);
/** 部门多选树选项：后端 scoped options（manage 子树+祖先壳，壳带 readOnly）。 */
const deptOptions = ref<OptionItem[]>([]);
const scopeDraft = ref(4);
const deptDraft = ref<string[]>([]);
const originalScope = ref(4);
const originalDeptIds = ref<string[]>([]);
/** 菜单预览：服务端 menusFor 同一实现。savedPreview 是已保存状态的缓存。 */
const menuPreview = ref<MenuPreviewItem[]>([]);
const savedPreview = ref<MenuPreviewItem[]>([]);
const previewLoading = ref(false);
const audit = reactive({ open: false, roleId: "", roleName: "" });

const index = computed(() => buildIndex(catalog.value));
const shownRoles = computed(() =>
  roles.value.filter((r) => !keyword.value || `${r.name}${r.code}`.includes(keyword.value))
);
/** 有「编辑角色」、不在搜索过滤态、也没有正在保存的顺序，才允许拖拽/键盘排序。 */
const canDrag = computed(() => canUpdate.value && !keyword.value && !orderSaving.value);
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
const permDirty = computed(() =>
  Boolean(diff.value.added.length || diff.value.removed.length || diff.value.grantChanged.length)
);
/** 数据范围草稿和已保存的是否不一样（自定义部门按集合比）。 */
const scopeDirty = computed(() => {
  if (fixed.value) return false;
  if (scopeDraft.value !== originalScope.value) return true;
  if (scopeDraft.value !== 5) return false;
  const was = new Set(originalDeptIds.value);
  return deptDraft.value.length !== was.size || deptDraft.value.some((id) => !was.has(id));
});
const dirty = computed(() => permDirty.value || scopeDirty.value);
/** 可管部门 id 集合（scoped options 里非壳节点）：D3 预校验「自定义部门 ⊆ 自己 manage」。 */
const manageOptionIds = computed(() => {
  const ids = new Set<string>();
  const walk = (list: OptionItem[]) => {
    for (const item of list) {
      if (!item.readOnly) ids.add(String(item.value));
      if (item.children?.length) walk(item.children);
    }
  };
  walk(deptOptions.value);
  return ids;
});
const optionLabels = computed(() => {
  const map = new Map<string, string>();
  const walk = (list: OptionItem[]) => {
    for (const item of list) {
      map.set(String(item.value), item.label);
      if (item.children?.length) walk(item.children);
    }
  };
  walk(deptOptions.value);
  return map;
});
const draftDeptNames = computed(() =>
  deptDraft.value.map((id) => optionLabels.value.get(id) || id)
);
const changeSummary = computed(() => {
  const parts: string[] = [];
  if (diff.value.added.length) parts.push(`新增 ${diff.value.added.length} 项`);
  if (diff.value.removed.length) parts.push(`收回 ${diff.value.removed.length} 项`);
  if (diff.value.grantChanged.length) parts.push(`可转授变化 ${diff.value.grantChanged.length} 项`);
  if (scopeDirty.value)
    parts.push(`数据范围 ${scopeLabel(originalScope.value)} → ${scopeLabel(scopeDraft.value)}`);
  return parts.join("、") || "没有改动";
});
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

const scopeLabel = (value?: number) => SCOPES[Number(value)] || "—";
const scopeShort = (value?: number) => SCOPES_SHORT[Number(value)] || "—";
const has = (code: string) => fixed.value || codes.value.has(code);
const any = (...list: string[]) => list.some(has);
/**
 * D3 前端预校验（服务端 checkCustomDeptIds 兜底）：
 * 范围不能比自己的宽；自定义 5 仅 scope≤2 可授；自定义部门只能选自己 manage 内的。
 * options 还没拉到时不做子集检查（避免误拦），交给服务端。
 */
function scopeProblem(scope: number, deptIds: string[]): string {
  if (scope === 5) {
    if (myScope.value > 2) return "只有「本单位及下级」以上数据范围的角色能设置自定义部门";
    if (deptOptions.value.length) {
      const outside = deptIds.filter((id) => !manageOptionIds.value.has(String(id)));
      if (outside.length) return "自定义部门只能选自己管理范围内的部门";
    }
    return "";
  }
  if (scope < myScope.value) return "数据范围不能比你自己的宽";
  return "";
}
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
  // 数据范围也是授权的一部分：有「设置角色数据范围」时一起带入（D3 预校验在保存时把关）
  let scopeNote = "";
  if (canScope.value && !fixed.value) {
    const scope = Number(source.dataScope ?? 4);
    scopeDraft.value = scope;
    deptDraft.value = scope === 5 ? await RoleAPI.getRoleDeptIds(id).catch(() => []) : [];
    scopeNote = `，数据范围带入「${scopeLabel(scope)}」`;
  }
  ElMessage.success(
    `已带入「${source.name}」的勾选${skipped ? `，其中 ${skipped} 项你不能改，保持原样` : ""}${scopeNote}。没保存前可以撤销`
  );
}
function applyTemplate(key: string) {
  const tpl = templates.value.find((t) => t.key === key);
  if (!tpl) return;
  const skipped = applyCodes(tpl.codes);
  // #26 B4：模板的建议数据范围一键带入（没保存前可以撤销）
  let scopeNote = "";
  if (canScope.value && !fixed.value && tpl.suggestedScope != null) {
    scopeDraft.value = Number(tpl.suggestedScope);
    if (scopeDraft.value !== 5) deptDraft.value = [];
    scopeNote = `，数据范围带入「${scopeLabel(scopeDraft.value)}」`;
  }
  ElMessage.success(
    `已套用模板「${tpl.label}」${skipped ? `，其中 ${skipped} 项你不能改，保持原样` : ""}${scopeNote}。没保存前可以撤销`
  );
}
function reset() {
  codes.value = new Set(original.value);
  passed.value = new Set(originalPassed.value);
  scopeDraft.value = originalScope.value;
  deptDraft.value = [...originalDeptIds.value];
}

/** 部门多选树选项：后端已按 scope 裁剪（manage 子树+祖先壳），前端不再拉全量树。 */
async function loadDeptOptions() {
  try {
    deptOptions.value = await DeptAPI.getOptions();
  } catch {
    deptOptions.value = [];
  }
}
/** 选中角色后把数据范围草稿同步成已保存的样子（自定义 5 还要拉 sys_role_dept）。 */
async function syncScopeDraft(role?: RoleItem | null) {
  const scope = Number(role?.dataScope ?? 4);
  scopeDraft.value = scope;
  originalScope.value = scope;
  let ids: string[] = [];
  if (scope === 5 && role?.id) ids = await RoleAPI.getRoleDeptIds(role.id).catch(() => []);
  deptDraft.value = [...ids];
  originalDeptIds.value = [...ids];
}
/** 已保存状态的菜单预览（GET，服务端 menusFor）。 */
async function loadSavedPreview(id: string) {
  previewLoading.value = true;
  try {
    const result = await RoleAPI.getMenuPreview(id);
    if (currentId.value !== id) return;
    savedPreview.value = result.menus;
    if (!permDirty.value) menuPreview.value = result.menus;
  } catch {
    if (currentId.value === id) {
      savedPreview.value = [];
      menuPreview.value = [];
    }
  } finally {
    if (currentId.value === id) previewLoading.value = false;
  }
}
/** 勾选变化时预览未保存状态：POST 同一 menusFor 实现；防抖 250ms，失败静默保留上次。 */
const refreshDraftPreview = useDebounceFn(async () => {
  if (!currentId.value) return;
  if (!permDirty.value) {
    menuPreview.value = savedPreview.value;
    return;
  }
  const id = currentId.value;
  try {
    const result = await RoleAPI.previewMenus([...codes.value]);
    if (currentId.value === id && permDirty.value) menuPreview.value = result.menus;
  } catch {
    /* 静默：保留上一次预览 */
  }
}, 250);
watch(codes, () => refreshDraftPreview());
function openAudit() {
  if (!current.value) return;
  audit.roleId = current.value.id!;
  audit.roleName = current.value.name || "";
  audit.open = true;
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

/* ---- 拖拽排序：dragstart/dragover/drop＋插入位指示线；保存调 reorder，失败回滚本地顺序 ---- */
function resetDrag() {
  dragId.value = "";
  dropId.value = "";
  dropAfter.value = false;
}
function onDragStart(role: RoleItem, event: DragEvent) {
  if (!canDrag.value || !role.id) {
    event.preventDefault();
    return;
  }
  dragId.value = role.id;
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", role.id);
  }
}
function onDragOver(role: RoleItem, event: DragEvent) {
  if (!dragId.value || role.id === dragId.value) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  // 指示线画在目标行的上/下沿：指针过半算「插到它后面」
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  dropId.value = role.id!;
  dropAfter.value = event.clientY > rect.top + rect.height / 2;
}
function onDragLeave(role: RoleItem, event: DragEvent) {
  const next = event.relatedTarget as Node | null;
  const self = event.currentTarget as HTMLElement;
  if (dropId.value === role.id && !(next && self.contains(next))) dropId.value = "";
}
async function onDrop(role: RoleItem, event: DragEvent) {
  event.preventDefault();
  const from = roles.value.findIndex((r) => r.id === dragId.value);
  const target = roles.value.findIndex((r) => r.id === role.id);
  const after = dropAfter.value;
  resetDrag();
  if (from < 0 || target < 0 || from === target) return;
  let to = target + (after ? 1 : 0);
  if (from < to) to -= 1;
  if (to === from) return;
  const next = [...roles.value];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  await saveOrder(next);
}
/** 键盘兜底：把手聚焦后 Alt+↑/↓ 移动一位并保存；移动后焦点跟到那一行的把手。 */
async function moveByKeyboard(role: RoleItem, delta: number) {
  if (!canDrag.value) return;
  const from = roles.value.findIndex((r) => r.id === role.id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= roles.value.length) return;
  const next = [...roles.value];
  [next[from], next[to]] = [next[to], next[from]];
  await saveOrder(next);
  await nextTick();
  document.querySelector<HTMLElement>(`[data-test="role-drag-${role.code}"]`)?.focus();
}
/** 乐观更新 → PUT reorder；成功按服务端权威顺序对齐，失败回滚（错误提示由请求拦截器统一弹）。 */
async function saveOrder(next: RoleItem[]) {
  const prev = roles.value;
  const ids = next.map((r) => r.id!);
  if (ids.join(",") === prev.map((r) => r.id).join(",")) return;
  roles.value = next;
  orderSaving.value = true;
  try {
    const result = await RoleAPI.reorder(ids);
    const byId = new Map(next.map((r) => [r.id, r]));
    roles.value = result.ids.map((id) => byId.get(id)).filter((r): r is RoleItem => Boolean(r));
    ElMessage.success("角色顺序已保存");
  } catch {
    roles.value = prev;
  } finally {
    orderSaving.value = false;
  }
}
async function confirmDiscard(title: string) {
  if (!dirty.value || !(editable.value || canScope.value)) return true;
  try {
    await ElMessageBox.confirm("当前角色的权限/数据范围还没保存，离开后会丢失。", title, {
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
  await syncScopeDraft(roles.value.find((r) => r.id === id));
  savedPreview.value = [];
  menuPreview.value = [];
  await loadSavedPreview(id);
}
/** <900px 顶部下拉选角色：和点列表行同一条 pick 路径（含未保存守卫）。 */
function onSwitch(id: string | number) {
  void pick(String(id));
}
async function save() {
  if (!current.value) return;
  // D3 前端预校验（服务端兜底）：范围不能比自己宽、自定义部门 ⊆ 自己 manage
  if (scopeDirty.value) {
    const problem = scopeProblem(scopeDraft.value, deptDraft.value);
    if (problem) {
      ElMessage.warning(problem);
      return;
    }
  }
  saving.value = true;
  try {
    if (scopeDirty.value) {
      const payload: RoleForm = { dataScope: scopeDraft.value };
      if (scopeDraft.value === 5) payload.deptIds = [...deptDraft.value];
      await RoleAPI.update(current.value.id!, payload);
      originalScope.value = scopeDraft.value;
      originalDeptIds.value = [...deptDraft.value];
      await loadRoles();
    }
    if (permDirty.value) {
      await RoleAPI.savePerms(
        current.value.id!,
        [...codes.value],
        [...passed.value].filter((code) => codes.value.has(code))
      );
      original.value = [...codes.value];
      originalPassed.value = [...passed.value];
    }
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
    ? { ...(await RoleAPI.getFormData(id)), deptIds: [] }
    : {
        name: "",
        code: "",
        dataScope: canScope.value ? 3 : 4,
        deptIds: [],
        // 拖拽排序按 10 步长写 sort：新角色默认＝现有最大 sort＋10，保持「排末尾」
        sort: Math.max(0, ...roles.value.map((r) => Number(r.sort) || 0)) + 10,
        status: 1,
      };
  // 自定义范围（5）：回显已勾选的部门（不再把 5 折成 3）
  if (id && Number(form.data.dataScope) === 5)
    form.data.deptIds = await RoleAPI.getRoleDeptIds(id).catch(() => []);
  form.open = true;
}
async function saveForm() {
  if (!(await formRef.value?.validate().catch(() => false))) return;
  const scope = Number(form.data.dataScope ?? 4);
  const deptIds = form.data.deptIds || [];
  // 系统管理员固定全部数据，不参与 D3 校验
  if (!formIsAdmin.value) {
    const problem = scopeProblem(scope, deptIds);
    if (problem) {
      ElMessage.warning(problem);
      return;
    }
  }
  form.saving = true;
  try {
    const payload: RoleForm = { ...form.data, dataScope: scope };
    // deptIds 只在自定义范围时提交（其他范围提交会被后端拒绝）
    if (scope === 5) payload.deptIds = [...deptIds];
    else delete payload.deptIds;
    const savedId = form.data.id;
    if (savedId) await RoleAPI.update(savedId, payload);
    else await RoleAPI.create(payload);
    ElMessage.success("已保存");
    form.open = false;
    await loadRoles();
    // 弹窗里改了当前角色的范围：主面板草稿同步成已保存的样子
    if (savedId && savedId === currentId.value)
      await syncScopeDraft(roles.value.find((r) => r.id === savedId));
  } finally {
    form.saving = false;
  }
}

onMounted(async () => {
  const result = await RoleAPI.permCatalog();
  catalog.value = result.groups;
  tiers.value = result.tiers || {};
  templates.value = result.templates || [];
  myScope.value = result.myScope ?? (isAdmin.value ? 1 : 4);
  void loadDeptOptions();
  await loadRoles();
});
</script>

<style scoped>
/* 页头下 1px divider（面包屑在布局层，沿用） */
.role-head {
  padding-bottom: 12px;
  border-bottom: 1px solid var(--card-divider);
}

/* <900px 顶部角色下拉 */
.role-switch {
  display: flex;
  gap: 8px;
  align-items: center;
}
.role-switch-label {
  flex: none;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}
.role-switch-select {
  flex: 1;
  max-width: 420px;
}
.opt-name {
  margin-right: 8px;
}
.opt-code {
  margin-right: 8px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  color: var(--el-text-color-placeholder);
}

/* 三栏：左 260 角色卡 / 中 flex 编辑器卡 / 右 300 预览卡（在 perm-layout 里） */
.layout {
  display: flex;
  gap: 16px;
  align-items: flex-start;
}
.roles {
  position: sticky;
  top: 0;
  display: flex;
  flex: 0 0 260px;
  flex-direction: column;
  max-height: calc(100vh - 140px);
  overflow: hidden;
  background: var(--content-bg);
  border: 1px solid var(--card-border);
  border-radius: 6px;
  box-shadow: 0 1px 2px rgb(29 33 41 / 4%);
}
.roles-head {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 12px 12px 8px;
}
.roles-head b {
  font-size: 14px;
}
.roles-count {
  padding: 0 6px;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  line-height: 18px;
  color: var(--el-text-color-secondary);
  background: var(--el-fill-color-light);
  border-radius: 9px;
}
.roles-search {
  padding: 0 12px 8px;
}
.roles ul {
  flex: 1;
  min-height: 0;
  padding: 0 4px 8px;
  margin: 0;
  overflow-y: auto;
  list-style: none;
}
.roles li {
  padding: 8px 10px;
  cursor: pointer;
  border-radius: 4px;
}
.roles li:hover {
  background: var(--el-fill-color-lighter);
}
.roles li.on {
  /* 选中浅蓝底：用暗色感知的.primary tint（--menu-active-bg），暗色不再翻白 */
  background: var(--menu-active-bg);
  box-shadow: inset 2px 0 0 var(--el-color-primary);
}
.roles li.off b {
  color: var(--el-text-color-secondary);
}
/* 拖拽把手：hover/聚焦才显形；指示线画在目标行上/下沿 */
.sort-hint {
  padding: 0 12px;
  margin: 0 0 4px;
  font-size: 12px;
}
.drag-handle {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  padding: 0;
  color: var(--el-text-color-secondary);
  cursor: grab;
  background: none;
  border: none;
  border-radius: 4px;
  opacity: 0;
  transition: opacity 0.15s;
}
.roles li:hover .drag-handle,
.roles li:focus-within .drag-handle,
.drag-handle:focus-visible {
  opacity: 1;
}
.drag-handle:disabled {
  cursor: not-allowed;
}
.roles li.dragging {
  opacity: 0.45;
}
.roles li.drop-before {
  box-shadow: 0 -2px 0 0 var(--el-color-primary);
}
.roles li.drop-after {
  box-shadow: 0 2px 0 0 var(--el-color-primary);
}
.roles li.on.drop-before {
  box-shadow:
    inset 2px 0 0 var(--el-color-primary),
    0 -2px 0 0 var(--el-color-primary);
}
.roles li.on.drop-after {
  box-shadow:
    inset 2px 0 0 var(--el-color-primary),
    0 2px 0 0 var(--el-color-primary);
}
.role-line {
  display: flex;
  gap: 6px;
  align-items: center;
}
.role-line b {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 14px;
  white-space: nowrap;
}
.role-users {
  flex: none;
  margin-left: auto;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: var(--el-text-color-secondary);
}
.role-meta {
  display: flex;
  gap: 6px;
  align-items: center;
  margin-top: 4px;
}
.role-code {
  max-width: 130px;
  padding: 0 6px;
  overflow: hidden;
  text-overflow: ellipsis;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  line-height: 18px;
  color: var(--el-text-color-secondary);
  white-space: nowrap;
  background: var(--el-fill-color-light);
  border-radius: 4px;
}

/* 中栏编辑器卡：overflow 必须 visible，里面的目录/组头/保存栏 sticky 才生效 */
.panel {
  flex: 1;
  min-width: 0;
  padding: 16px;
  overflow: visible;
  background: var(--content-bg);
  border: 1px solid var(--card-border);
  border-radius: 6px;
  box-shadow: 0 1px 2px rgb(29 33 41 / 4%);
}
.panel-head {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 16px;
  align-items: flex-start;
  justify-content: space-between;
  margin-bottom: 12px;
}
.panel-title {
  min-width: 0;
}
.panel-head h3 {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  margin: 0;
  font-size: 16px;
}
.code-tag {
  padding: 0 6px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  font-weight: 400;
  line-height: 20px;
  color: var(--el-text-color-secondary);
  background: var(--el-fill-color-light);
  border-radius: 4px;
}
.panel-head p {
  margin: 4px 0 0;
}
.panel-ops {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
.ops {
  display: flex;
  gap: 8px;
}
.notice {
  margin-bottom: 12px;
}
/* 暗色：EP info alert 的 info-light-9 在项目里仍偏浅（存量），本页用暗色感知变量收回 */
html.dark .role-page :deep(.el-alert--info) {
  --el-alert-bg-color: var(--el-fill-color-light);
}
html.dark .role-page :deep(.el-alert--info .el-alert__title),
html.dark .role-page :deep(.el-alert--info .el-alert__description) {
  color: var(--el-text-color-regular);
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
.scope-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 12px;
  align-items: flex-start;
  margin-bottom: 12px;
}
.scope-label {
  flex: none;
  padding-top: 6px;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}
.scope-picker {
  flex: 1;
  min-width: 260px;
  max-width: 560px;
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

/* 右栏预览 sticky 卡 */
.preview {
  position: sticky;
  top: 0;
  flex: 0 0 300px;
  max-height: calc(100vh - 140px);
  padding: 8px 12px 12px;
  overflow-y: auto;
  background: var(--content-bg);
  border: 1px solid var(--card-border);
  border-radius: 6px;
  box-shadow: 0 1px 2px rgb(29 33 41 / 4%);
}

/* 底部保存栏：sticky 吸底，负边距贴满卡片宽 */
.save-bar {
  position: sticky;
  bottom: 0;
  z-index: 3;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  justify-content: flex-end;
  padding: 12px 16px;
  margin: 12px -16px -16px;
  background: var(--content-bg);
  border-top: 1px solid var(--card-divider);
  border-radius: 0 0 6px 6px;
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

/* 保存确认 / 角色表单（沿用） */
.confirm-scope {
  margin-bottom: 10px;
}
.confirm-scope h5 {
  margin: 10px 0 4px;
  font-size: 13px;
}
.confirm-scope p {
  margin: 0;
  font-size: 13px;
}
.hl {
  color: var(--el-color-primary);
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
.small {
  margin: 4px 0 0;
  font-size: 12px;
}

/* <900px：单栏堆叠，卡片内边距收紧 */
@media (max-width: 899px) {
  .layout {
    flex-direction: column;
  }
  .panel {
    width: 100%;
    padding: 12px;
  }
  .save-bar {
    padding: 12px;
    margin: 12px -12px -12px;
  }
  .scope-picker {
    min-width: 200px;
  }
}
</style>
