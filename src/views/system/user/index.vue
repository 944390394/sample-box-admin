<template>
  <div class="page-container page-flow">
    <PageHeader
      title="人员"
      subtitle="账号由管理员开通。新账号和重置过密码的账号，第一次登录必须先改密码。"
    >
      <template #actions>
        <el-button v-if="can('sys:user:create')" type="primary" :icon="Plus" @click="openForm()">
          新增人员
        </el-button>
      </template>
    </PageHeader>

    <div class="layout">
      <aside class="tree-panel">
        <el-input v-model="treeKeyword" :prefix-icon="Search" placeholder="搜索部门" clearable />
        <button type="button" class="all" :class="{ on: !query.deptId }" @click="pickDept('')">
          全部人员
        </button>
        <el-tree
          ref="treeRef"
          :data="deptTree"
          node-key="value"
          :props="{ label: 'label', children: 'children' }"
          :filter-node-method="
            (value: string, data: Record<string, unknown>) =>
              !value || String(data.label).includes(value)
          "
          :current-node-key="query.deptId || undefined"
          :expand-on-click-node="false"
          default-expand-all
          highlight-current
          @node-click="(data: OptionItem) => pickDept(String(data.value))"
        />
      </aside>

      <el-card shadow="never" class="main">
        <div class="filter-bar">
          <el-input
            v-model="query.keywords"
            :prefix-icon="Search"
            placeholder="姓名、用户名或手机号"
            clearable
            style="width: 280px"
            @keyup.enter="reload"
            @clear="reload"
          >
            <template #append><el-button @click="reload">搜索</el-button></template>
          </el-input>
          <el-select
            v-model="query.status"
            placeholder="账号状态"
            clearable
            style="width: 130px"
            @change="reload"
          >
            <el-option label="正常" value="1" />
            <el-option label="停用" value="0" />
          </el-select>
          <span v-if="deptName" class="text-muted">部门：{{ deptName }}</span>
        </div>

        <el-table v-loading="loading" :data="rows" empty-text="没有符合条件的人员">
          <el-table-column label="姓名" min-width="170">
            <template #default="{ row }">
              <div class="person">
                <span class="avatar" :class="{ off: row.status !== 1 }">
                  {{ String(row.nickname || row.username || "?").slice(0, 1) }}
                </span>
                <div class="person__text">
                  <b>{{ row.nickname }}</b>
                  <div class="text-muted mono">{{ row.username }}</div>
                </div>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="部门" prop="deptName" min-width="130" show-overflow-tooltip />
          <el-table-column label="角色" min-width="180">
            <template #default="{ row }">
              <span v-for="name in rolesOf(row.roleNames)" :key="name" class="role-chip">
                {{ name }}
              </span>
              <span v-if="!rolesOf(row.roleNames).length" class="text-muted">—</span>
            </template>
          </el-table-column>
          <el-table-column label="手机" width="130">
            <template #default="{ row }">{{ row.mobile || "—" }}</template>
          </el-table-column>
          <el-table-column label="账号状态" min-width="170">
            <template #default="{ row }">
              <el-tag v-if="row.status !== 1" type="info" size="small">已停用</el-tag>
              <template v-else>
                <el-tag v-if="row.lockedMinutes" type="danger" size="small" class="tag">
                  已锁定 {{ row.lockedMinutes }} 分钟
                </el-tag>
                <el-tag v-if="row.mustChangePassword" type="warning" size="small" class="tag">
                  待改密
                </el-tag>
                <el-tag v-if="row.passwordExpired" type="warning" size="small" class="tag">
                  密码到期
                </el-tag>
                <el-tag
                  v-if="!row.lockedMinutes && !row.mustChangePassword && !row.passwordExpired"
                  type="success"
                  size="small"
                  class="tag"
                >
                  正常
                </el-tag>
              </template>
              <el-tag v-if="row.wechatBound" size="small" effect="plain" class="tag">
                微信已绑定{{ row.wechatNickname ? `：${row.wechatNickname}` : "" }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="170" fixed="right">
            <template #default="{ row }">
              <div class="ops">
                <el-button v-if="canEdit" link type="primary" @click="openForm(row.id)">
                  编辑
                </el-button>
                <el-button
                  v-if="can('sys:user:view')"
                  link
                  type="primary"
                  :data-test="`eff-${row.username}`"
                  @click="openEffective(row.id)"
                >
                  权限
                </el-button>
                <el-dropdown
                  v-if="moreOf(row).length"
                  trigger="click"
                  @command="(cmd: string) => onMore(cmd, row)"
                >
                  <el-button link>
                    更多
                    <el-icon class="el-icon--right"><ArrowDown /></el-icon>
                  </el-button>
                  <template #dropdown>
                    <el-dropdown-menu>
                      <el-dropdown-item
                        v-for="item in moreOf(row)"
                        :key="item.cmd"
                        :command="item.cmd"
                        :divided="item.danger"
                        :class="{ 'is-danger': item.danger }"
                      >
                        {{ item.label }}
                      </el-dropdown-item>
                    </el-dropdown-menu>
                  </template>
                </el-dropdown>
              </div>
            </template>
          </el-table-column>
        </el-table>
        <DataPager
          v-model:page="query.pageNum"
          v-model:page-size="query.pageSize"
          :total="total"
          :sizes="[20, 50, 100]"
        />
      </el-card>
    </div>

    <el-drawer
      v-model="form.open"
      :title="form.id ? '编辑人员' : '新增人员'"
      size="520px"
      destroy-on-close
    >
      <el-form ref="formRef" :model="form.data" :rules="rules" label-position="top">
        <el-form-item label="用户名（登录用）" prop="username">
          <el-input
            v-model="form.data.username"
            :disabled="Boolean(form.id)"
            maxlength="64"
            placeholder="字母、数字或 _ . @ -，3–64 位"
          />
        </el-form-item>
        <el-form-item label="姓名" prop="nickname">
          <el-input v-model="form.data.nickname" maxlength="64" :disabled="!canProfile" />
        </el-form-item>
        <el-form-item label="部门" prop="deptId">
          <el-tree-select
            v-model="form.data.deptId"
            :data="deptTree"
            check-strictly
            filterable
            :render-after-expand="false"
            style="width: 100%"
            :disabled="!canProfile"
          />
        </el-form-item>
        <el-form-item label="角色">
          <el-select
            v-model="form.data.roleIds"
            multiple
            filterable
            placeholder="选择角色"
            style="width: 100%"
            :disabled="!canAssignRole"
          >
            <el-option
              v-for="role in roleOptions"
              :key="String(role.value)"
              :label="role.label"
              :value="role.value"
              :disabled="role.disabled"
            >
              <span>{{ role.label }}</span>
              <span v-if="role.reason" class="role-reason">{{ role.reason }}</span>
              <span v-else-if="role.cut" class="role-reason cut">
                在这个部门有 {{ role.cut }} 项不生效
              </span>
            </el-option>
          </el-select>
          <p v-if="!canAssignRole" class="text-muted role-tip">
            分配角色要有「给人员分配角色」权限。
          </p>
          <p v-else-if="roleOptions.some((r) => r.disabled)" class="text-muted role-tip">
            灰着的角色里有你不能转授的权限，或数据范围比你的宽，不能分配。
          </p>
          <p v-for="role in cutRoles" :key="role.value" class="role-tip cut-tip">
            「{{ role.label }}」有 {{ role.cut }} 项超出这个部门的权限上限，分配后这几项用不了。
          </p>
        </el-form-item>
        <el-row :gutter="12">
          <el-col :span="12">
            <el-form-item label="手机">
              <el-input v-model="form.data.mobile" maxlength="32" :disabled="!canProfile" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="邮箱">
              <el-input v-model="form.data.email" maxlength="128" :disabled="!canProfile" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-form-item v-if="!form.id" label="初始密码">
          <el-input
            v-model="form.data.password"
            type="password"
            show-password
            autocomplete="new-password"
            :placeholder="`不填就随机生成。${passwordRule}`"
          />
          <p class="text-muted">新账号第一次登录必须修改密码。</p>
        </el-form-item>
        <el-form-item label="状态">
          <el-switch
            v-model="form.data.status"
            :active-value="1"
            :inactive-value="0"
            active-text="正常"
            inactive-text="停用"
            :disabled="statusLocked"
          />
          <p v-if="statusLocked && form.id" class="text-muted role-tip">
            {{
              form.origStatus === 1
                ? "停用账号要有「停用账号」权限。"
                : "启用账号要有「启用账号」权限。"
            }}
          </p>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="form.open = false">取消</el-button>
        <el-button type="primary" :loading="form.saving" @click="save">保存</el-button>
      </template>
    </el-drawer>

    <el-dialog
      v-model="secret.open"
      title="请把初始密码交给本人"
      width="420px"
      style="max-width: 94vw"
      :close-on-click-modal="false"
    >
      <p>
        账号
        <b>{{ secret.username }}</b>
        的密码（只显示这一次）：
      </p>
      <div class="secret">
        <code>{{ secret.password }}</code>
        <el-button size="small" @click="copy(secret.password)">复制</el-button>
      </div>
      <p class="text-muted">对方第一次登录后必须改成自己的密码。</p>
      <template #footer>
        <el-button type="primary" @click="secret.open = false">我已记下</el-button>
      </template>
    </el-dialog>

    <EffectivePermDrawer v-model="effective.open" :user-id="effective.userId" />
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: "User" });

