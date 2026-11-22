<template>
  <div class="page-container page-flow">
    <PageHeader :title="detail?.name || '划拨单详情'" back="/sample/transfers">
      <template v-if="detail" #tags>
        <el-tag type="primary" effect="plain">划拨</el-tag>
        <el-tag :type="transferTone(detail.status)">{{ detail.status }}</el-tag>
      </template>
      <template v-if="detail" #meta>
        {{ detail.id }} · {{ detail.boxCount }} 台 · 提交即生效，无物流步骤
      </template>
    </PageHeader>

    <el-skeleton v-if="loading && !detail" :rows="8" animated class="block" />
    <el-empty v-else-if="!detail" :description="error || '没有这张划拨单'" />

    <template v-else>
      <el-card shadow="never" class="block hero" :class="`tone-${headTone}`">
        <div class="hero-head">
          <div class="hero-status">
            <span class="pulse" />
            <div>
              <div class="now">{{ detail.status }}</div>
              <div class="summary">
                {{ detail.boxCount }} 台箱子归属
                <template v-if="detail.status === '已划拨'">
                  已转到 {{ detail.toOrg.name }}
                </template>
                <template v-else>已退回原公司</template>
              </div>
            </div>
          </div>
          <!-- R24（#70）撤销划拨下线：这里原来的「撤销划拨」按钮与「整单不可撤销」占位一并删除。
               退回/改派走列表页的「重新划拨」，详情页只留一行说明，避免用户找不到入口后反复刷新。 -->
          <div v-if="detail.status === '已划拨'" class="ops text-muted">
            撤销已下线：如需退回或改派请重新划拨
          </div>
        </div>

        <div class="route">
          <div class="party">
            <span class="role from">原公司</span>
            <b>{{ fromText }}</b>
          </div>
          <div class="arrow">
            <el-icon><Right /></el-icon>
          </div>
          <div class="party">
            <span class="role to">目标公司</span>
            <b>{{ detail.toOrg.name || "—" }}</b>
          </div>
        </div>

        <dl class="facts">
          <div>
            <dt>划拨人</dt>
            <dd>{{ detail.logs.find((l) => l.action === "提交划拨")?.by || "—" }}</dd>
          </div>
          <div>
            <dt>提交时间</dt>
            <dd>{{ fullTime(detail.createdAt) }}</dd>
          </div>
          <div v-if="detail.revokedAt">
            <dt>撤销时间</dt>
            <dd>{{ fullTime(detail.revokedAt) }}</dd>
          </div>
          <div v-if="detail.revokeReason">
            <dt>撤销原因</dt>
            <dd>{{ detail.revokeReason }}</dd>
          </div>
          <div v-if="detail.note" class="wide">
            <dt>备注</dt>
            <dd>{{ detail.note }}</dd>
          </div>
        </dl>
      </el-card>

      <el-card shadow="never" class="block" :header="`逐台快照 ${detail.boxes.length}`">
        <el-table :data="detail.boxes" class="box-table">
          <el-table-column label="采样箱" min-width="200">
            <template #default="{ row }">
              <b>{{ row.name }}</b>
              <div class="text-muted mono">{{ row.code }}</div>
            </template>
          </el-table-column>
          <el-table-column label="原公司" min-width="140">
            <template #default="{ row }">{{ row.fromOrg || "总公司" }}</template>
          </el-table-column>
          <el-table-column label="原保管人" width="110">
            <template #default="{ row }">{{ row.fromOwner || "—" }}</template>
          </el-table-column>
          <el-table-column label="生命周期" width="90">
            <template #default="{ row }">
              <el-tag size="small" :type="lifeTone(row.life)">{{ row.life || "—" }}</el-tag>
            </template>
          </el-table-column>
          <!-- R24（#70）撤销下线：原「撤销守卫」列（可撤销/任务中/已开箱/已检测/归属已改挂）删除。
               服务端 boxes[].revocable 仍下发——领域层四守卫保留是为了读历史已撤销单的审计口径，
               只是撤销入口没了，这列对用户不再有意义。 -->
        </el-table>
      </el-card>

      <el-card shadow="never" class="block" header="操作记录">
        <el-timeline>
          <el-timeline-item
            v-for="(log, index) in detail.logs"
            :key="index"
            :timestamp="fullTime(log.time)"
            :type="log.action === '撤销划拨' ? 'danger' : 'primary'"
          >
            <b>{{ log.action }}</b>
            <span class="text-muted">· {{ log.by || "—" }}</span>
            <span v-if="log.status" class="text-muted">· {{ log.status }}</span>
            <p v-if="log.note" class="log-note">{{ log.note }}</p>
          </el-timeline-item>
        </el-timeline>
      </el-card>
    </template>
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: "SampleTransferDetail" });

