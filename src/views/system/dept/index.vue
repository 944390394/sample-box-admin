<template>
  <div class="page-container dept-page">
    <PageHeader
      title="部门"
      subtitle="公司、分公司和采样机构（检测站）的层级。部门地址会带进任务单的寄出、接收和采样地点。"
    >
      <template #actions>
        <el-button
          v-hasPerm="['sys:dept:create']"
          type="primary"
          :icon="Plus"
          @click="openDialog('0')"
        >
          新增部门
        </el-button>
      </template>
    </PageHeader>
    <div class="dept-body">
      <el-card shadow="never" class="tree-card">
        <div class="tree-head">
          <el-input
            v-model="keyword"
            placeholder="搜索部门名称或编号"
            clearable
            :prefix-icon="Search"
          />
        </div>
        <div class="tree-tools">
          <el-radio-group v-model="statusFilter" size="small">
            <el-radio-button value="all">全部</el-radio-button>
            <el-radio-button :value="CommonStatus.ENABLED">正常</el-radio-button>
            <el-radio-button :value="CommonStatus.DISABLED">禁用</el-radio-button>
          </el-radio-group>
          <span class="muted">共 {{ deptIndex.size }} 个</span>
          <el-tooltip content="刷新" placement="top">
            <el-button link :icon="Refresh" @click="fetchData" />
          </el-tooltip>
        </div>
        <div ref="treeBox" v-loading="loading" class="tree-box">
          <el-tree-v2
            v-if="list.length"
            ref="treeRef"
            :data="list"
            :props="treeProps"
            :height="treeHeight"
            :item-size="34"
            :filter-method="filterNode"
            :default-expanded-keys="expandedKeys"
            :expand-on-click-node="false"
            highlight-current
            @node-click="onNodeClick"
          >
            <template #default="{ data }">
              <span class="node" :class="{ off: data.status !== CommonStatus.ENABLED }">
                <span class="node-name" :title="data.name">{{ data.name }}</span>
                <el-tag
                  v-if="data.type === '采样机构'"
                  size="small"
                  type="success"
                  effect="plain"
                  class="node-type"
                >
                  机构
                </el-tag>
                <el-icon v-if="data.lng != null" class="node-pin"><Location /></el-icon>
                <span v-if="data.children?.length" class="node-count">
                  {{ data.children.length }}
                </span>
              </span>
            </template>
          </el-tree-v2>
          <el-empty v-else-if="!loading" description="还没有部门" :image-size="64" />
        </div>
      </el-card>

      <el-card shadow="never" class="detail-card">
        <el-empty v-if="!selected" description="在左侧选择一个部门" />
        <template v-else>
          <div class="detail-head">
            <div class="title">
              <div class="crumb">{{ pathOf(selected.id) }}</div>
              <h3>
                {{ selected.name }}
                <el-tag size="small" type="info">{{ selected.code }}</el-tag>
                <el-tag
                  size="small"
                  :type="selected.type === '采样机构' ? 'success' : 'primary'"
                  effect="plain"
                >
                  {{ selected.type || "公司" }}
                </el-tag>
                <el-tag v-if="selected.status === CommonStatus.ENABLED" size="small" type="success">
                  正常
                </el-tag>
                <el-tag v-else size="small" type="info">禁用</el-tag>
              </h3>
            </div>
            <div class="ops">
              <el-button
                v-hasPerm="['sys:dept:create']"
                :icon="Plus"
                @click="openDialog(selected.id)"
              >
                新增下级
              </el-button>
              <el-button
                v-if="canEditAny"
                type="primary"
                :icon="Edit"
                @click="openDialog(selected.parentId, selected.id)"
              >
                编辑
              </el-button>
              <el-button
                v-hasPerm="['sys:dept:delete']"
                type="danger"
                plain
                :icon="Delete"
                @click="handleDelete(selected.id)"
              >
                删除
              </el-button>
            </div>
          </div>

          <div class="facts">
            <div class="fact">
              <span class="fact__label">负责人</span>
              <span v-if="selected.leaderName">
                {{ selected.leaderName }}
                <span class="muted">{{ selected.leaderMobile }}</span>
              </span>
              <span v-else class="muted">未设置</span>
            </div>
            <div class="fact">
              <span class="fact__label">联系人</span>
              <span v-if="selected.contact || selected.phone">
                {{ selected.contact }}
                <span class="muted">{{ selected.phone }}</span>
              </span>
              <span v-else class="muted">未设置</span>
            </div>
            <div class="fact">
              <span class="fact__label">下级部门</span>
              <span>{{ children.length }} 个直属，共 {{ descendantCount }} 个</span>
            </div>
            <div class="fact">
              <span class="fact__label">排序</span>
              <span>{{ selected.sort }}</span>
            </div>
            <div class="fact fact--wide">
              <span class="fact__label">地址</span>
              <span v-if="selected.address || selected.lng != null">
                {{ selected.address || "已定位，未填地址文字" }}
                <el-tag v-if="selected.lng == null" type="warning" size="small">无坐标</el-tag>
              </span>
              <span v-else-if="inheritedFrom(selected.id)" class="muted">
                未设置，沿用「{{ inheritedFrom(selected.id)!.name }}」：{{
                  inheritedFrom(selected.id)!.address || "已定位"
                }}
              </span>
              <span v-else class="muted">未设置，任务里需要手动填写地址</span>
            </div>
          </div>

          <el-tabs v-model="tab" class="tabs">
            <el-tab-pane :label="`下级部门（${children.length}）`" name="children">
              <div v-if="children.length" class="tab-tools">
                <el-button
                  v-hasPerm="['sys:dept:delete']"
                  type="danger"
                  plain
                  size="small"
                  :disabled="!hasSelection"
                  @click="handleDelete()"
                >
                  删除选中
                </el-button>
              </div>
              <el-table
                :data="children"
                row-key="id"
                empty-text="没有下级部门"
                @selection-change="handleSelectionChange"
              >
                <el-table-column type="selection" width="44" />
                <!-- 编号放在名称下面：右侧详情区窄，列多了「状态」会被固定的操作列盖住 -->
                <el-table-column label="部门名称 · 编号" min-width="150">
                  <template #default="{ row }">
                    <el-link type="primary" @click="select(String(row.id))">{{ row.name }}</el-link>
                    <div class="muted">{{ row.code || "—" }}</div>
                  </template>
                </el-table-column>
                <el-table-column label="地址" min-width="150" show-overflow-tooltip>
                  <template #default="{ row }">
                    <span v-if="row.address || row.lng != null">{{ row.address || "已定位" }}</span>
                    <span v-else class="muted">
                      {{ inheritedFrom(row.id) ? `沿用 ${inheritedFrom(row.id)!.name}` : "未设置" }}
                    </span>
                  </template>
                </el-table-column>
                <el-table-column label="负责人" width="90">
                  <template #default="{ row }">{{ row.leaderName || "—" }}</template>
                </el-table-column>
                <el-table-column label="下级" width="56">
                  <template #default="{ row }">{{ row.children?.length || 0 }}</template>
                </el-table-column>
                <el-table-column label="状态" width="70">
                  <template #default="{ row }">
                    <el-tag v-if="row.status === CommonStatus.ENABLED" type="success" size="small">
                      正常
                    </el-tag>
                    <el-tag v-else type="info" size="small">禁用</el-tag>
                  </template>
                </el-table-column>
                <el-table-column label="操作" width="110" fixed="right">
                  <template #default="{ row }">
                    <el-button
                      v-if="canEditAny"
                      link
                      type="primary"
                      size="small"
                      @click="openDialog(row.parentId, row.id)"
                    >
                      编辑
                    </el-button>
                    <el-button
                      v-hasPerm="['sys:dept:delete']"
                      link
                      type="danger"
                      size="small"
                      @click="handleDelete(row.id)"
                    >
                      删除
                    </el-button>
                  </template>
                </el-table-column>
              </el-table>
            </el-tab-pane>
            <el-tab-pane :label="`人员（${members.total}）`" name="members">
              <div class="tab-tools">
                <span class="muted">含下级部门的人员</span>
                <el-button
                  link
                  type="primary"
                  size="small"
                  @click="router.push({ path: '/system/user', query: { deptId: selected.id } })"
                >
                  去人员管理
                </el-button>
              </div>
              <el-table
                v-loading="members.loading"
                :data="members.list"
                empty-text="这个部门还没有人员"
              >
                <el-table-column label="姓名" min-width="110">
                  <template #default="{ row }">
                    {{ row.nickname }}
                    <el-tag v-if="row.id === selected.leaderUserId" size="small" type="warning">
                      负责人
                    </el-tag>
                  </template>
                </el-table-column>
                <el-table-column prop="username" label="用户名" min-width="110" />
                <el-table-column prop="deptName" label="部门" min-width="120" />
                <el-table-column prop="mobile" label="手机" min-width="120" />
                <el-table-column
                  prop="roleNames"
                  label="角色"
                  min-width="140"
                  show-overflow-tooltip
                />
                <el-table-column label="状态" width="80">
                  <template #default="{ row }">
                    <el-tag v-if="row.status === 1" type="success" size="small">正常</el-tag>
                    <el-tag v-else type="info" size="small">停用</el-tag>
                  </template>
                </el-table-column>
              </el-table>
              <el-pagination
                v-if="members.total > members.pageSize"
                v-model:current-page="members.page"
                class="pager"
                :page-size="members.pageSize"
                :total="members.total"
                layout="total, prev, pager, next"
                @current-change="loadMembers"
              />
            </el-tab-pane>
            <!-- 权限上限：只封顶不授权，下级只能在上级范围里勾 -->
            <el-tab-pane
              v-if="can('sys:dept:limit') || can('sys:dept:view')"
              label="权限上限"
              name="limit"
              lazy
            >
              <DeptLimitPanel :dept-id="String(selected.id)" />
            </el-tab-pane>
          </el-tabs>
        </template>
      </el-card>
    </div>

    <el-drawer
      v-model="dialogState.visible"
      :title="dialogState.title"
      size="720px"
      class="dept-drawer"
      @closed="closeDialog"
    >
      <el-form
        ref="deptFormRef"
        :model="formData"
        :rules="rules"
        label-width="86px"
        label-position="right"
      >
        <section class="block">
          <h4>基本信息</h4>
          <el-row :gutter="16">
            <el-col :span="24">
              <el-form-item label="上级部门" prop="parentId">
                <el-tree-select
                  v-model="formData.parentId"
                  :disabled="basicLocked"
                  placeholder="选择上级部门"
                  :data="deptOptions"
                  filterable
                  check-strictly
                  :render-after-expand="false"
                  style="width: 100%"
                />
              </el-form-item>
            </el-col>
            <el-col :span="12" :xs="24">
              <el-form-item label="部门名称" prop="name">
                <el-input
                  v-model="formData.name"
                  maxlength="64"
                  placeholder="如：采样机构丙"
                  :disabled="basicLocked"
                />
              </el-form-item>
            </el-col>
            <el-col :span="12" :xs="24">
              <el-form-item label="部门编号" prop="code">
                <el-input
                  v-model="formData.code"
                  maxlength="64"
                  placeholder="唯一编号"
                  :disabled="autoCode || basicLocked"
                >
                  <template #append>
                    <el-checkbox v-model="autoCode" class="auto-code" :disabled="basicLocked">
                      自动
                    </el-checkbox>
                  </template>
                </el-input>
                <p class="tip">
                  {{
                    autoCode
                      ? "上级编号 + 名称拼音首字母 + 序号，如 CS_CW_01"
                      : "自己填写，不能和已有部门重复"
                  }}
                </p>
              </el-form-item>
            </el-col>
            <el-col :span="12" :xs="24">
              <el-form-item label="类型">
                <el-radio-group v-model="formData.type" :disabled="!can('sys:dept:type')">
                  <el-radio-button value="公司">公司</el-radio-button>
                  <el-radio-button value="采样机构">采样机构（检测站）</el-radio-button>
                </el-radio-group>
                <p class="tip">
                  采样机构就是检测站：送到这里的任务签收后要逐台扫码「开始检测」，总览里单列；做采样单位时可以要求开箱录像
                </p>
              </el-form-item>
            </el-col>
            <el-col v-if="formData.type === '采样机构'" :span="24">
              <el-form-item label="监控通道">
                <CameraEditor v-if="can('sys:dept:camera')" v-model="formData.cameras" />
                <p v-else class="tip">
                  已配置
                  {{ formData.cameras?.length || 0 }} 路。没有「配置监控通道」权限，不能修改。
                </p>
              </el-form-item>
            </el-col>
            <el-col :span="12" :xs="24">
              <el-form-item label="显示排序" prop="sort">
                <el-input-number
                  v-model="formData.sort"
                  controls-position="right"
                  :min="0"
                  style="width: 100%"
                  :disabled="basicLocked"
                />
              </el-form-item>
            </el-col>
            <el-col :span="12" :xs="24">
              <el-form-item label="状态">
                <el-radio-group v-model="formData.status" :disabled="basicLocked">
                  <el-radio :value="CommonStatus.ENABLED">正常</el-radio>
                  <el-radio :value="CommonStatus.DISABLED">禁用</el-radio>
                </el-radio-group>
              </el-form-item>
            </el-col>
          </el-row>
        </section>

        <section class="block">
          <h4>负责人</h4>
          <el-form-item label="设置方式">
            <el-radio-group v-model="leader.mode" :disabled="!can('sys:dept:leader')">
              <el-radio-button value="none">暂不设置</el-radio-button>
              <el-radio-button value="pick">选择已有用户</el-radio-button>
              <el-radio-button v-if="can('sys:user:create')" value="create">
                新建账号
              </el-radio-button>
            </el-radio-group>
            <p v-if="!can('sys:dept:leader')" class="tip">
              没有「指定部门负责人」权限，不能修改负责人。
            </p>
          </el-form-item>
          <el-form-item v-if="leader.mode === 'pick'" label="负责人">
            <el-select
              v-model="leader.userId"
              filterable
              remote
              :remote-method="searchUsers"
              :loading="leader.searching"
              :disabled="!can('sys:dept:leader')"
              placeholder="输入姓名、用户名或手机号搜索"
              style="width: 100%"
              @change="onPickLeader"
            >
              <el-option
                v-for="u in leader.options"
                :key="u.id"
                :value="u.id"
                :label="u.nickname || u.username || u.id"
              >
                <span>{{ u.nickname }}</span>
                <span class="option-meta">
                  {{ u.deptName || "—" }} · {{ u.mobile || u.username }}
                </span>
              </el-option>
            </el-select>
          </el-form-item>
          <template v-if="leader.mode === 'create'">
            <el-row :gutter="16">
              <el-col :span="12" :xs="24">
                <el-form-item label="姓名" required>
                  <el-input v-model="leader.create.nickname" maxlength="64" @input="syncContact" />
                </el-form-item>
              </el-col>
              <el-col :span="12" :xs="24">
                <el-form-item label="用户名" required>
                  <el-input
                    v-model="leader.create.username"
                    maxlength="64"
                    placeholder="登录用，3 位以上字母数字"
                  />
                </el-form-item>
              </el-col>
              <el-col :span="12" :xs="24">
                <el-form-item label="手机">
                  <el-input v-model="leader.create.mobile" maxlength="32" @input="syncContact" />
                </el-form-item>
              </el-col>
              <el-col v-if="can('sys:user:role')" :span="12" :xs="24">
                <el-form-item label="角色">
                  <el-select
                    v-model="leader.create.roleIds"
                    multiple
                    placeholder="选择角色"
                    style="width: 100%"
                  >
                    <el-option
                      v-for="r in roleOptions"
                      :key="r.value"
                      :value="String(r.value)"
                      :label="r.label"
                      :disabled="r.disabled"
                    >
                      <span>{{ r.label }}</span>
                      <span v-if="r.disabled" class="option-meta">{{ r.reason }}</span>
                    </el-option>
                  </el-select>
                </el-form-item>
              </el-col>
            </el-row>
            <el-form-item label="初始密码">
              <div class="password">
                <el-radio-group v-model="leader.passwordMode">
                  <el-radio value="random">随机生成</el-radio>
                  <el-radio value="manual">自己填写</el-radio>
                </el-radio-group>
                <el-input
                  v-if="leader.passwordMode === 'manual'"
                  v-model="leader.create.password"
                  type="password"
                  show-password
                  autocomplete="new-password"
                  maxlength="128"
                  placeholder="8 位以上"
                />
              </div>
              <p class="tip">
                账号建在本部门下。{{
                  leader.passwordMode === "random"
                    ? "保存后显示一次随机密码，请复制交给负责人。"
                    : "请把密码告诉负责人，登录后可在个人中心修改。"
                }}
              </p>
            </el-form-item>
          </template>
          <el-row :gutter="16">
            <el-col :span="12" :xs="24">
              <el-form-item label="联系人">
                <el-input
                  v-model="formData.contact"
                  maxlength="64"
                  placeholder="收发联系人，默认负责人"
                  :disabled="!can('sys:dept:address')"
                />
              </el-form-item>
            </el-col>
            <el-col :span="12" :xs="24">
              <el-form-item label="联系电话">
                <el-input
                  v-model="formData.phone"
                  maxlength="32"
                  :disabled="!can('sys:dept:address')"
                />
              </el-form-item>
            </el-col>
          </el-row>
        </section>

        <section class="block">
          <h4>地址与位置</h4>
          <p class="tip">调拨和采样任务会按这里自动带出寄出、收货地址，并计算箱子离目的地多远。</p>
          <div class="address-card">
            <el-icon class="pin"><Location /></el-icon>
            <div class="address-text">
              <template v-if="place">
                <div>{{ place.address || "已定位，未填地址文字" }}</div>
                <div class="tip">
                  {{
                    place.lng != null
                      ? `坐标 ${place.lng.toFixed(5)}, ${place.lat!.toFixed(5)}`
                      : "没有坐标，不能自动计算距离"
                  }}
                </div>
              </template>
              <template v-else-if="parentLocation">
                <div class="muted">未设置，沿用「{{ parentLocation.name }}」的地址</div>
                <div class="tip">{{ parentLocation.address || "已定位" }}</div>
              </template>
              <div v-else class="muted">未设置，任务里需要手动填写地址</div>
            </div>
            <el-button v-if="can('sys:dept:address')" @click="mapOpen = !mapOpen">
              {{ mapOpen ? "收起地图" : place ? "修改位置" : "地图选点" }}
            </el-button>
            <span v-else class="tip">没有「设置部门地址和联系人」权限</span>
          </div>
          <LocationPicker v-if="dialogState.visible && mapOpen" v-model="place" class="picker" />
        </section>
      </el-form>

      <template #footer>
        <el-button @click="closeDialog">取消</el-button>
        <el-button type="primary" :loading="saving" @click="handleSubmit">保存</el-button>
      </template>
    </el-drawer>

    <el-dialog
      v-model="account.open"
      title="负责人账号已创建"
      width="440px"
      :close-on-click-modal="false"
    >
      <el-descriptions :column="1" border>
        <el-descriptions-item label="姓名">{{ account.nickname }}</el-descriptions-item>
        <el-descriptions-item label="用户名">{{ account.username }}</el-descriptions-item>
        <el-descriptions-item v-if="account.password" label="初始密码">
          <code class="secret">{{ account.password }}</code>
        </el-descriptions-item>
      </el-descriptions>
      <el-alert
        v-if="account.password"
        type="warning"
        :closable="false"
        class="secret-tip"
        title="随机密码只显示这一次，关闭后无法再查看，忘了只能在用户管理里重置。"
      />
      <template #footer>
        <el-button v-if="account.password" @click="copyAccount">复制账号和密码</el-button>
        <el-button type="primary" @click="account.open = false">我已记下</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import {
  ElMessage,
  ElMessageBox,
  type FormInstance,
  type FormRules,
  type TreeV2Instance,
} from "element-plus";
import { Delete, Edit, Plus, Refresh, Search } from "@element-plus/icons-vue";

