<template>
  <div>
    <div class="wall" :class="`n${layout}`">
      <div
        v-for="camera in cameras"
        :key="camera.index"
        class="tile"
        :class="{ off: !camera.liveUrl }"
        @click="open(camera)"
      >
        <video
          v-if="camera.liveUrl && playable(camera.liveUrl)"
          :src="camera.liveUrl"
          muted
          autoplay
          playsinline
          class="video"
        />
        <div v-else class="placeholder">
          <el-icon :size="28"><VideoCamera /></el-icon>
          <span>{{ camera.liveUrl ? "点击打开直播" : "平台未接入" }}</span>
        </div>
        <div class="label">
          <span>{{ camera.index }} · {{ camera.name }}</span>
          <el-tag size="small" :type="camera.status === '在线' ? 'success' : 'info'" effect="dark">
            {{ camera.status }}
          </el-tag>
        </div>
      </div>
    </div>
    <p class="tip">
      按采样单位登记的监控通道排好画面位置（1–8
      路）。视频平台接入后这里显示实时画面；现在只有手填了直播地址的那一路能看。
    </p>
  </div>
</template>

<script setup lang="ts">
import { VideoCamera } from "@element-plus/icons-vue";
import type { TaskCamera } from "@/api/sample/report-policy";

/** 任务详情的监控宫格：1 路占满，2 路两列，3–4 路 2×2，5–6 路 3×2，7–8 路 4×2。 */
const props = defineProps<{ cameras: TaskCamera[] }>();
const layout = computed(() => {
  const n = props.cameras.length;
  return n <= 1 ? 1 : n === 2 ? 2 : n <= 4 ? 4 : n <= 6 ? 6 : 8;
});

/** 浏览器能直接放的：mp4/webm；HLS（m3u8）只有 Safari 原生支持，其它浏览器在新窗口打开。 */
function playable(url: string) {
  return /\.(mp4|webm)(\?|$)/i.test(url);
}

function open(camera: TaskCamera) {
  if (camera.liveUrl) window.open(camera.liveUrl, "_blank", "noopener");
}
</script>

<style scoped>
.wall {
  display: grid;
  gap: 8px;
}
.wall.n1 {
  grid-template-columns: 1fr;
}
.wall.n2 {
  grid-template-columns: repeat(2, 1fr);
}
.wall.n4 {
  grid-template-columns: repeat(2, 1fr);
}
.wall.n6 {
  grid-template-columns: repeat(3, 1fr);
}
.wall.n8 {
  grid-template-columns: repeat(4, 1fr);
}
.tile {
  position: relative;
  aspect-ratio: 16 / 9;
  overflow: hidden;
  cursor: pointer;
  background: #111827;
  border-radius: 6px;
}
.tile.off {
  cursor: default;
}
.video {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.placeholder {
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: center;
  justify-content: center;
  height: 100%;
  font-size: 13px;
  color: #9ca3af;
}
.label {
  position: absolute;
  right: 0;
  bottom: 0;
  left: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 8px;
  font-size: 12px;
  color: #fff;
  background: linear-gradient(transparent, rgba(0, 0, 0, 0.6));
}
.tip {
  margin: 10px 0 0;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
@media (max-width: 768px) {
  .wall.n6,
  .wall.n8 {
    grid-template-columns: repeat(2, 1fr);
  }
}
</style>
