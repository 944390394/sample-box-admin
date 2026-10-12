<template>
  <div class="page-container">
    <el-row :gutter="12">
      <el-col :span="6">
        <el-card shadow="never" header="组织">
          <el-tree :data="orgs" default-expand-all highlight-current @node-click="onOrg" />
        </el-card>
      </el-col>
      <el-col :span="10">
        <el-card shadow="never" :header="'采样箱 → ' + orgName">
          <el-table :data="boxes" size="small">
            <el-table-column prop="id" label="箱号" width="110" />
            <el-table-column prop="org" label="当前所属" />
            <el-table-column prop="status" label="状态" width="90" />
          </el-table>
          <el-button class="mt" type="primary" @click="later">分配到该组织</el-button>
        </el-card>
      </el-col>
      <el-col :span="8">
        <el-card shadow="never" header="任务 → 现场人员">
          <el-table :data="tasks" size="small">
            <el-table-column prop="no" label="任务单" />
            <el-table-column prop="people" label="当前人员" width="100" />
          </el-table>
          <el-button class="mt" type="primary" @click="later">指定人员</el-button>
        </el-card>
      </el-col>
    </el-row>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { ElMessage } from "element-plus";
import { boxes, tasks } from "../data";

const orgName = ref("华南分公司");
const orgs = [
  {
    label: "总公司",
    children: [{ label: "华南分公司" }, { label: "华东分公司" }, { label: "西南分公司" }],
  },
  {
    label: "合作采样机构",
    children: [{ label: "采样机构甲" }, { label: "采样机构乙" }],
  },
];
function onOrg(node: { label: string; children?: unknown }) {
  if (!node.children) orgName.value = node.label;
}
function later() {
  ElMessage.info("此为页面设计，尚未保存");
}
</script>

<style scoped>
.mt {
  margin-top: 12px;
}
</style>
