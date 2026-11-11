<template>
  <div class="page-container page-flow">
    <PageHeader
      title="创建任务单"
      back="/task/tasks"
      subtitle="分步填写，最后核对一遍再创建。离开页面前会提醒保存。"
    />
    <el-empty v-if="!canManage" description="当前角色没有「新建调拨任务」或「新建采样任务」权限" />
    <div v-else class="create-layout" :class="{ solo: !showSummary }">
      <el-card shadow="never" class="task-form">
        <el-steps :active="step" finish-status="success" align-center class="steps">
          <el-step
            v-for="(item, index) in steps"
            :key="item.key"
            :title="item.title"
            :class="{ jump: index < step }"
            @click="index < step && (step = index)"
          />
        </el-steps>

        <el-form
          label-width="110px"
          class="body"
          :class="{ wide: current === 'boxes' || current === 'review' }"
        >
          <template v-if="current === 'basic'">
            <el-form-item label="任务类型">
              <el-radio-group v-model="form.kind">
                <el-radio-button value="调拨" :disabled="!canTransfer">调拨</el-radio-button>
                <el-radio-button value="采样" :disabled="!canSample">采样</el-radio-button>
              </el-radio-group>
              <p class="tip">
                {{
                  form.kind === "调拨"
                    ? "把采样箱从一个单位寄到另一个单位，由接收单位签收，签收后箱子归接收单位。"
                    : "安排采样箱到采样单位采样。箱子的归属不变。"
                }}
              </p>
            </el-form-item>
            <el-form-item v-if="form.kind === '采样'" label="寄送方式">
              <el-radio-group v-model="form.trip">
                <el-radio-button value="双向">双向</el-radio-button>
                <el-radio-button value="单向">单向</el-radio-button>
                <el-radio-button value="">不寄送</el-radio-button>
              </el-radio-group>
              <p class="tip">
                {{ TRIP_TEXT[form.trip] || "箱子已经在采样单位，直接采样，封箱后寄回核验。" }}
              </p>
            </el-form-item>
            <el-form-item label="任务名称" required :error="errors.name">
              <el-input
                v-model="form.name"
                maxlength="120"
                placeholder="比如：深圳仓 → 华东中心 第 3 批"
              />
            </el-form-item>
            <el-form-item label="备注">
              <el-input
                v-model="form.note"
                type="textarea"
                :rows="3"
                maxlength="1000"
                placeholder="选填"
              />
            </el-form-item>
          </template>

          <template v-else-if="current === 'from'">
            <el-form-item label="寄出单位" required :error="errors.fromOrgId">
              <el-select
                v-model="form.fromOrgId"
                filterable
                placeholder="选择寄出单位"
                style="width: 100%"
              >
                <el-option
                  v-for="o in orgs"
                  :key="o.id"
                  :value="o.id"
                  :label="o.path"
                  :disabled="!o.inScope"
                />
              </el-select>
            </el-form-item>
            <el-form-item label="寄出人" required :error="errors.sender">
              <el-select
                v-model="senderPick"
                filterable
                allow-create
                default-first-option
                placeholder="选择人员，或直接输入姓名"
                style="width: 100%"
                :disabled="!form.fromOrgId"
              >
                <el-option v-for="u in fromUsers" :key="u.id" :value="`u:${u.id}`" :label="u.name">
                  <span>{{ u.name }}</span>
                  <span class="dept">{{ u.dept }}</span>
                </el-option>
              </el-select>
            </el-form-item>
            <el-alert
              v-if="outside.length"
              type="warning"
              :closable="false"
              class="indent"
              :title="`${outside.join('、')} 不在「${orgById(form.fromOrgId)?.name}」及其上下级里，确认要从这里调出吗？`"
            />
            <el-form-item label="寄出地址">
              <PlaceField
                v-if="form.fromOrgId"
                v-model="form.fromPlace"
                :org="orgById(form.fromOrgId)"
                :default-radius="arriveRadius"
              />
              <span v-else class="tip">先选寄出单位</span>
            </el-form-item>
          </template>

          <template v-else-if="current === 'to'">
            <el-form-item label="接收单位" required :error="errors.toOrgId">
              <el-select
                v-model="form.toOrgId"
                filterable
                placeholder="选择接收单位"
                style="width: 100%"
              >
                <el-option
                  v-for="o in orgs"
                  :key="o.id"
                  :value="o.id"
                  :label="o.path"
                  :disabled="o.id === form.fromOrgId"
                />
              </el-select>
            </el-form-item>
            <el-form-item label="签收人" required :error="errors.signer">
              <el-select
                v-model="signerPick"
                filterable
                allow-create
                default-first-option
                placeholder="选择人员，或直接输入姓名"
                style="width: 100%"
                :disabled="!form.toOrgId"
              >
                <el-option v-for="u in toUsers" :key="u.id" :value="`u:${u.id}`" :label="u.name">
                  <span>{{ u.name }}</span>
                  <span class="dept">{{ u.dept }}</span>
                </el-option>
              </el-select>
              <p class="tip">
                默认是接收单位的负责人。只有接收单位的人员能签收；签收后箱子改归接收单位，选了系统用户作签收人时由他保管。
              </p>
            </el-form-item>
            <el-form-item label="收货地址">
              <PlaceField
                v-if="form.toOrgId"
                v-model="form.toPlace"
                :org="orgById(form.toOrgId)"
                :default-radius="arriveRadius"
              />
              <span v-else class="tip">先选接收单位</span>
            </el-form-item>
          </template>

          <template v-else-if="current === 'sample'">
            <el-form-item label="采样单位" :required="Boolean(form.trip)" :error="errors.orgId">
              <el-select
                v-model="form.orgId"
                filterable
                clearable
                :placeholder="form.trip ? '选择箱子寄到的采样单位' : '选填，选了可直接用单位地址'"
                style="width: 100%"
              >
                <el-option
                  v-for="o in orgs"
                  :key="o.id"
                  :value="o.id"
                  :label="o.path"
                  :disabled="Boolean(form.trip) && o.id === form.fromOrgId"
                >
                  <span>{{ o.path }}</span>
                  <el-tag v-if="o.type === '采样机构'" size="small" type="success" class="tag">
                    采样机构
                  </el-tag>
                </el-option>
              </el-select>
            </el-form-item>
            <el-form-item label="开箱录像">
              <el-switch v-model="form.recordVideo" :disabled="!isAgency" />
              <p class="tip">
                {{
                  isAgency
                    ? "开启后，任务进行中箱子每次在计划地点（误差范围内）开箱，服务器会通知视频平台录像，录像显示在任务详情里。"
                    : "只有采样单位是「采样机构」时才能开启。机构类型在「组织管理 › 部门」里设置。"
                }}
              </p>
            </el-form-item>
            <el-form-item label="计划地点">
              <PlaceField
                :key="form.orgId || 'none'"
                v-model="form.placeAt"
                :org="orgById(form.orgId)"
                :default-radius="arriveRadius"
              />
            </el-form-item>
            <el-form-item label="样品">
              <el-input v-model="form.sample" maxlength="1000" placeholder="名称、批号、数量" />
            </el-form-item>
            <el-form-item label="授权人员">
              <el-select
                v-model="peoplePick"
                multiple
                filterable
                allow-create
                default-first-option
                placeholder="选采样单位里的人，也可以直接输入姓名"
                style="width: 100%"
                :disabled="!form.orgId"
              >
                <el-option v-for="u in sampleUsers" :key="u.id" :value="u.name" :label="u.name">
                  <span>{{ u.name }}</span>
                  <span class="dept">{{ u.dept }}</span>
                </el-option>
              </el-select>
            </el-form-item>
          </template>

          <template v-else-if="current === 'boxes'">
            <el-form-item label="绑定采样箱" required :error="errors.boxIds">
              <BoxPicker v-model="form.boxIds" v-model:boxes="chosenBoxes" />
            </el-form-item>
            <el-alert
              v-if="boxOrgs.length > 1"
              type="info"
              :closable="false"
              class="indent"
              :title="`选中的箱子分属 ${boxOrgs.join('、')}，调拨单只能写一个寄出单位，请确认`"
            />
            <el-form-item label="开箱次数上限">
              <div class="limit">
                <el-switch
                  v-model="limitOpens"
                  inline-prompt
                  active-text="限制"
                  inactive-text="不限"
                />
                <template v-if="limitOpens">
                  <span>每台最多开箱</span>
                  <el-input-number
                    v-model="maxOpens"
                    :min="0"
                    :max="999"
                    size="small"
                    controls-position="right"
                  />
                  <span>次</span>
                </template>
              </div>
              <p class="tip">
                从任务开始到结束，按箱子上报的开箱次数计算；超过上限会在任务列表和详情里标红。{{
                  form.kind === "调拨"
                    ? "调拨途中一般不该开箱，可设为 0。"
                    : "采样一般开一次装样、一次封箱，可按流程设置。"
                }}
              </p>
            </el-form-item>
          </template>

          <template v-else-if="current === 'review'">
            <el-alert
              type="info"
              :closable="false"
              class="review-tip"
              title="请核对以下内容，确认无误后创建。点「修改」回到对应步骤。"
            />
            <div class="review">
              <section>
                <header>
                  <b>基本信息</b>
                  <el-button link type="primary" @click="goto('basic')">修改</el-button>
                </header>
                <dl>
                  <dt>类型</dt>
                  <dd>{{ form.kind }}</dd>
                  <dt>名称</dt>
                  <dd>{{ form.name }}</dd>
                  <dt>备注</dt>
                  <dd>{{ form.note || "—" }}</dd>
                </dl>
              </section>
              <template v-if="form.kind === '调拨'">
                <section>
                  <header>
                    <b>寄出方</b>
                    <el-button link type="primary" @click="goto('from')">修改</el-button>
                  </header>
                  <dl>
                    <dt>单位</dt>
                    <dd>{{ orgById(form.fromOrgId)?.path }}</dd>
                    <dt>寄出人</dt>
                    <dd>
                      {{ form.sender }}
                      <el-tag v-if="!form.senderId" size="small" type="info" class="tag">
                        外部人员
                      </el-tag>
                    </dd>
                    <dt>地址</dt>
                    <dd>{{ placeText(form.fromPlace) }}</dd>
                  </dl>
                </section>
                <section>
                  <header>
                    <b>接收方</b>
                    <el-button link type="primary" @click="goto('to')">修改</el-button>
                  </header>
                  <dl>
                    <dt>单位</dt>
                    <dd>{{ orgById(form.toOrgId)?.path }}</dd>
                    <dt>签收人</dt>
                    <dd>
                      {{ form.signer }}
                      <el-tag v-if="!form.signerId" size="small" type="info" class="tag">
                        外部人员
                      </el-tag>
                    </dd>
                    <dt>地址</dt>
                    <dd>{{ placeText(form.toPlace) }}</dd>
                  </dl>
                </section>
              </template>
              <section v-if="form.kind === '采样' && form.trip">
                <header>
                  <b>寄出方</b>
                  <el-button link type="primary" @click="goto('from')">修改</el-button>
                </header>
                <dl>
                  <dt>单位</dt>
                  <dd>{{ orgById(form.fromOrgId)?.path }}</dd>
                  <dt>寄出人</dt>
                  <dd>
                    {{ form.sender }}
                    <el-tag v-if="!form.senderId" size="small" type="info" class="tag">
                      外部人员
                    </el-tag>
                  </dd>
                  <dt>地址</dt>
                  <dd>{{ placeText(form.fromPlace) }}</dd>
                  <dt>寄送方式</dt>
                  <dd>{{ form.trip }}：{{ TRIP_TEXT[form.trip] }}</dd>
                </dl>
              </section>
              <section v-if="form.kind === '采样'">
                <header>
                  <b>采样安排</b>
                  <el-button link type="primary" @click="goto('sample')">修改</el-button>
                </header>
                <dl>
                  <dt>采样单位</dt>
                  <dd>{{ orgById(form.orgId)?.path || "—" }}</dd>
                  <dt>计划地点</dt>
                  <dd>{{ placeText(form.placeAt) }}</dd>
                  <dt>样品</dt>
                  <dd>{{ form.sample || "—" }}</dd>
                  <dt>授权人员</dt>
                  <dd>{{ form.people || "—" }}</dd>
                  <dt>开箱录像</dt>
                  <dd>{{ form.recordVideo ? "开启" : "不录" }}</dd>
                </dl>
              </section>
              <section>
                <header>
                  <b>采样箱</b>
                  <el-button link type="primary" @click="goto('boxes')">修改</el-button>
                </header>
                <dl>
                  <dt>采样箱</dt>
                  <dd>
                    {{ form.boxIds.length }} 台：{{ boxNames }}
                    <div v-if="outside.length" class="warn">
                      {{ outside.join("、") }} 不在寄出单位及其上下级里
                    </div>
                  </dd>
                  <dt>开箱上限</dt>
                  <dd>{{ limitOpens ? `每台最多 ${maxOpens} 次` : "不限" }}</dd>
                </dl>
              </section>
              <section>
                <header>
                  <b>高级设置 · 任务期间上报策略</b>
                  <el-button
                    v-if="canPolicy"
                    link
                    type="primary"
                    @click="advancedOpen = !advancedOpen"
                  >
                    {{ advancedOpen ? "收起" : "修改" }}
                  </el-button>
                </header>
                <dl>
                  <dt>策略</dt>
                  <dd>{{ policyText }}</dd>
                </dl>
              </section>
            </div>
          </template>
          <template v-if="current === 'review' && advancedOpen && canPolicy">
            <el-divider content-position="left">任务期间上报策略</el-divider>
            <el-form-item label="统一设置">
              <el-radio-group v-model="custom">
                <el-radio :value="false">继承现有配置</el-radio>
                <el-radio :value="true">本任务统一设置</el-radio>
              </el-radio-group>
            </el-form-item>
            <el-form-item v-if="custom"><PolicyFields v-model="policy" task /></el-form-item>
            <el-alert
              title="1.0.17 配套设备按派单时的配置执行。在线时主动下发，离线时等下一次上报。旧版设备在任务开始后随上报领取配置。长期单箱设置优先于任务统一设置。"
              type="info"
              :closable="false"
            />
            <p v-if="previewFailed">
              部分箱子的策略读取失败。
              <el-button link @click="refreshPreview">重新读取</el-button>
            </p>
            <p v-if="!canReadPolicy">
              当前账号无法查看长期单箱设置。新建单箱例外时请填写完整策略。
            </p>
            <el-table
              v-if="form.boxIds.length"
              :data="form.boxIds.map((id) => ({ id }))"
              class="preview"
            >
              <el-table-column prop="id" label="采样箱" width="140" />
              <el-table-column label="任务期间预计策略">
                <template #default="{ row }">{{ effective(row.id) }}</template>
              </el-table-column>
              <el-table-column label="单箱例外" width="170">
                <template #default="{ row }">
                  <el-button
                    link
                    :disabled="canReadPolicy && !states[row.id] && !form.overrides[row.id]"
                    @click="editBoxPolicy(row.id)"
                  >
                    单独设置
                  </el-button>
                  <el-button
                    v-if="form.overrides[row.id]"
                    link
                    type="danger"
                    @click="delete form.overrides[row.id]"
                  >
                    清除
                  </el-button>
                </template>
              </el-table-column>
            </el-table>
          </template>
        </el-form>

        <div class="actions">
          <el-button @click="router.push('/task/tasks')">放弃</el-button>
          <div class="grow"></div>
          <el-button v-if="step > 0" @click="step--">上一步</el-button>
          <el-button v-if="current !== 'review'" type="primary" @click="next">下一步</el-button>
          <el-button v-else type="primary" :loading="saving" @click="submit">确认创建</el-button>
        </div>
      </el-card>
      <aside v-if="showSummary" class="summary">
        <SectionCard title="任务摘要" sub="边填边看，最后一步再核对">
          <InfoList :items="summaryItems" label-width="64px" />
        </SectionCard>
      </aside>
    </div>
    <el-dialog
      v-model="editOpen"
      :title="`${editId} · 任务内单箱策略`"
      width="540px"
      style="max-width: 94vw"
    >
      <PolicyFields v-model="editPolicy" task />
      <template #footer>
        <el-button
          type="primary"
          @click="
            form.overrides[editId] = { ...editPolicy };
            editOpen = false;
          "
        >
          确认
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>
<script setup lang="ts">
import { ElMessage } from "element-plus";
import type { Ref } from "vue";
import API, {
  policyPerm,
  type Place,
  type Policy,
  type PolicyState,
  type TaskCreate,
  type TaskOrg,
} from "@/api/sample/report-policy";
import type { SampleBox } from "../data";
import PolicyFields from "../boxes/PolicyFields.vue";
import PlaceField from "./PlaceField.vue";
import BoxPicker from "./BoxPicker.vue";
import { radiusText } from "./radius";
import { TRIP_TEXT } from "./status";
import { useUserStore } from "@/stores/user";
import SampleBoxAPI from "@/api/sample/box";
import PageHeader from "@/components/biz/PageHeader.vue";
import InfoList, { type InfoItem } from "@/components/biz/InfoList.vue";
import SectionCard from "@/components/biz/SectionCard.vue";

