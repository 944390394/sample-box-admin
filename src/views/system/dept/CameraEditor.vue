<template>
  <div class="cameras">
    <div v-for="(camera, index) in list" :key="index" class="row">
      <span class="no">{{ index + 1 }}</span>
      <el-input v-model="camera.name" maxlength="20" placeholder="名称，如：采样台" class="name" />
      <el-input
        v-model="camera.channel"
        maxlength="64"
        placeholder="平台通道号（选填）"
        class="channel"
      />
      <el-input
        v-model="camera.liveUrl"
        maxlength="500"
        placeholder="直播地址（选填，http/https，HLS 优先）"
        class="url"
      />
      <el-button link type="danger" @click="remove(index)">删除</el-button>
    </div>
    <el-button v-if="list.length < 8" size="small" @click="add">添加一路</el-button>
    <p class="tip">
      最多 8
      路。视频平台还没接入，先登记通道，任务详情的「监控」里按路数排好画面位置；填了直播地址的那一路可以直接看。
    </p>
  </div>
</template>

<script setup lang="ts">
import type { DeptCamera } from "@/api/system/dept/types";

/** 采样机构的监控通道（1–8 路）编辑器，v-model 是通道数组。 */
const list = defineModel<DeptCamera[]>({ default: () => [] });

function add() {
  list.value = [
    ...list.value,
    { name: `通道 ${list.value.length + 1}`, channel: "", liveUrl: "", playbackUrl: "" },
  ];
}

function remove(index: number) {
  list.value = list.value.filter((_, i) => i !== index);
}
</script>

<style scoped>
.cameras {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
}
.row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
.no {
  width: 18px;
  color: var(--el-text-color-secondary);
  text-align: right;
}
.name {
  width: 150px;
}
.channel {
  width: 190px;
}
.url {
  flex: 1;
  min-width: 220px;
}
.tip {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--el-text-color-secondary);
}
</style>