import { Right } from "@element-plus/icons-vue";
import TransferAPI, { type TransferDetail } from "@/api/sample/transfer";
import PageHeader from "@/components/biz/PageHeader.vue";
import { fullTime } from "@/utils/time";
import { lifeTone, transferTone } from "@/utils/tone";

const route = useRoute();
const id = computed(() => String(route.params.id || ""));
const detail = ref<TransferDetail | null>(null);
const loading = ref(false);
const error = ref("");

const headTone = computed(() => (detail.value?.status === "已划拨" ? "done" : "error"));
const fromText = computed(() => {
  const from = detail.value?.from || [];
  if (!from.length) return "—";
  return from.map((f) => `${f.orgName}（${f.count} 台）`).join("、");
});

let seq = 0;
async function load() {
  if (!id.value) return;
  const mine = ++seq;
  loading.value = true;
  error.value = "";
  try {
    const next = await TransferAPI.detail(id.value);
    if (mine !== seq) return;
    detail.value = next;
  } catch (e) {
    if (mine !== seq) return;
    detail.value = null;
    error.value = e instanceof Error ? e.message : "";
  } finally {
    if (mine === seq) loading.value = false;
  }
}
watch(id, () => void load());
onMounted(() => void load());
onActivated(() => void load());
</script>

<style scoped>
.page-container {
  overflow: auto;
}
.page-container > * {
  flex-shrink: 0;
}
.block {
  margin-top: 12px;
}
.hero {
  --tone: var(--el-color-success);
  --tone-soft: var(--el-color-success-light-9);
  position: relative;
  overflow: hidden;
  border-radius: 10px;
}
.hero.tone-error {
  --tone: var(--el-color-info);
  --tone-soft: var(--el-color-info-light-9);
}
.hero::before {
  position: absolute;
  inset: 0 0 auto;
  height: 3px;
  content: "";
  background: var(--tone);
}
.hero-head {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: center;
  justify-content: space-between;
}
.hero-status {
  display: flex;
  gap: 12px;
  align-items: center;
}
.pulse {
  width: 12px;
  height: 12px;
  background: var(--tone);
  border-radius: 50%;
  box-shadow: 0 0 0 5px var(--tone-soft);
}
.now {
  font-size: 22px;
  font-weight: 600;
  color: var(--tone);
}
.summary {
  margin-top: 2px;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}
.route {
  display: flex;
  gap: 16px;
  align-items: center;
  margin-top: 18px;
}
.party {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.role {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.arrow {
  color: var(--el-color-primary);
}
.facts {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 14px 24px;
  padding-top: 16px;
  margin: 16px 0 0;
  border-top: 1px dashed var(--el-border-color-lighter);
}
.facts .wide {
  grid-column: span 2;
}
.facts dt {
  margin-bottom: 4px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.facts dd {
  margin: 0;
  font-size: 14px;
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
}
.ops {
  font-size: 13px;
  text-align: right;
}
.log-note {
  margin: 4px 0 0;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}
</style>