type Person = { id: string; name: string; dept: string };
type StepKey = "basic" | "boxes" | "from" | "to" | "sample" | "policy" | "review";
const router = useRouter(),
  route = useRoute(),
  user = useUserStore();
// 新建调拨、新建采样、任务期间上报策略分开授权
const canTransfer = computed(() => Boolean(user.userInfo.perms?.includes("task:create:transfer")));
const canSample = computed(() => Boolean(user.userInfo.perms?.includes("task:create:sample")));
const canPolicy = computed(() => Boolean(user.userInfo.perms?.includes(policyPerm.task)));
const canReadPolicy = computed(() => Boolean(user.userInfo.perms?.includes(policyPerm.read)));
const previewFailed = ref(false);
let previewRequest = 0;
const canManage = computed(() => canTransfer.value || canSample.value);
const form = reactive({
  name: "",
  kind: route.query.type === "调拨" ? "调拨" : "采样",
  boxIds: [] as string[],
  overrides: {} as Record<string, Policy>,
  fromOrgId: "",
  toOrgId: "",
  sender: "",
  senderId: "",
  signer: "",
  signerId: "",
  fromPlace: null as Place | null,
  toPlace: null as Place | null,
  orgId: "",
  placeAt: null as Place | null,
  people: "",
  sample: "",
  note: "",
  recordVideo: false,
  trip: "双向" as "" | "单向" | "双向",
});
if (
  !user.userInfo.perms?.includes("task:create:sample") &&
  user.userInfo.perms?.includes("task:create:transfer")
)
  form.kind = "调拨";