import DeptAPI from "@/api/system/dept";
import type { DeptForm, DeptItem } from "@/api/system/dept";
import type { OptionItem } from "@/api/common";
import { useTableSelection } from "@/composables";
import { CommonStatus } from "@/enums";
import PageHeader from "@/components/biz/PageHeader.vue";
import LocationPicker, { type PickedPlace } from "@/components/LocationPicker/index.vue";
import { Location } from "@element-plus/icons-vue";
import UserAPI, { type UserItem } from "@/api/system/user";
import RoleAPI from "@/api/system/role";
import { pinyin } from "pinyin-pro";
import CameraEditor from "./CameraEditor.vue";
import DeptLimitPanel from "./DeptLimitPanel.vue";
import { usePerm } from "@/composables/usePerm";
import type { RoleOption } from "@/api/system/role";

defineOptions({
  name: "Dept",
  inheritAttrs: false,
});

const router = useRouter();
const deptFormRef = ref<FormInstance>();
const can = usePerm();
/** 编辑部门拆成五项：名称和上级、类型、地址和联系人、监控通道、负责人，有任意一项就能打开编辑。 */
const canEditAny = computed(() =>
  [
    "sys:dept:update",
    "sys:dept:type",
    "sys:dept:address",
    "sys:dept:camera",
    "sys:dept:leader",
  ].some((code) => can(code))
);
/** 编辑已有部门时，名称、编号、上级、排序、状态要「编辑部门基本信息」；新建看「新增部门」。 */
const basicLocked = computed(() => Boolean(formData.id) && !can("sys:dept:update"));

