<template>
  <div class="page-container">
    <el-card shadow="never" class="chat">
      <div class="tools">
        <el-tag>查状态</el-tag>
        <el-tag>查记录</el-tag>
        <el-tag>查位置</el-tag>
        <el-tag>查任务</el-tag>
        <el-tag type="warning">创建任务需确认</el-tag>
        <el-tag type="warning">下发指令需确认</el-tag>
      </div>
      <div class="log">
        <div v-for="(item, index) in lines" :key="index" :class="item.role">{{ item.text }}</div>
      </div>
      <div class="composer">
        <el-input v-model="draft" placeholder="例如：今天有哪些异常箱？" @keyup.enter="send" />
        <el-button type="primary" @click="send">发送</el-button>
      </div>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";

const lines = ref([
  { role: "user", text: "BOX-002 现在什么情况？" },
  {
    role: "assistant",
    text: "BOX-002 处于异常。最近一次开箱在 16:40，开箱 3 次，开箱人不在授权名单。发出指令前会先请你确认。",
  },
]);
const draft = ref("");
function send() {
  const text = draft.value.trim();
  if (!text) return;
  lines.value.push({ role: "user", text });
  lines.value.push({
    role: "assistant",
    text: "对话界面已留好。模型和服务接口还没接，这条不会查询真实数据。",
  });
  draft.value = "";
}
</script>

<style scoped>
.chat {
  display: flex;
  flex-direction: column;
  min-height: 520px;
}
.tools {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.log {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 10px;
  margin: 14px 0;
}
.user,
.assistant {
  max-width: 70%;
  padding: 10px 12px;
  line-height: 1.5;
  border-radius: 10px;
}
.user {
  align-self: flex-end;
  background: var(--el-color-primary-light-8);
}
.assistant {
  align-self: flex-start;
  background: var(--el-fill-color-light);
}
.composer {
  display: flex;
  gap: 8px;
}
</style>