if (
  !user.userInfo.perms?.includes("task:create:transfer") &&
  user.userInfo.perms?.includes("task:create:sample")
)
  form.kind = "采样";
/** 各步骤的字段错误，显示在对应输入框下面。 */
const errors = reactive<Record<string, string>>({});
const advancedOpen = ref(false);
const saved = ref(false);
const sampleUsers = ref<Person[]>([]);
const peoplePick = computed({
  get: () => (form.people ? form.people.split("、").filter(Boolean) : []),
  set: (names: string[]) => {
    form.people = names
      .map((n) => n.trim())
      .filter(Boolean)
      .join("、");
  },
});
const isAgency = computed(() => orgById(form.orgId)?.type === "采样机构");
watch(
  () => form.orgId,
  (id) => void loadUsers(id, sampleUsers)
);
const boxNames = computed(() =>
  form.boxIds.map((id) => chosenBoxes.value.find((b) => b.id === id)?.name || id).join("、")
);
const dirty = computed(() => Boolean(form.name || form.boxIds.length || form.note));
onBeforeRouteLeave(async () => {
  if (saved.value || !dirty.value) return true;
  try {
    await ElMessageBox.confirm("填写的内容还没创建，离开后会丢失。", "离开创建页", {
      type: "warning",
      confirmButtonText: "离开",
      cancelButtonText: "继续填写",
    });
    return true;
  } catch {
    return false;
  }
});
const custom = ref(false),
  policy = ref<Policy>({ reportPeriodSec: 60, reportOnlyWhenCharging: false });