const loading = ref(false);
const list = ref<DeptItem[]>([]);

/* 左侧部门树：虚拟滚动，几千个部门也不卡；搜索和状态筛选都在前端做 */
const treeRef = ref<TreeV2Instance>();
const treeBox = ref<HTMLElement | null>(null);
const { height: treeBoxHeight } = useElementSize(treeBox);
const treeHeight = computed(() => Math.max(200, Math.floor(treeBoxHeight.value)));
const treeProps = { value: "id", label: "name", children: "children" };
const keyword = ref("");
const statusFilter = ref<"all" | number>("all");
const selectedId = ref("");
const tab = ref("children");
/** 顶级部门默认展开，下面的按需展开。 */
const expandedKeys = computed(() => list.value.map((node) => String(node.id)));

function filterNode(_query: string, node: unknown) {
  const dept = node as DeptItem;
  const text = keyword.value.trim().toLowerCase();
  const textOk = !text || `${dept.name}${dept.code}`.toLowerCase().includes(text);
  const statusOk = statusFilter.value === "all" || dept.status === statusFilter.value;
  return textOk && statusOk;
}
watch([keyword, statusFilter], () => treeRef.value?.filter(keyword.value || " "));

const selected = computed(() =>
  selectedId.value ? deptIndex.value.get(selectedId.value) || null : null
);
const children = computed(() => selected.value?.children || []);
const descendantCount = computed(() => {
  let n = 0;
  const walk = (nodes: DeptItem[]) =>
    nodes.forEach((node) => {
      n += 1;
      walk(node.children || []);
    });
  walk(children.value);
  return n;
});

