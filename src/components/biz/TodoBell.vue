<template>
  <el-tooltip
    :content="count ? `${count} 件待处理，点开工作台` : '没有待处理的事'"
    placement="bottom"
  >
    <button
      type="button"
      class="todo-bell"
      aria-label="待处理"
      @click="router.push('/monitor/home')"
    >
      <el-badge :value="count" :hidden="!count" :max="99">
        <el-icon :size="18"><Bell /></el-icon>
      </el-badge>
    </button>
  </el-tooltip>
</template>

<script setup lang="ts">
import { Bell } from "@element-plus/icons-vue";
import WorkbenchAPI, { todoCount } from "@/api/sample/workbench";

/** 顶栏的待办数：我能推进的任务（去重）+ 待激活的箱子，和工作台标题同一个数。一分钟刷新一次。 */
const router = useRouter();
const count = ref(0);
let timer = 0;

async function load() {
  try {
    const data = await WorkbenchAPI.get();
    count.value = todoCount(data);
  } catch {
    count.value = 0;
  }
}

onMounted(() => {
  void load();
  timer = window.setInterval(load, 60000);
});
onBeforeUnmount(() => window.clearInterval(timer));
</script>

<style scoped>
.todo-bell {
  display: flex;
  align-items: center;
  height: 100%;
  padding: 0 4px;
  color: inherit;
  cursor: pointer;
  background: none;
  border: 0;
}
</style>