const saving = ref(false),
  states = reactive<Record<string, PolicyState>>({});
const chosenBoxes = ref<SampleBox[]>([]);
const myOrgId = ref("");
// 换了箱子就重新取它们现在的策略，给「上报策略」那一步预览
watch(
  () => form.boxIds.join(","),
  () => void refreshPreview()
);
const editOpen = ref(false),
  editId = ref(""),
  editPolicy = ref<Policy>({ ...policy.value });
const arriveRadius = ref(2000);
const limitOpens = ref(false),
  maxOpens = ref(0);
// 调拨途中一般不该开箱，打开限制时调拨默认 0 次、采样默认 2 次
watch(limitOpens, (on) => {
  if (on) maxOpens.value = form.kind === "调拨" ? 0 : 2;
});
const orgs = ref<TaskOrg[]>([]),
  fromUsers = ref<Person[]>([]),
  toUsers = ref<Person[]>([]);
// 采样单位不是采样机构时不能要求录像
watch(isAgency, (on) => {
  if (!on) form.recordVideo = false;
});

/**
 * 分步填写。先选箱子，寄出单位就能按箱子的归属自动带出：
 * 调拨是 基本 → 采样箱 → 寄出方 → 接收方 → 确认；采样是 基本 → 采样箱 →（要寄送时）寄出方 → 采样安排 → 确认。
 */
