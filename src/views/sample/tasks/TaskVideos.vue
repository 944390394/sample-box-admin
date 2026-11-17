<template>
  <div class="videos">
    <el-alert
      v-if="!enabled"
      type="info"
      :closable="false"
      show-icon
      title="这张任务单没有要求开箱录像"
      description="创建采样任务时，采样单位是「采样机构」才能开启。开启后，任务进行中箱子每次在计划地点开箱，服务器会通知视频平台录像。"
    />

    <template v-if="videos.length">
      <div class="summary">
        <span>共 {{ videos.length }} 次开箱</span>
        <span v-for="(n, status) in statusCounts" :key="status">
          <el-tag size="small" :type="videoTone(status)">{{ status }}</el-tag>
          {{ n }}
        </span>
      </div>
      <div class="grid" :class="`n-${Math.min(videos.length, 8)}`">
        <div
          v-for="(video, index) in videos"
          :key="video.id"
          class="tile"
          :class="{ playable: !!video.url }"
          @click="video.url && open(video.id)"
        >
          <img v-if="video.poster" :src="video.poster" alt="" />
          <span class="center">
            <el-icon :size="26"><component :is="video.url ? VideoPlay : VideoCamera" /></el-icon>
            <el-tag size="small" :type="videoTone(video.status)" effect="dark">
              {{ video.status || "已完成" }}
            </el-tag>
          </span>
          <span class="caption">
            <b>{{ index + 1 }}. {{ names[video.boxId] || video.boxId }}</b>
            <span>
              开箱 {{ shortTime(video.openedAt || video.recordedAt) }}
              <template v-if="video.distanceM != null">
                · 距计划地点 {{ formatDistance(video.distanceM) }}
              </template>
            </span>
            <span v-if="video.detail && video.status !== '已完成'" class="detail">
              {{ video.detail }}
            </span>
          </span>
          <el-button
            v-if="canRetry && ['失败', '平台未接入'].includes(video.status || '')"
            class="retry"
            size="small"
            :loading="retrying === video.id"
            @click.stop="retry(video.id)"
          >
            重新请求
          </el-button>
        </div>
      </div>
    </template>
    <div v-else-if="enabled" class="placeholder">
      <div class="grid n-4 ghost">
        <div v-for="n in 4" :key="n" class="tile">
          <span class="center">
            <el-icon :size="26"><VideoCamera /></el-icon>
          </span>
        </div>
      </div>
      <div class="hint">
        <b>还没有开箱录像</b>
        <p>
          任务进行中，箱子在计划地点每开一次箱，这里多一格，显示录像请求的状态；视频平台录好后可以直接播放。
        </p>
        <p class="text-muted">
          视频平台在「系统设置 ›
          集成」里配置，没配置时状态显示「平台未接入」，配好后可以点「重新请求」补录。
        </p>
      </div>
    </div>

    <el-dialog
      v-model="player.open"
      :title="current ? `${names[current.boxId] || current.boxId} · 开箱录像` : ''"
      width="860px"
      style="max-width: 96vw"
      destroy-on-close
    >
      <video
        v-if="current?.url"
        class="player"
        :src="current.url"
        :poster="current.poster"
        controls
        autoplay
        playsinline
      />
      <p v-if="current" class="text-muted">
        开箱 {{ fullTime(current.openedAt || current.recordedAt) }}
        <template v-if="current.distanceM != null">
          · 距计划地点 {{ formatDistance(current.distanceM) }}
        </template>
      </p>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { VideoCamera, VideoPlay } from "@element-plus/icons-vue";
import API, { formatDistance, type TaskVideo } from "@/api/sample/report-policy";
import { fullTime, shortTime } from "@/utils/time";
import { videoTone } from "@/utils/tone";

/**
 * 开箱录像：采样机构在采样单位每开一次箱一格，标出录像请求的状态（已请求、录制中、已完成、失败、平台未接入）。
 * 有地址的可以播放；失败或平台未接入的可以重新请求。1 格占满，2–4 格两列，5 格以上四列。
 */
const props = withDefaults(
  defineProps<{
    videos: TaskVideo[];
    enabled?: boolean;
    names?: Record<string, string>;
    canRetry?: boolean;
    taskId?: string;
  }>(),
  { enabled: false, names: () => ({}), canRetry: false, taskId: "" }
);
const emit = defineEmits<{ changed: [videos: TaskVideo[]] }>();
const player = reactive({ open: false, id: "" });
const current = computed(() => props.videos.find((v) => v.id === player.id));
const retrying = ref("");
const statusCounts = computed(() => {
  const out: Record<string, number> = {};
  for (const video of props.videos)
    out[video.status || "已完成"] = (out[video.status || "已完成"] || 0) + 1;
  return out;
});

function open(id: string) {
  Object.assign(player, { open: true, id });
}
async function retry(id: string) {
  if (!props.taskId) return;
  retrying.value = id;
  try {
    const result = await API.retryVideo(props.taskId, id);
    emit("changed", result.videos);
  } finally {
    retrying.value = "";
  }
}
defineExpose({ open });
</script>

<style scoped>
.videos {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.summary {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: center;
  font-size: 13px;
}
.grid {
  display: grid;
  gap: 10px;
}
.n-1 {
  grid-template-columns: minmax(0, 640px);
}
.n-2,
.n-3,
.n-4 {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}
.n-5,
.n-6,
.n-7,
.n-8 {
  grid-template-columns: repeat(4, minmax(0, 1fr));
}
@media (max-width: 768px) {
  .n-5,
  .n-6,
  .n-7,
  .n-8 {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
.tile {
  position: relative;
  aspect-ratio: 16 / 9;
  overflow: hidden;
  color: #fff;
  background: #1f2937;
  border-radius: 8px;
}
.tile.playable {
  cursor: pointer;
}
.tile img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.center {
  position: absolute;
  top: 38%;
  left: 50%;
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: center;
  transform: translate(-50%, -50%);
}
.caption {
  position: absolute;
  right: 0;
  bottom: 0;
  left: 0;
  display: flex;
  flex-direction: column;
  padding: 16px 10px 8px;
  font-size: 12px;
  line-height: 1.5;
  background: linear-gradient(transparent, rgb(0 0 0 / 70%));
}
.detail {
  color: #fca5a5;
}
.retry {
  position: absolute;
  top: 8px;
  right: 8px;
}
.placeholder {
  display: flex;
  flex-wrap: wrap;
  gap: 20px;
  align-items: center;
}
.ghost {
  flex: 1 1 360px;
  max-width: 520px;
}
.ghost .tile {
  color: var(--el-text-color-placeholder);
  background: var(--el-fill-color-light);
  border: 1px dashed var(--el-border-color);
}
.hint {
  flex: 1 1 240px;
  font-size: 13px;
  line-height: 1.7;
  color: var(--el-text-color-secondary);
}
.hint b {
  font-size: 14px;
  color: var(--el-text-color-primary);
}
.hint p {
  margin: 6px 0 0;
}
.player {
  display: block;
  width: 100%;
  max-height: 70vh;
  background: #000;
  border-radius: 6px;
}
</style>
