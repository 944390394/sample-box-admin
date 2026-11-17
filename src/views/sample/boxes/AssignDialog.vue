<template>
  <el-dialog
    :model-value="modelValue"
    title="分配采样箱"
    width="480px"
    @update:model-value="emit('update:modelValue', $event)"
    @open="onOpen"
  >
    <p v-if="box" class="lead">
      {{ box.name || box.id }} · 现在属于 {{ box.org || "总公司" }}
      <template v-if="box.owner && box.owner !== '—'">，由 {{ box.owner }} 保管</template>
    </p>
    <el-form label-width="84px" @submit.prevent>
      <el-form-item label="所属单位">
        <el-select
          v-model="orgId"
          filterable
          placeholder="选择单位"
          style="width: 100%"
          :loading="loading"
          @change="onOrg"
        >
          <el-option v-for="item in orgs" :key="item.id" :label="item.path" :value="item.id" />
        </el-select>
      </el-form-item>
      <el-form-item label="保管人">
        <el-select
          v-model="ownerId"
          filterable
          clearable
          :disabled="!orgId"
          :placeholder="orgId ? '不指定则只改单位' : '先选单位'"
          style="width: 100%"
          :loading="loadingUsers"
        >
          <el-option label="不指定保管人" value="" />
          <el-option v-for="item in users" :key="item.id" :label="item.name" :value="item.id">
            <span>{{ item.name }}</span>
            <span class="dept">{{ item.dept }}</span>
          </el-option>
        </el-select>
      </el-form-item>
    </el-form>
    <p class="note">只能选你数据范围内的单位和人员。保管人能在「现场台」看到这台箱子。</p>
    <template #footer>
      <el-button @click="emit('update:modelValue', false)">取消</el-button>
      <el-button type="primary" :loading="saving" :disabled="!orgId" @click="save">保存</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import SampleBoxAPI, { type AssignOptions } from "@/api/sample/box";
import type { SampleBox } from "../data";

const props = defineProps<{ modelValue: boolean; box: SampleBox | null }>();
const emit = defineEmits<{
  "update:modelValue": [value: boolean];
  saved: [box: SampleBox];
}>();

const orgs = ref<AssignOptions["orgs"]>([]);
const users = ref<AssignOptions["users"]>([]);
const orgId = ref("");
const ownerId = ref<string | undefined>("");
const loading = ref(false);
const loadingUsers = ref(false);
const saving = ref(false);

async function onOpen() {
  orgId.value = props.box?.orgId || "";
  ownerId.value = props.box?.ownerId || "";
  users.value = [];
  loading.value = true;
  try {
    orgs.value = (await SampleBoxAPI.assignOptions()).orgs;
    if (!orgId.value && props.box?.org) {
      orgId.value = orgs.value.find((item) => item.name === props.box?.org)?.id || "";
    }
  } finally {
    loading.value = false;
  }
  if (orgId.value) await loadUsers(false);
}

async function loadUsers(reset: boolean) {
  if (reset) ownerId.value = "";
  if (!orgId.value) return;
  loadingUsers.value = true;
  try {
    users.value = (await SampleBoxAPI.assignOptions({ orgId: orgId.value })).users;
  } finally {
    loadingUsers.value = false;
  }
}

function onOrg() {
  void loadUsers(true);
}

async function save() {
  if (!props.box || !orgId.value) return;
  saving.value = true;
  try {
    const next = await SampleBoxAPI.assign(props.box.id, {
      orgId: orgId.value,
      ownerId: ownerId.value ?? "",
    });
    ElMessage.success(`${props.box.id} 已分配`);
    emit("saved", next);
    emit("update:modelValue", false);
  } finally {
    saving.value = false;
  }
}
</script>

<style scoped>
.lead {
  margin: 0 0 16px;
  color: var(--el-text-color-regular);
}
.note {
  margin: 0;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.dept {
  float: right;
  margin-left: 12px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
</style>