const steps = computed<{ key: StepKey; title: string }[]>(() =>
  form.kind === "调拨"
    ? [
        { key: "basic", title: "基本信息" },
        { key: "boxes", title: "采样箱" },
        { key: "from", title: "寄出方" },
        { key: "to", title: "接收方" },
        { key: "review", title: "核对" },
      ]
    : form.trip
      ? [
          { key: "basic", title: "基本信息" },
          { key: "boxes", title: "采样箱" },
          { key: "from", title: "寄出方" },
          { key: "sample", title: "采样安排" },
          { key: "review", title: "核对" },
        ]
      : [
          { key: "basic", title: "基本信息" },
          { key: "boxes", title: "采样箱" },
          { key: "sample", title: "采样安排" },
          { key: "review", title: "核对" },
        ]
);
const step = ref(0);
const current = computed(() => steps.value[step.value]?.key || "basic");
/** 选箱子和核对这两步要整宽，不显示右边的摘要；核对页本身就是完整摘要。 */
const showSummary = computed(() => current.value !== "boxes" && current.value !== "review");
const summaryItems = computed<InfoItem[]>(() => {
  const ship = form.kind === "调拨" || Boolean(form.trip);
  const list: InfoItem[] = [
    {
      label: "类型",
      value: form.kind === "调拨" ? "调拨" : `采样 · ${form.trip ? `${form.trip}寄送` : "不寄送"}`,
    },
    { label: "名称", value: form.name.trim() || "—" },
    {
      label: "采样箱",
      value: form.boxIds.length ? `${form.boxIds.length} 台：${boxNames.value}` : "还没选",
    },
  ];
  if (ship)
    list.push({
      label: "寄出",
      value: [orgById(form.fromOrgId)?.name, form.sender].filter(Boolean).join(" · ") || "—",
    });
  if (form.kind === "调拨")
    list.push({
      label: "接收",
      value: [orgById(form.toOrgId)?.name, form.signer].filter(Boolean).join(" · ") || "—",
    });
  else
    list.push(
      { label: "采样单位", value: orgById(form.orgId)?.name || "—" },
      { label: "地点", value: form.placeAt ? placeText(form.placeAt) : "—" }
    );
  return list;
});
function goto(key: StepKey) {
  const index = steps.value.findIndex((s) => s.key === key);
  if (index >= 0) step.value = index;
}