/** 「总公司 / 华南分公司 / 调度室」这样的路径。 */
function pathOf(id?: string) {
  const names: string[] = [];
  const seen = new Set<string>();
  let cursor = id ? deptIndex.value.get(String(id)) : undefined;
  while (cursor && !seen.has(String(cursor.id))) {
    seen.add(String(cursor.id));
    names.unshift(cursor.name || "");
    cursor = cursor.parentId ? deptIndex.value.get(String(cursor.parentId)) : undefined;
  }
  return names.join(" / ");
}

function onNodeClick(data: unknown) {
  select(String((data as DeptItem).id));
}

/** 选中部门：同步树的高亮并展开到它，人员列表从第一页重新取。 */
function select(id: string) {
  selectedId.value = id;
  const ids: string[] = [];
  let cursor = deptIndex.value.get(id);
  while (cursor?.parentId && deptIndex.value.has(String(cursor.parentId))) {
    ids.push(String(cursor.parentId));
    cursor = deptIndex.value.get(String(cursor.parentId));
  }
  nextTick(() => {
    if (ids.length) treeRef.value?.setExpandedKeys([...new Set([...expandedKeys.value, ...ids])]);
    treeRef.value?.setCurrentKey(id);
    treeRef.value?.scrollToNode(id);
  });
  members.page = 1;
  void loadMembers();
}

