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
import WorkbenchAPI from "@/api/sample/workbench";

/** 顶栏的待办数：要我推进的任务、开箱超限、待激活和异常的箱子。一分钟刷新一次。 */
const router = useRouter();
const count = ref(0);
let timer = 0;

async function load() {
  try {
    const data = await WorkbenchAPI.get();
    const tasks = data.taskTodo;
    const boxes = data.boxTodo;
    count.value =
      (tasks
        ? (tasks.send?.total || 0) +
          (tasks.arrive?.total || 0) +
          (tasks.sign?.total || 0) +
          (tasks.returning?.total || 0) +
          (tasks.inspect?.total || 0) +
          (tasks.overLimit?.total || 0)
        : 0) +
      (boxes.pending?.total || 0) +
      (boxes.alert?.total || 0);
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