/** 当前这一步没填完时，在对应输入框下面标出原因，返回 false。 */
function checkStep(key: StepKey) {
  for (const name of Object.keys(errors)) delete errors[name];
  if (key === "basic" && !form.name.trim()) errors.name = "请填写任务名称";
  if (key === "from" && !form.fromOrgId) errors.fromOrgId = "请选择寄出单位";
  if (key === "from" && !form.sender) errors.sender = "请选择或填写寄出人";
  if (key === "to" && !form.toOrgId) errors.toOrgId = "请选择接收单位";
  if (key === "to" && form.toOrgId && form.toOrgId === form.fromOrgId)
    errors.toOrgId = "接收单位不能和寄出单位相同";
  if (key === "to" && !form.signer) errors.signer = "请选择或填写签收人";
  if (key === "boxes" && !form.boxIds.length) errors.boxIds = "请至少绑定一台采样箱";
  if (key === "sample" && form.trip && !form.orgId) errors.orgId = "寄送采样箱要选择采样单位";
  if (key === "sample" && form.trip && form.orgId && form.orgId === form.fromOrgId)
    errors.orgId = "采样单位不能和寄出单位相同";
  return !Object.keys(errors).length;
}
function next() {
  if (!checkStep(current.value)) return;
  if (current.value === "boxes" && (form.kind === "调拨" || form.trip) && !form.fromOrgId)
    form.fromOrgId = suggestedFrom();
  step.value = Math.min(step.value + 1, steps.value.length - 1);
}

/** 寄出单位默认取选中箱子共同的单位（在自己范围内才用），否则用自己所在单位。 */
function suggestedFrom() {
  const ids = [...new Set(chosenBoxes.value.map((box) => String(box.orgId || "")))];
  const common = ids.length === 1 && ids[0] ? orgById(ids[0]) : null;
  if (common?.inScope) return common.id;
  return orgs.value.find((o) => o.inScope && o.id === myOrgId.value)?.id || "";
}

function orgById(id?: string) {
  return orgs.value.find((o) => o.id === id) || null;
}

function placeText(place: Place | null) {
  if (!place) return "未填写";
  const parts = [place.address || "已定位，未填地址文字"];
  if (place.custom) parts.push("自定义");
  parts.push(
    place.lng == null
      ? "无坐标，不能自动判断到达"
      : `误差范围 ${radiusText(place.radiusM ?? arriveRadius.value)}`
  );
  return parts.join(" · ");
}
const policyText = computed(() => {
  const base = custom.value
    ? `本任务统一 ${policy.value.reportPeriodSec} 秒 · ${policy.value.reportOnlyWhenCharging ? "仅充电时" : "持续定时"}`
    : "继承现有配置";
  const count = Object.keys(form.overrides).length;
  return count ? `${base}；${count} 台单箱例外` : base;
});