const members = reactive({
  list: [] as UserItem[],
  total: 0,
  page: 1,
  pageSize: 20,
  loading: false,
});
let membersSeq = 0;
async function loadMembers() {
  if (!selectedId.value) return;
  const seq = ++membersSeq;
  members.loading = true;
  try {
    const page = await UserAPI.getPage({
      pageNum: members.page,
      pageSize: members.pageSize,
      deptId: selectedId.value,
    });
    if (seq !== membersSeq) return;
    members.list = page.list;
    members.total = page.total;
  } finally {
    if (seq === membersSeq) members.loading = false;
  }
}

const { selectedIds, hasSelection, handleSelectionChange } = useTableSelection<DeptItem>();

const dialogState = reactive({
  title: "",
  visible: false,
});

const deptOptions = ref<OptionItem[]>([]);

const initialFormData: DeptForm = {
  status: CommonStatus.ENABLED,
  type: "公司",
  parentId: "0",
  sort: 1,
};

const formData = reactive<DeptForm>({ ...initialFormData });

/** 地图选点组件和表单里的三个字段互相转换。 */
const place = computed<PickedPlace | null>({
  get: () =>
    formData.address || formData.lng != null
      ? { address: formData.address || "", lng: formData.lng ?? null, lat: formData.lat ?? null }
      : null,
  set: (value) => {
    formData.address = value?.address || "";
    formData.lng = value?.lng ?? null;
    formData.lat = value?.lat ?? null;
  },
});

/** 整棵树按编号索引，用来找上级的地址。 */
const deptIndex = computed(() => {
  const map = new Map<string, DeptItem>();
  const walk = (nodes: DeptItem[]) =>
    nodes.forEach((node) => {
      if (node.id) map.set(String(node.id), node);
      walk(node.children || []);
    });
  walk(list.value);
  return map;
});