import type { ElTree, FormInstance, FormRules } from "element-plus";
import { ArrowDown, Plus, Search } from "@element-plus/icons-vue";
import type { OptionItem } from "@/api/common";
import DeptAPI from "@/api/system/dept";
import RoleAPI, { type RoleOption } from "@/api/system/role";
import SettingsAPI from "@/api/system/settings";
import UserAPI from "@/api/system/user";
import type { UserForm, UserItem } from "@/api/system/user/types";
import DataPager from "@/components/biz/DataPager.vue";
import PageHeader from "@/components/biz/PageHeader.vue";
import { usePerm } from "@/composables/usePerm";
import { useUrlQuery } from "@/composables/useUrlQuery";
import { useUserStore } from "@/stores/user";
import EffectivePermDrawer from "./EffectivePermDrawer.vue";

/**
 * 人员：左边部门树，右边人员表。账号状态一眼看出锁定、待改密、密码到期。
 * 「更多」里是账号安全操作：重置密码、强制改密、解锁、强制下线、停用、删除，按权限显示。
 */
const can = usePerm();
const me = useUserStore();
const { state: query, sync } = useUrlQuery({
  deptId: "",
  keywords: "",
  status: "",
  pageNum: 1,
  pageSize: 20,
});
const rows = ref<UserItem[]>([]);
const total = ref(0);
const loading = ref(false);
const deptTree = ref<OptionItem[]>([]);
const roleOptions = ref<RoleOption[]>([]);
/** 给人员分配角色单独一项权限；没有时表单里的角色只能看。 */
const canAssignRole = computed(() => can("sys:user:role"));
/** 一个动作一个权限：编辑按钮在能改资料或能分配角色时出现；资料字段要「编辑人员资料」，新建时看「新增人员」。 */
const canEdit = computed(
  () =>
    can("sys:user:update") ||
    can("sys:user:role") ||
    can("sys:user:disable") ||
    can("sys:user:enable")
);
const canProfile = computed(() => (form.id ? can("sys:user:update") : can("sys:user:create")));
const treeKeyword = ref("");
const treeRef = ref<InstanceType<typeof ElTree>>();
const passwordRule = ref("");
watch(treeKeyword, (value) => treeRef.value?.filter(value));