/** 人员选择：u:编号 是系统用户，其他是手填的外部人员姓名。 */
function personModel(
  nameKey: "sender" | "signer",
  idKey: "senderId" | "signerId",
  list: Ref<Person[]>
) {
  return computed({
    get: () => (form[idKey] ? `u:${form[idKey]}` : form[nameKey]),
    set: (value: string) => {
      const found = value?.startsWith("u:")
        ? list.value.find((u) => u.id === value.slice(2))
        : null;
      form[idKey] = found?.id || "";
      form[nameKey] = found?.name || (value || "").trim();
    },
  });
}
const senderPick = personModel("sender", "senderId", fromUsers);
const signerPick = personModel("signer", "signerId", toUsers);

async function loadUsers(orgId: string, target: Ref<Person[]>) {
  target.value = orgId ? (await API.taskOptions(orgId)).users : [];
}
// 寄出人默认是自己（自己在寄出单位里时）
watch(
  () => form.fromOrgId,
  async (id) => {
    form.sender = "";
    form.senderId = "";
    await loadUsers(id, fromUsers);
    const me = fromUsers.value.find((u) => u.id === String(user.userInfo.userId || ""));
    if (me && !form.sender) Object.assign(form, { sender: me.name, senderId: me.id });
  }
);
// 签收人默认是接收单位的负责人
watch(
  () => form.toOrgId,
  async (id) => {
    const lead = orgById(id)?.leader;
    form.signer = lead?.name || "";
    form.signerId = lead?.id || "";
    await loadUsers(id, toUsers);
    if (lead && !toUsers.value.some((u) => u.id === lead.id))
      toUsers.value = [
        { id: lead.id, name: lead.name, dept: orgById(id)?.path || "" },
        ...toUsers.value,
      ];
  }
);
// 换任务类型后步骤不同，回到第一步
watch(
  () => form.kind,
  () => {
    step.value = 0;
  }
);

/**
 * 绑定的箱子里，单位既不是寄出单位的下级、也不是它的上级的。
 * 箱子挂在上级（比如挂在总公司、从总公司下的部门寄出）算正常；还没分配单位的箱子不提示。
 */
const outside = computed(() => {
  if ((form.kind !== "调拨" && !form.trip) || !form.fromOrgId) return [];
  const root = orgById(form.fromOrgId);
  if (!root) return [];
  return chosenBoxes.value
    .filter((box) => {
      const org = box.orgId ? orgById(String(box.orgId)) : null;
      if (!org) return false;
      const related =
        org.id === root.id ||
        org.path.startsWith(`${root.path} / `) ||
        root.path.startsWith(`${org.path} / `);
      return !related;
    })
    .map((box) => box.id);
});
/** 选中的箱子分属哪些单位（未分配的算总公司）。 */
const boxOrgs = computed(() => [
  ...new Set(
    chosenBoxes.value.map((box) => (box.orgId ? box.org : `${box.org || "总公司"}（未分配）`))
  ),
]);

async function refreshPreview() {
  const request = ++previewRequest;
  previewFailed.value = false;
  for (const id of Object.keys(form.overrides))
    if (!form.boxIds.includes(id)) delete form.overrides[id];
  for (const id of Object.keys(states)) if (!form.boxIds.includes(id)) delete states[id];
  if (!canReadPolicy.value) return;
  await Promise.all(
    form.boxIds.map(async (id) => {
      try {
        const state = await API.get(id);
        if (request === previewRequest) states[id] = state;
      } catch {
        if (request === previewRequest) {
          delete states[id];
          previewFailed.value = true;
        }
      }
    })
  );
}
function policyForBox(id: string): Policy | undefined {
  const s = states[id];
  return (
    form.overrides[id] ||
    s?.single ||
    (custom.value ? policy.value : null) ||
    s?.batch ||
    s?.effective
  );
}
function editBoxPolicy(id: string) {
  const base =
    policyForBox(id) ||
    (!canReadPolicy.value ? { reportPeriodSec: 60, reportOnlyWhenCharging: false } : null);
  if (!base) return;
  editId.value = id;
  editPolicy.value = { ...base };
  editOpen.value = true;
}
function effective(id: string) {
  const s = states[id],
    p = policyForBox(id);
  if (!p) return "继承现有配置（当前未读取到单箱策略）";
  const source = form.overrides[id]
    ? "任务内单箱"
    : s?.single
      ? "长期单箱"
      : custom.value
        ? s
          ? "任务统一"
          : "任务统一，单箱优先级待确认"
        : s?.batch
          ? "批量设置"
          : "系统默认";
  return `${p.reportPeriodSec} 秒 · ${p.reportOnlyWhenCharging ? "仅充电时" : "持续定时"} · ${p.periodicGps === false ? "关闭卫星定位" : "随定时上报定位"} · ${source}`;
}