function locatedAncestor(parentId?: string) {
  const seen = new Set<string>();
  let cursor = parentId ? deptIndex.value.get(String(parentId)) : undefined;
  while (cursor && !seen.has(String(cursor.id))) {
    seen.add(String(cursor.id));
    if (cursor.address || cursor.lng != null) return cursor;
    cursor = cursor.parentId ? deptIndex.value.get(String(cursor.parentId)) : undefined;
  }
  return null;
}

/** 列表里没设地址的部门沿用哪个上级。 */
function inheritedFrom(id?: string) {
  const self = id ? deptIndex.value.get(String(id)) : undefined;
  return self ? locatedAncestor(self.parentId) : null;
}

const parentLocation = computed(() => locatedAncestor(formData.parentId));

const saving = ref(false);
const mapOpen = ref(false);
const roleOptions = ref<RoleOption[]>([]);
const leader = reactive({
  mode: "none" as "none" | "pick" | "create",
  userId: "",
  options: [] as UserItem[],
  searching: false,
  passwordMode: "random" as "random" | "manual",
  create: { nickname: "", username: "", mobile: "", roleIds: [] as string[], password: "" },
});
/** 联系人是不是跟着负责人自动填的；手改过就不再覆盖。 */
let contactAuto = true;
const account = reactive({ open: false, nickname: "", username: "", password: "" });

function resetLeader() {
  Object.assign(leader, {
    mode: "none",
    userId: "",
    options: [],
    searching: false,
    passwordMode: "random",
  });
  Object.assign(leader.create, {
    nickname: "",
    username: "",
    mobile: "",
    roleIds: [],
    password: "",
  });
}

function fillContact(name?: string, mobile?: string) {
  if (!contactAuto && (formData.contact || formData.phone)) return;
  formData.contact = name || "";
  formData.phone = mobile || "";
  contactAuto = true;
}
function syncContact() {
  fillContact(leader.create.nickname, leader.create.mobile);
}
function onPickLeader(id: string) {
  const user = leader.options.find((u) => u.id === id);
  fillContact(user?.nickname, user?.mobile);
}
watch(
  () => [formData.contact, formData.phone],
  ([contact, phone]) => {
    const auto =
      leader.mode === "create"
        ? contact === leader.create.nickname && phone === leader.create.mobile
        : leader.options.some(
            (u) => u.id === leader.userId && u.nickname === contact && (u.mobile || "") === phone
          );
    if (!auto && (contact || phone)) contactAuto = false;
  }
);

async function searchUsers(keywords = "") {
  leader.searching = true;
  try {
    const page = await UserAPI.getPage({ pageNum: 1, pageSize: 20, keywords, status: 1 });
    // 保留当前选中的，避免搜索后名字消失
    const current = leader.options.find((u) => u.id === leader.userId);
    leader.options =
      current && !page.list.some((u) => u.id === current.id) ? [current, ...page.list] : page.list;
  } finally {
    leader.searching = false;
  }
}

/** 新建负责人时按上级类型给角色建议：合作机构下是机构负责人，其余是分公司管理员。 */
function suggestRoles() {
  if (leader.create.roleIds.length) return;
  const names: string[] = [];
  let cursor = formData.parentId ? deptIndex.value.get(String(formData.parentId)) : undefined;
  while (cursor && names.length < 10) {
    names.push(cursor.name || "");
    cursor = cursor.parentId ? deptIndex.value.get(String(cursor.parentId)) : undefined;
  }
  const wanted = names.some((name) => name.includes("机构")) ? "机构负责人" : "分公司管理员";
  const role = roleOptions.value.find((r) => r.label === wanted);
  if (role) leader.create.roleIds = [String(role.value)];
}
watch(
  () => leader.mode,
  (mode) => {
    if (mode === "create") {
      suggestRoles();
      syncContact();
    } else if (mode === "pick" && !leader.options.length) void searchUsers();
  }
);

/**
 * 部门编号自动生成：顶级 = 名称拼音首字母（如「测试」→ CS）；
 * 下级 = 上级编号 + 名称首字母 + 两位序号（如「财务」→ CS_CW_01），重名时序号往后加。
 * 大小写跟随上级编号。关掉「自动」就可以自己填。
 */
const autoCode = ref(true);
function initials(name: string) {
  return pinyin(name, { pattern: "first", toneType: "none", type: "array", nonZh: "consecutive" })
    .join("")
    .replace(/[^A-Za-z0-9]/g, "")
    .slice(0, 8);
}
function buildCode() {
  const parent =
    formData.parentId && formData.parentId !== "0"
      ? deptIndex.value.get(String(formData.parentId))
      : undefined;
  const parentCode = parent?.code || "";
  const lower = Boolean(parentCode) && parentCode === parentCode.toLowerCase();
  const abbr = initials(formData.name || "") || "DEPT";
  const raw = parentCode ? `${parentCode}_${abbr}` : abbr;
  const base = lower ? raw.toLowerCase() : raw.toUpperCase();
  const used = new Set(
    [...deptIndex.value.values()]
      .filter((d) => String(d.id) !== String(formData.id || ""))
      .map((d) => (d.code || "").toLowerCase())
  );
  if (!parentCode && !used.has(base.toLowerCase())) return base;
  for (let n = 1; n < 1000; n += 1) {
    const code = `${base}_${String(n).padStart(2, "0")}`;
    if (!used.has(code.toLowerCase())) return code;
  }
  return base;
}
watch(
  () => [formData.name, formData.parentId, autoCode.value],
  () => {
    if (autoCode.value && dialogState.visible) formData.code = buildCode();
  }
);