const deptName = computed(() => {
  const find = (nodes: OptionItem[]): string => {
    for (const node of nodes) {
      if (String(node.value) === query.deptId) return String(node.label);
      const hit = node.children ? find(node.children) : "";
      if (hit) return hit;
    }
    return "";
  };
  return query.deptId ? find(deptTree.value) : "";
});

async function load() {
  loading.value = true;
  try {
    const page = await UserAPI.getPage({
      pageNum: query.pageNum,
      pageSize: query.pageSize,
      keywords: query.keywords.trim() || undefined,
      status: query.status === "" ? undefined : Number(query.status),
      deptId: query.deptId || undefined,
    });
    rows.value = page.list;
    total.value = page.total;
  } finally {
    loading.value = false;
  }
}
function reload() {
  query.pageNum = 1;
  sync();
  void load();
}
function pickDept(id: string) {
  query.deptId = id;
  reload();
}
watch(
  () => [query.pageNum, query.pageSize],
  () => {
    sync();
    void load();
  }
);

interface MoreItem {
  cmd: string;
  label: string;
  danger?: boolean;
}
function moreOf(input: Partial<UserItem>): MoreItem[] {
  const row = input as UserItem;
  const list: MoreItem[] = [];
  const self = String(row.id) === String(me.userInfo.userId);
  // 每个动作单独授权
  if (can("sys:user:reset-password")) list.push({ cmd: "reset", label: "重置密码" });
  if (can("sys:user:force-password")) {
    if (!row.mustChangePassword) list.push({ cmd: "force", label: "要求下次登录改密" });
    // 审核、演示等多人共用的账号：免得第一个人登录改了密码，后面的人进不来
    else if ((me.userInfo.roles || []).includes("ADMIN"))
      list.push({ cmd: "skipPassword", label: "免除首次改密" });
  }
  if (can("sys:user:unlock") && row.lockedMinutes) list.push({ cmd: "unlock", label: "解锁" });
  if (can("sys:user:kick") && !self) list.push({ cmd: "kick", label: "强制下线" });
  if (can("sys:user:unbind-wechat") && row.wechatBound)
    list.push({ cmd: "unbindWechat", label: "解绑微信" });
  if (row.status === 1 && can("sys:user:disable") && !self)
    list.push({ cmd: "disable", label: "停用账号" });
  if (row.status !== 1 && can("sys:user:enable")) list.push({ cmd: "enable", label: "启用账号" });
  if (can("sys:user:delete") && !self) list.push({ cmd: "delete", label: "删除", danger: true });
  return list;
}

