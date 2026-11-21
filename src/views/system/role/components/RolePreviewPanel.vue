<template>
  <div class="pv-panel">
    <el-tabs v-model="tab" class="pv-tabs">
      <el-tab-pane label="菜单" name="menus">
        <div v-loading="loading" class="pv-pane">
          <h4>能看到的菜单</h4>
          <ul v-if="menus.length" class="pv-list">
            <li v-for="menu in menus" :key="menu.title" :class="{ off: !menu.on }">
              <el-icon><component :is="menu.on ? Check : Close" /></el-icon>
              <span>{{ menu.title }}</span>
            </li>
          </ul>
          <p v-else-if="!loading" class="text-muted small">
            菜单预览暂不可用（服务端菜单接口未就绪）
          </p>
        </div>
      </el-tab-pane>
      <el-tab-pane label="卡片" name="cards">
        <div class="pv-pane">
          <h4>工作台卡片</h4>
          <ul v-if="cards.length" class="pv-list">
            <li v-for="card in cards" :key="card.title" :class="{ off: !card.on }">
              <el-icon><component :is="card.on ? Check : Close" /></el-icon>
              <span>{{ card.title }}</span>
              <small v-if="!card.on">（缺看内容的权限）</small>
            </li>
          </ul>
          <p v-else class="text-muted small">一张卡片都没勾</p>
        </div>
      </el-tab-pane>
      <el-tab-pane label="箱详情" name="box">
        <div class="pv-pane">
          <h4>采样箱详情</h4>
          <ul v-if="canDetail" class="pv-list">
            <li v-for="tabItem in boxTabs" :key="tabItem.title" :class="{ off: !tabItem.on }">
              <el-icon><component :is="tabItem.on ? Check : Close" /></el-icon>
              <span>{{ tabItem.title }}</span>
            </li>
          </ul>
          <p v-else class="text-muted small">没有「打开采样箱详情」，进不了详情页</p>
        </div>
      </el-tab-pane>
      <el-tab-pane label="任务详情" name="task">
        <div class="pv-pane">
          <h4>任务详情</h4>
          <ul v-if="canTask" class="pv-list">
            <li v-for="part in taskParts" :key="part.title" :class="{ off: !part.on }">
              <el-icon><component :is="part.on ? Check : Close" /></el-icon>
              <span>{{ part.title }}</span>
            </li>
          </ul>
          <p v-else class="text-muted small">没有「查看任务单」，看不到任务单</p>
        </div>
      </el-tab-pane>
    </el-tabs>
    <p class="pv-note text-muted">只读预览 · 勾选后实时更新（含未保存改动）</p>
  </div>
</template>

<script setup lang="ts">
import { Check, Close } from "@element-plus/icons-vue";
import type { MenuPreviewItem } from "@/api/system/role";

/**
 * 角色页右侧「能看到什么」预览卡（只读）：菜单 / 工作台卡片 / 采样箱详情 / 任务详情四页签。
 * 数据全部由父页算好传入——菜单走服务端 menusFor 单源（保存态 GET / 草稿态 POST 防抖），
 * 卡片/详情/任务按目录前置推导，本组件不做任何权限计算。
 * ≥1200px 作 sticky 侧卡；<1200px 同一组件放进「预览」抽屉。
 */
withDefaults(
  defineProps<{
    menus: MenuPreviewItem[];
    loading?: boolean;
    cards: { title: string; on: boolean }[];
    boxTabs: { title: string; on: boolean }[];
    taskParts: { title: string; on: boolean }[];
    /** has("device:box:detail") */
    canDetail: boolean;
    /** has("device:box:task") */
    canTask: boolean;
  }>(),
  { loading: false }
);

const tab = ref("menus");
</script>

<style scoped>
.pv-panel {
  display: flex;
  flex-direction: column;
  min-height: 120px;
}
.pv-tabs :deep(.el-tabs__header) {
  margin-bottom: 8px;
}
.pv-tabs :deep(.el-tabs__item) {
  padding: 0 10px;
  font-size: 13px;
}
.pv-pane {
  min-height: 80px;
}
.pv-pane h4 {
  margin: 0 0 6px;
  font-size: 13px;
  color: var(--el-text-color-primary);
}
.pv-list {
  padding: 0;
  margin: 0;
  list-style: none;
}
.pv-list li {
  display: flex;
  gap: 6px;
  align-items: center;
  padding: 3px 0;
  font-size: 13px;
  color: var(--el-color-success);
}
.pv-list li .el-icon {
  flex: none;
  font-size: 13px;
}
.pv-list li.off {
  color: var(--el-text-color-placeholder);
}
.pv-list small {
  font-size: 11px;
}
.small {
  margin: 4px 0 0;
  font-size: 12px;
}
.pv-note {
  padding-top: 8px;
  margin: auto 0 0;
  font-size: 12px;
  border-top: 1px solid var(--card-divider);
}
</style>