function leaderPayload(): DeptForm["leader"] | undefined {
  if (leader.mode === "pick") return leader.userId ? { userId: leader.userId } : null;
  if (leader.mode === "create") {
    const { nickname, username, mobile, roleIds, password } = leader.create;
    return {
      create: {
        nickname: nickname.trim(),
        username: username.trim(),
        mobile: mobile.trim(),
        roleIds,
        password: leader.passwordMode === "manual" ? password : "",
      },
    };
  }
  return null;
}

async function copyAccount() {
  try {
    await navigator.clipboard.writeText(
      `用户名：${account.username}\n初始密码：${account.password}`
    );
    ElMessage.success("已复制");
  } catch {
    ElMessage.warning("复制失败，请手动抄写");
  }
}

const rules: FormRules<DeptForm> = {
  parentId: [{ required: true, message: "上级部门不能为空", trigger: "change" }],
  name: [{ required: true, message: "部门名称不能为空", trigger: "blur" }],
  code: [{ required: true, message: "部门编号不能为空", trigger: "blur" }],
  sort: [{ required: true, message: "显示排序不能为空", trigger: "blur" }],
};

/**
 * 拉取部门列表数据（一次性返回全量树）
 */
async function fetchData(): Promise<void> {
  loading.value = true;
  try {
    list.value = await DeptAPI.getList();
  } finally {
    loading.value = false;
  }
  // 选中的部门被删了就退回它的上级，没有就选第一个
  if (!selectedId.value || !deptIndex.value.has(selectedId.value)) {
    const fallback = list.value[0]?.id;
    if (fallback) select(String(fallback));
    else selectedId.value = "";
  } else {
    select(selectedId.value);
  }
  if (keyword.value || statusFilter.value !== "all")
    nextTick(() => treeRef.value?.filter(keyword.value || " "));
}

/**
 * 保存或删除后重新取部门树。
 */
function handleResetQuery(): void {
  void fetchData();
}

/**
 * 重置表单数据和验证状态
 */
function resetForm(): void {
  deptFormRef.value?.resetFields();
  deptFormRef.value?.clearValidate();
  Object.keys(formData).forEach((key) => {
    delete (formData as Record<string, unknown>)[key];
  });
  Object.assign(formData, initialFormData, { cameras: [] });
}

/**
 * 打开新增/编辑部门弹窗。
 *
 * @param parentId 父部门 ID（新增子部门时传入）
 * @param deptId 部门 ID（编辑时传入）
 */
async function openDialog(parentId?: string, deptId?: string): Promise<void> {
  const data = await DeptAPI.getOptions();
  deptOptions.value = [
    {
      value: "0",
      label: "顶级部门",
      children: data,
    },
  ];

  resetLeader();
  mapOpen.value = false;
  contactAuto = false;
  // 新增默认自动生成编号；编辑保留原编号，要换可以勾「自动」重新生成
  autoCode.value = !deptId;
  if (!roleOptions.value.length)
    RoleAPI.getOptions()
      .then((list) => (roleOptions.value = list))
      .catch(() => {});
  dialogState.visible = true;
  if (deptId) {
    dialogState.title = "修改部门";
    const form = await DeptAPI.getFormData(deptId);
    Object.assign(formData, form);
    if (form.leaderUserId) {
      leader.options = [
        { id: form.leaderUserId, nickname: form.leaderName, mobile: form.leaderMobile } as UserItem,
      ];
      leader.userId = form.leaderUserId;
      leader.mode = "pick";
      contactAuto =
        form.contact === form.leaderName && (form.phone || "") === (form.leaderMobile || "");
    }
  } else {
    dialogState.title = "新增部门";
    contactAuto = true;
    formData.parentId = parentId || "0";
    formData.code = buildCode();
  }
  // 打开时不显示上一次的校验红字
  await nextTick();
  deptFormRef.value?.clearValidate();
}

/**
 * 校验并提交部门表单。
 */
async function handleSubmit(): Promise<void> {
  const valid = await deptFormRef.value?.validate().then(
    () => true,
    () => false
  );
  if (!valid) return;
  if (leader.mode === "create") {
    if (!leader.create.nickname.trim() || !leader.create.username.trim())
      return void ElMessage.warning("请填写负责人姓名和用户名");
    if (leader.passwordMode === "manual" && leader.create.password.length < 8)
      return void ElMessage.warning("初始密码至少 8 位");
  }
  if (leader.mode === "pick" && !leader.userId)
    return void ElMessage.warning("请选择负责人，或改为暂不设置");

  saving.value = true;
  try {
    const deptId = formData.id;
    // 只有采样机构有监控通道，改成公司时清掉
    const payload: DeptForm = {
      ...formData,
      leader: leaderPayload(),
      cameras: formData.type === "采样机构" ? formData.cameras || [] : [],
    };
    const result = deptId ? await DeptAPI.update(deptId, payload) : await DeptAPI.create(payload);
    ElMessage.success(deptId ? "修改成功" : "新增成功");
    closeDialog();
    fetchData();
    if (result?.leader) Object.assign(account, { open: true, ...result.leader });
  } finally {
    saving.value = false;
  }
}

