<template>
  <el-table
    :data="rows"
    size="small"
    row-key="id"
    :row-class-name="rowClass"
    @row-click="(row: Row) => !row.missing && emit('focus', row.id)"
  >
    <el-table-column label="采样箱" min-width="150" fixed>
      <template #default="{ row }">
        <span class="swatch" :style="{ background: colors[row.id] }" />
        <el-link
          v-if="!row.missing"
          type="primary"
          @click.stop="router.push(`/device/boxes/${row.id}`)"
        >
          {{ row.name || row.id }}
        </el-link>
        <span v-else class="muted">{{ row.id }}（已删除）</span>
      </template>
    </el-table-column>
    <el-table-column label="所属 · 保管人" min-width="130">
      <template #default="{ row }">
        <div>{{ row.org || "—" }}</div>
        <div class="muted">{{ row.owner && row.owner !== "—" ? row.owner : "无保管人" }}</div>
      </template>
    </el-table-column>
    <el-table-column v-if="hasStatus" label="电量" width="120">
      <template #default="{ row }">
        <template v-if="row.status">
          <el-progress
            v-if="row.status.batteryUsable != null"
            :percentage="row.status.batteryUsable"
            :stroke-width="6"
            :color="batteryColor(row.status.batteryUsable)"
            :format="(p: number) => `${p}%`"
          />
          <span v-else>{{ row.status.battery || "—" }}</span>
          <div v-if="row.status.charge === 1 || row.status.charge === 2" class="muted">
            {{ row.status.charge === 2 ? "已充满" : "充电中" }}
          </div>
        </template>
        <span v-else class="muted">—</span>
      </template>
    </el-table-column>
    <el-table-column v-if="hasStatus" label="箱盖" width="70">
      <template #default="{ row }">
        <el-tag v-if="row.status?.lid === 1" type="danger" size="small">开着</el-tag>
        <el-tag v-else-if="row.status?.lid === 0" type="success" size="small">关闭</el-tag>
        <span v-else class="muted">—</span>
      </template>
    </el-table-column>
    <el-table-column label="当前位置" min-width="200">
      <template #default="{ row }">
        <template v-if="row.position">
          <div class="pos-line">
            <span
              class="src"
              :class="row.position.source === 'GPS' ? 'is-gps' : 'is-lbs'"
              :title="
                row.position.source === '基站' ? '基站定位误差 500 米到几公里，距离仅供参考' : ''
              "
            >
              {{ row.position.source }}
            </span>
            <span class="addr" :title="row.address">
              {{ row.address || `${row.position.lng.toFixed(6)}, ${row.position.lat.toFixed(6)}` }}
            </span>
            <FreshTag v-if="row.position.at" class="age" :time="row.position.at" />
          </div>
          <div v-if="row.position.gpsAt" class="muted small">
            最后一次 GPS：{{ ageText(row.position.gpsAt) }}
          </div>
        </template>
        <span v-else class="muted">暂无位置</span>
      </template>
    </el-table-column>
    <el-table-column v-if="targetRole" :label="`距${targetRole}`" width="140">
      <template #default="{ row }">
        <span>{{ formatDistance(row.distanceM) }}</span>
        <el-tag v-if="row.near === true" type="success" size="small" class="tag">已到</el-tag>
        <el-tag v-else-if="row.near === false" type="warning" size="small" class="tag">未到</el-tag>
      </template>
    </el-table-column>
    <el-table-column
      :label="maxOpens != null ? `开箱（上限 ${maxOpens}）` : '任务期间开箱'"
      width="120"
    >
      <template #default="{ row }">
        <span v-if="row.opensDuring == null" class="muted">未开始</span>
        <template v-else>
          <span :class="{ danger: over(row as Row) }">{{ row.opensDuring }} 次</span>
          <el-tag v-if="over(row as Row)" type="danger" size="small" class="tag">超限</el-tag>
        </template>
      </template>
    </el-table-column>
    <el-table-column v-if="tracks.length" label="任务期间轨迹" width="150">
      <template #default="{ row }">
        <template v-if="row.track?.gpsCount">
          <div>{{ formatDistance(row.track.distanceM) }}</div>
          <div class="muted">
            {{ row.track.gpsCount }} 个 GPS 点{{
              row.track.lbsCount ? ` · ${row.track.lbsCount} 个基站点` : ""
            }}
          </div>
        </template>
        <span v-else-if="row.track?.lbsCount" class="muted">
          仅 {{ row.track.lbsCount }} 个基站点
        </span>
        <span v-else class="muted">无定位</span>
      </template>
    </el-table-column>
    <el-table-column v-if="inspect" label="检测" width="150" fixed="right">
      <template #default="{ row }">
        <template v-if="row.inspectedAt">
          <el-tag type="success" size="small">已开始检测</el-tag>
          <div class="muted" :title="fullTime(row.inspectedAt)">
            {{ ago(row.inspectedAt) }}{{ row.inspectedBy ? ` · ${row.inspectedBy}` : "" }}
          </div>
        </template>
        <el-button
          v-else-if="canInspect && !row.missing"
          size="small"
          type="primary"
          :loading="busyId === row.id"
          @click.stop="emit('inspect', row.id)"
        >
          开始检测
        </el-button>
        <span v-else class="muted">{{ waitingText }}</span>
      </template>
    </el-table-column>
    <el-table-column label="最近上报" width="110">
      <template #default="{ row }">
        <span :title="fullTime(row.last)">{{ ago(row.last) }}</span>
      </template>
    </el-table-column>
  </el-table>