async function submit() {
  // 总览页上再整体校验一遍，防止回头改了前面的步骤
  for (const item of steps.value) {
    if (!checkStep(item.key)) return goto(item.key);
  }
  const transfer = form.kind === "调拨";
  const data: TaskCreate = {
    name: form.name.trim(),
    kind: form.kind,
    boxIds: form.boxIds,
    overrides: canPolicy.value ? form.overrides : {},
    policy: canPolicy.value && custom.value ? policy.value : null,
    note: form.note,
    maxOpens: limitOpens.value ? maxOpens.value : null,
    ...(transfer
      ? {
          fromOrgId: form.fromOrgId,
          toOrgId: form.toOrgId,
          sender: form.sender,
          senderId: form.senderId,
          signer: form.signer,
          signerId: form.signerId,
          fromPlace: form.fromPlace,
          toPlace: form.toPlace,
        }
      : {
          orgId: form.orgId,
          placeAt: form.placeAt,
          people: form.people,
          sample: form.sample,
          recordVideo: form.recordVideo,
          ...(form.trip
            ? {
                trip: form.trip,
                fromOrgId: form.fromOrgId,
                sender: form.sender,
                senderId: form.senderId,
                fromPlace: form.fromPlace,
              }
            : {}),
        }),
  };
  saving.value = true;
  try {
    const { id } = await API.createTask(data);
    saved.value = true;
    ElMessage.success("任务已创建");
    await router.push(`/task/detail/${id}`);
  } finally {
    saving.value = false;
  }
}

onMounted(async () => {
  if (!canManage.value) return;
  const loaded = await API.taskOptions();
  orgs.value = loaded.orgs;
  arriveRadius.value = loaded.arriveRadiusM;
  myOrgId.value = loaded.myOrgId;
  // 从箱子详情、工作台跳过来时带着 ?boxIds=，先选好
  const preset = String(route.query.boxIds || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
    .slice(0, 100);
  if (preset.length) {
    const found = await Promise.all(
      preset.map((id) => SampleBoxAPI.detail(encodeURIComponent(id)).catch(() => null))
    );
    chosenBoxes.value = found.filter((box): box is SampleBox => box !== null);
    form.boxIds = chosenBoxes.value.map((box) => box.id);
  }
});
</script>
<style scoped>
/* 卡片铺开到 1280px：选箱表格、核对页要宽；填写类的步骤输入框收在 720px 内，不拉得太长 */
.create-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 300px;
  gap: var(--page-gap);
  align-items: start;
}
.create-layout.solo {
  grid-template-columns: minmax(0, 1fr);
}
.summary {
  position: sticky;
  top: 0;
}
@media (max-width: 1100px) {
  .create-layout {
    grid-template-columns: minmax(0, 1fr);
  }
  .summary {
    position: static;
  }
}
.task-form {
  min-width: 0;
}
.task-form :deep(.el-card__body) {
  padding: 24px 28px;
}
.steps {
  max-width: 960px;
  margin: 4px auto 32px;
}
.steps :deep(.jump) {
  cursor: pointer;
}
.body {
  min-height: 320px;
}
.body:not(.wide) :deep(.el-form-item__content) {
  max-width: 720px;
}
.preview {
  margin: 16px 0 8px;
}
.dept {
  float: right;
  margin-left: 12px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.tip {
  width: 100%;
  margin: 6px 0 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--el-text-color-secondary);
}
.indent {
  width: auto;
  margin: -6px 0 16px 110px;
}
.actions {
  display: flex;
  gap: 8px;
  align-items: center;
  padding-top: 16px;
  margin-top: 8px;
  border-top: 1px solid var(--el-border-color-lighter);
}
.grow {
  flex: 1;
}
.limit {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
.review-tip {
  margin-bottom: 16px;
}
.review {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(420px, 1fr));
  gap: 12px;
}
.review section {
  padding: 12px 16px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 6px;
}
.review header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}
.review dl {
  display: grid;
  grid-template-columns: 80px 1fr;
  gap: 6px 12px;
  margin: 0;
}
.review dt {
  color: var(--el-text-color-secondary);
}
.review dd {
  margin: 0;
  word-break: break-all;
}
.tag {
  margin-left: 6px;
}
.warn {
  font-size: 12px;
  color: var(--el-color-warning);
}
@media (max-width: 640px) {
  .indent {
    margin-left: 0;
  }
  .review {
    grid-template-columns: 1fr;
  }
  .review dl {
    grid-template-columns: 64px 1fr;
  }
  .task-form :deep(.el-card__body) {
    padding: 16px;
  }
}
</style>