/**
 * 删除单个或批量部门。
 *
 * @param deptId 指定时删除单个部门；不指定时删除表格勾选项
 */
async function handleDelete(deptId?: string): Promise<void> {
  const deptIds = deptId ?? selectedIds.value.join(",");
  if (!deptIds) {
    ElMessage.warning("请勾选删除项");
    return;
  }

  try {
    await ElMessageBox.confirm("删除后不能恢复。部门下还有下级部门或人员时不能删除。", "删除部门", {
      confirmButtonText: "确定",
      cancelButtonText: "取消",
      type: "warning",
    });
  } catch {
    ElMessage.info("已取消删除");
    return;
  }

  loading.value = true;
  try {
    await DeptAPI.deleteByIds(deptIds);
    ElMessage.success("删除成功");
    if (deptIds.split(",").includes(selectedId.value))
      selectedId.value = String(selected.value?.parentId || "");
    handleResetQuery();
  } finally {
    loading.value = false;
  }
}

/**
 * 关闭弹窗并重置表单
 */
function closeDialog(): void {
  dialogState.visible = false;
  resetForm();
}

onMounted(() => {
  fetchData();
});
</script>

<style scoped>
.muted {
  color: var(--el-text-color-placeholder);
}
.block {
  padding: 4px 0 8px;
  border-bottom: 1px solid var(--el-border-color-lighter);
}
.block + .block {
  padding-top: 16px;
}
.block:last-child {
  border-bottom: none;
}
.block h4 {
  margin: 0 0 14px;
  font-size: 14px;
}
.tip {
  margin: 4px 0 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--el-text-color-secondary);
}
.block > .tip {
  margin: -6px 0 10px;
}
.option-meta {
  float: right;
  margin-left: 12px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.password {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 16px;
  align-items: center;
  width: 100%;
}
.password .el-input {
  flex: 1;
  min-width: 180px;
}
.address-card {
  display: flex;
  gap: 10px;
  align-items: center;
  padding: 10px 12px;
  background: var(--el-fill-color-lighter);
  border-radius: 6px;
}
.address-card .pin {
  font-size: 18px;
  color: var(--el-color-primary);
}
.address-text {
  flex: 1;
  min-width: 0;
  line-height: 1.6;
  word-break: break-all;
}
.picker {
  margin-top: 12px;
}
.secret {
  font-size: 16px;
  letter-spacing: 1px;
  user-select: all;
}
.secret-tip {
  margin-top: 12px;
}
/* 左树右详情：部门多时靠搜索和树定位，右边只看选中的一个 */
.dept-page {
  gap: var(--page-gap);
}
.dept-body {
  display: flex;
  flex-shrink: 0;
  flex-direction: row;
  gap: var(--page-gap);
  align-items: stretch;
  height: calc(100vh - 200px);
  min-height: 520px;
}
.tree-card {
  display: flex;
  flex: 0 0 300px;
  flex-direction: column;
  min-width: 0;
}
.tree-card :deep(.el-card__body) {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
  padding: 12px;
}
.tree-head {
  display: flex;
  gap: 8px;
}
.tree-tools {
  display: flex;
  gap: 8px;
  align-items: center;
  justify-content: space-between;
}
.tree-box {
  flex: 1;
  min-height: 0;
}
.node {
  display: flex;
  flex: 1;
  gap: 6px;
  align-items: center;
  min-width: 0;
  padding-right: 8px;
}
.node.off {
  color: var(--el-text-color-placeholder);
}
.node-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.node-pin {
  flex-shrink: 0;
  font-size: 12px;
  color: var(--el-color-primary);
}
.node-count {
  flex-shrink: 0;
  padding: 0 6px;
  margin-left: auto;
  font-size: 12px;
  line-height: 18px;
  color: var(--el-text-color-secondary);
  background: var(--el-fill-color);
  border-radius: 9px;
}
.detail-card {
  flex: 1;
  min-width: 0;
  overflow: auto;
}
/* 卡片本身滚动；卡片体不能再设 overflow，否则权限上限页签里的目录、保存栏 sticky 失效 */
.detail-card :deep(.el-card__body),
.tabs :deep(.el-tabs__content) {
  overflow: visible;
}
.detail-head {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: flex-start;
  justify-content: space-between;
  margin-bottom: 16px;
}
.detail-head h3 {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  margin: 4px 0 0;
  font-size: 18px;
}
.crumb {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.ops {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.ops .el-button + .el-button {
  margin-left: 0;
}
/* 部门概况：小标题在上、值在下的格子，比带边框的表格轻 */
.facts {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 1px;
  margin-bottom: 8px;
  overflow: hidden;
  background: var(--card-divider);
  border: 1px solid var(--card-border);
  border-radius: 8px;
}
.fact {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  padding: 10px 14px;
  font-size: 13px;
  background: var(--content-bg);
}
.fact--wide {
  grid-column: 1 / -1;
}
.fact__label {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.tab-tools {
  display: flex;
  gap: 8px;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}
.pager {
  justify-content: flex-end;
  margin-top: 12px;
}
@media (max-width: 900px) {
  .dept-body {
    flex-direction: column;
    height: auto;
  }
  .facts {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .tree-card {
    flex-basis: 360px;
  }
}
.auto-code {
  margin-right: 0;
}
</style>
