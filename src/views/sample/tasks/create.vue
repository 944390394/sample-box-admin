<template>
  <div class="page-container">
    <el-card shadow="never" class="form">
      <el-form label-width="110px">
        <el-form-item label="任务名称"><el-input placeholder="例如：华南水质复测" /></el-form-item>
        <el-form-item label="分公司">
          <el-select placeholder="选择分公司" style="width: 100%">
            <el-option label="华南分公司" value="华南分公司" />
            <el-option label="华东分公司" value="华东分公司" />
            <el-option label="西南分公司" value="西南分公司" />
          </el-select>
        </el-form-item>
        <el-form-item label="样品"><el-input placeholder="名称、批号、数量" /></el-form-item>
        <el-form-item label="计划地点"><el-input placeholder="采样点名称" /></el-form-item>
        <el-form-item label="授权人员">
          <el-select multiple placeholder="可多选" style="width: 100%">
            <el-option label="林夏" value="林夏" />
            <el-option label="赵衡" value="赵衡" />
          </el-select>
        </el-form-item>
        <el-form-item label="绑定采样箱">
          <el-select placeholder="选择未使用的箱" style="width: 100%">
            <el-option
              v-for="box in boxSession.boxes"
              :key="box.id"
              :label="box.life === '未使用' ? box.id : `${box.id} ${box.life}`"
              :value="box.id"
              :disabled="box.life !== '未使用'"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="上报间隔">
          <el-input placeholder="5" style="width: 180px">
            <template #append>分钟</template>
          </el-input>
        </el-form-item>
        <el-form-item>
          <el-button type="primary" @click="later">提交任务单</el-button>
        </el-form-item>
      </el-form>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { ElMessage } from "element-plus";
import { boxSession } from "../box-state";
function later() {
  ElMessage.info("此为页面设计，尚未创建任务单");
}
</script>

<style scoped>
.form {
  max-width: 760px;
}
</style>