async function onMore(cmd: string, input: Partial<UserItem>) {
  const row = input as UserItem;
  const name = `${row.nickname}（${row.username}）`;
  const ask = async (text: string, title: string, type: "warning" | "info" = "warning") => {
    try {
      await ElMessageBox.confirm(text, title, {
        type,
        confirmButtonText: "确定",
        cancelButtonText: "取消",
      });
      return true;
    } catch {
      return false;
    }
  };
  if (cmd === "reset") {
    if (
      !(await ask(
        `给 ${name} 生成一个随机密码，对方已有的登录会全部失效，下次登录必须改密。`,
        "重置密码"
      ))
    )
      return;
    const result = await UserAPI.resetPassword(row.id);
    Object.assign(secret, { open: true, username: row.username, password: result.password });
  } else if (cmd === "force") {
    if (!(await ask(`${name} 下次操作时会被要求先修改密码。`, "要求改密", "info"))) return;
    await UserAPI.forcePassword(row.id);
    ElMessage.success("已要求改密");
  } else if (cmd === "skipPassword") {
    if (
      !(await ask(
        `${name} 登录后不再要求修改密码。只给小程序审核、演示这类多人共用的账号用。`,
        "免除首次改密",
        "info"
      ))
    )
      return;
    await UserAPI.skipPassword(row.id);
    ElMessage.success("已免除改密");
  } else if (cmd === "unlock") {
    await UserAPI.unlock(row.id);
    ElMessage.success("已解锁");
  } else if (cmd === "kick") {
    if (
      !(await ask(
        `${name} 所有设备上的登录会立即失效，小程序的微信绑定也会解除，需要重新输账号密码登录。`,
        "强制下线"
      ))
    )
      return;
    await UserAPI.kick(row.id);
    ElMessage.success("已强制下线");
    await load();
  } else if (cmd === "unbindWechat") {
    if (
      !(await ask(
        `解绑后 ${name} 在小程序里要重新输账号密码登录。手机丢失或换人使用时用。`,
        "解绑微信",
        "info"
      ))
    )
      return;
    await UserAPI.unbindWechat(row.id);
    ElMessage.success("已解绑微信");
    await load();
  } else if (cmd === "disable" || cmd === "enable") {
    const status = cmd === "enable" ? 1 : 0;
    if (status === 0 && !(await ask(`停用后 ${name} 不能再登录，已有的登录立即失效。`, "停用账号")))
      return;
    await UserAPI.update(row.id, { ...(await UserAPI.getFormData(row.id)), status });
    ElMessage.success(status ? "已启用" : "已停用");
  } else if (cmd === "delete") {
    if (!(await ask(`删除 ${name}，删除后不能恢复。只是暂时不用的话，建议停用。`, "删除人员")))
      return;
    await UserAPI.deleteByIds(row.id);
    ElMessage.success("已删除");
  }
  await load();
}

