<template>
  <section class="panel">
    <div class="hd">
      <span>最近上报</span>
      <button class="link" type="button" @click="$emit('openReports')">全部上报</button>
    </div>
    <div v-if="!rows.length" class="empty">
      <b>还没有上报</b>
      <p>管子里还没有来过包。</p>
    </div>
    <div v-for="(row, index) in rows" :key="row.key" class="ev">
      <span class="when">
        <em v-if="showDate(index)">{{ row.date }}</em>
        {{ row.time }}
      </span>
      <div class="body">
        <b>{{ row.box }}</b>
        <span class="kind">{{ row.kind }}</span>
        <span class="where" :title="row.title">{{ row.where }}</span>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import type { HomeFeed } from "./model";

const props = defineProps<{ rows: HomeFeed[] }>();
defineEmits<{ openReports: [] }>();

function showDate(index: number) {
  const row = props.rows[index];
  if (!row?.date) return false;
  return index === 0 || props.rows[index - 1]?.date !== row.date;
}
</script>

<style scoped>
.panel {
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--content-bg);
  border: 1px solid var(--card-border);
  border-radius: var(--card-radius);
  box-shadow: var(--card-shadow);
}
.hd {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 44px;
  padding: 0 16px;
  font-size: 14px;
  font-weight: 650;
  border-bottom: 1px solid var(--card-border);
}
.ev {
  display: grid;
  grid-template-columns: 128px minmax(0, 1fr);
  gap: 12px;
  align-items: center;
  min-height: 48px;
  padding: 8px 16px;
  border-bottom: 1px solid var(--el-border-color-lighter);
}
.body {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: baseline;
  min-width: 0;
}
.ev:last-child {
  border-bottom: 0;
}
.when {
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: var(--el-text-color-secondary);
  white-space: nowrap;
}
.when em {
  margin-right: 6px;
  font-style: normal;
  font-weight: 650;
  color: var(--el-text-color-primary);
}
.kind {
  margin-left: 8px;
  font-weight: 400;
  color: var(--el-text-color-regular);
}
.where {
  font-size: 13px;
  line-height: 1.4;
  color: var(--el-text-color-regular);
  white-space: normal;
}
.link {
  padding: 0;
  margin: 0;
  font: inherit;
  font-size: 13px;
  font-weight: 400;
  color: var(--el-color-primary);
  cursor: pointer;
  background: none;
  border: 0;
}
.empty {
  padding: 22px 16px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--el-text-color-secondary);
}
.empty b {
  display: block;
  margin-bottom: 4px;
  font-size: 14px;
  color: var(--el-text-color-primary);
}
.empty p {
  margin: 0;
}
</style>