</template>

<script setup lang="ts">
import { formatDistance, type TaskBox, type TaskTrack } from "@/api/sample/report-policy";
import FreshTag from "@/components/biz/FreshTag.vue";
import { ageText } from "@/utils/position";
import { ago, fullTime } from "@/utils/time";

/** 任务里的箱子：所属、电量、箱盖、位置、到达、开箱次数和任务期间轨迹。点一行在地图上定位。 */
const props = defineProps<{
  boxes: TaskBox[];
  tracks: TaskTrack[];
  colors: Record<string, string>;
  targetRole?: string;
  maxOpens?: number | null;
  activeId?: string;
  /** 送检测站的单：显示「检测」列；canInspect 时没检测的箱子有「开始检测」按钮。 */
  inspect?: boolean;
  canInspect?: boolean;
  busyId?: string;
  waitingText?: string;
}>();
const emit = defineEmits<{ focus: [boxId: string]; inspect: [boxId: string] }>();
const router = useRouter();

type Row = TaskBox & { track?: TaskTrack };
const rows = computed<Row[]>(() =>
  props.boxes.map((box) => ({ ...box, track: props.tracks.find((t) => t.boxId === box.id) }))
);
const hasStatus = computed(() => props.boxes.some((b) => b.status));

function over(row: Row) {
  return props.maxOpens != null && row.opensDuring != null && row.opensDuring > props.maxOpens;
}
function batteryColor(p: number) {
  return p < 20 ? "#dc2626" : p < 50 ? "#ea580c" : "#16a34a";
}
function rowClass({ row }: { row: Row }) {
  return [row.missing ? "" : "clickable", row.id === props.activeId ? "active" : ""].join(" ");
}
</script>

<style scoped>
.swatch {
  display: inline-block;
  width: 8px;
  height: 8px;
  margin-right: 6px;
  vertical-align: 1px;
  border-radius: 2px;
}
.muted {
  font-size: 12px;
  line-height: 1.5;
  color: var(--el-text-color-secondary);
}
.pos-line {
  display: flex;
  gap: 6px;
  align-items: center;
  min-width: 0;
}
.addr {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.age {
  flex-shrink: 0;
  font-size: 12px;
}
.src {
  flex-shrink: 0;
  padding: 0 5px;
  font-size: 11px;
  font-weight: 600;
  line-height: 18px;
  border-radius: 4px;
}
.src.is-gps {
  color: var(--loc-gps);
  background: var(--loc-gps-bg);
}
.src.is-lbs {
  color: var(--loc-lbs);
  background: var(--loc-lbs-bg);
}
.tag {
  margin-left: 4px;
}
.danger {
  font-weight: 600;
  color: var(--el-color-danger);
}
:deep(.clickable) {
  cursor: pointer;
}
:deep(.active td.el-table__cell) {
  background: var(--el-color-primary-light-9);
}
</style>