const formRef = ref<FormInstance>();
const blank = (): UserForm => ({
  username: "",
  nickname: "",
  deptId: query.deptId || "",
  roleIds: [],
  mobile: "",
  email: "",
  status: 1,
  password: "",
});
const form = reactive({ open: false, saving: false, id: "", origStatus: 1, data: blank() });
/** 停用、启用各一项权限：改状态看原来是什么状态。新建时随便选。 */
const statusLocked = computed(
  () => Boolean(form.id) && !can(form.origStatus === 1 ? "sys:user:disable" : "sys:user:enable")
);
/** 已选的角色里，在所选部门会被权限上限挡住的。 */
const cutRoles = computed(() =>
  roleOptions.value.filter(
    (role) => role.cut && form.data.roleIds?.map(String).includes(String(role.value))
  )
);
/** 换部门时重新取角色选项：带上「在这个部门有几项不生效」。 */
watch(
  () => [form.open, form.data.deptId],
  ([open, deptId]) => {
    if (open)
      RoleAPI.getOptions(String(deptId || ""))
        .then((list) => (roleOptions.value = list))
        .catch(() => {});
  }
);
const effective = reactive({ open: false, userId: "" });
function openEffective(id: string) {
  Object.assign(effective, { open: true, userId: String(id) });
}
const rules: FormRules = {
  username: [{ required: true, message: "请填写用户名", trigger: "blur" }],
  nickname: [{ required: true, message: "请填写姓名", trigger: "blur" }],
  deptId: [{ required: true, message: "请选择部门", trigger: "change" }],
};
async function openForm(id = "") {
  Object.assign(form, { open: true, saving: false, id, origStatus: 1, data: blank() });
  if (id) {
    form.data = { ...blank(), ...(await UserAPI.getFormData(id)) };
    form.origStatus = Number(form.data.status ?? 1);
  }
}
async function save() {
  if (!(await formRef.value?.validate().catch(() => false))) return;
  form.saving = true;
  try {
    if (form.id) {
      await UserAPI.update(form.id, form.data);
      ElMessage.success("已保存");
    } else {
      const result = await UserAPI.create(form.data);
      if (result?.password)
        Object.assign(secret, { open: true, username: result.username, password: result.password });
      else ElMessage.success("已新增，对方第一次登录需要改密");
    }
    form.open = false;
    await load();
  } finally {
    form.saving = false;
  }
}

const secret = reactive({ open: false, username: "", password: "" });
async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    ElMessage.success("已复制");
  } catch {
    ElMessage.warning("复制失败，请手动选择");
  }
}

onMounted(async () => {
  void load();
  const [depts, roles, rule] = await Promise.allSettled([
    DeptAPI.getOptions(),
    RoleAPI.getOptions(),
    SettingsAPI.securityRule(),
  ]);
  if (depts.status === "fulfilled") deptTree.value = depts.value;
  if (roles.status === "fulfilled") roleOptions.value = roles.value;
  if (rule.status === "fulfilled") passwordRule.value = `规则：${rule.value.rule}`;
});

/** 角色名接口给的是「系统管理员,视角切换」这样一串，拆开逐个显示。 */
function rolesOf(names?: string) {
  return String(names || "")
    .split(/[,，、]/)
    .map((n) => n.trim())
    .filter(Boolean);
}
</script>

<style scoped>
.person {
  display: flex;
  gap: 10px;
  align-items: center;
}
.person__text {
  min-width: 0;
}
.avatar {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  font-size: 13px;
  font-weight: 600;
  color: var(--el-color-primary);
  background: var(--el-color-primary-light-9);
  border-radius: 50%;
}
.avatar.off {
  color: var(--el-text-color-placeholder);
  background: var(--el-fill-color-light);
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
}
.role-chip {
  display: inline-block;
  padding: 0 7px;
  margin: 2px 4px 2px 0;
  font-size: 12px;
  line-height: 20px;
  color: var(--el-text-color-regular);
  background: var(--el-fill-color-light);
  border-radius: 4px;
}
.layout {
  display: flex;
  gap: 12px;
  align-items: flex-start;
}
.tree-panel {
  position: sticky;
  top: 0;
  display: flex;
  flex: 0 0 240px;
  flex-direction: column;
  gap: 8px;
  max-height: calc(100vh - 160px);
  padding: 12px;
  overflow: auto;
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
}
.all {
  padding: 6px 8px;
  font: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
  background: none;
  border: 0;
  border-radius: 4px;
}
.all.on {
  color: var(--el-color-primary);
  background: var(--el-color-primary-light-9);
}
.main {
  flex: 1;
  min-width: 0;
}
.filter-bar {
  margin-bottom: 12px;
}
.ops {
  display: flex;
  gap: 4px;
  align-items: center;
}
.tag {
  margin: 0 4px 4px 0;
}
.secret {
  display: flex;
  gap: 10px;
  align-items: center;
  padding: 10px 12px;
  background: var(--el-fill-color-light);
  border-radius: 6px;
}
.secret code {
  flex: 1;
  font-size: 18px;
  letter-spacing: 1px;
}
:deep(.is-danger) {
  color: var(--el-color-danger);
}
@media (max-width: 900px) {
  .layout {
    flex-direction: column;
  }
  .tree-panel {
    position: static;
    flex: none;
    width: 100%;
    max-height: 260px;
  }
}
.role-reason {
  float: right;
  margin-left: 12px;
  font-size: 12px;
  color: var(--el-text-color-placeholder);
}
.role-tip {
  margin: 4px 0 0;
  font-size: 12px;
}
.role-reason.cut,
.cut-tip {
  color: var(--el-color-warning-dark-2);
}
</style>
