<template>
  <div class="page-container page-flow">
    <PageHeader
      title="创建任务单"
      back="/task/tasks"
      subtitle="分步填写，最后核对一遍再创建。离开页面前会提醒保存。"
    />
    <el-alert
      v-if="optionsFailed"
      type="warning"
      class="init-alert"
      show-icon
      :closable="false"
      title="单位列表没取到，创建页暂时填不下去。"
      data-test="create-options-error"
    >
      <el-button link type="primary" @click="init">重新加载</el-button>
    </el-alert>
    <p v-else-if="presetMissing" class="tip" data-test="create-boxes-missing">
      带过来的采样箱有 {{ presetMissing }} 台没取到（不在你的管理范围内或已删除），已跳过。
    </p>
    <el-empty v-if="!canManage" description="当前角色没有「新建采样任务 / 新建送检单」权限" />
    <div v-else class="create-layout" :class="{ solo: !showSummary }">
      <el-card shadow="never" class="task-form">
        <!-- R27：采样箱选了就一直挂在步骤条上方，每一步都看得见绑了哪几台（点标签或「修改」回第 2 步） -->
        <div class="box-strip" :class="{ idle: !boxChips.length }" data-test="create-box-strip">
          <template v-if="boxChips.length">
            <span class="box-strip-label">已选采样箱</span>
            <el-tag
              v-for="chip in boxChipsShown"
              :key="chip.id"
              size="small"
              effect="plain"
              :class="{ jump: canBackToBoxes }"
              :data-test="`create-box-chip-${chip.id}`"
              @click="backToBoxes"
            >
              {{ chip.text }}
            </el-tag>
            <span v-if="boxChipsRest" class="box-strip-more" data-test="create-box-chips-more">
              另 {{ boxChipsRest }} 台
            </span>
            <span class="box-strip-count">共 {{ boxChips.length }} 台</span>
            <el-button
              v-if="canBackToBoxes"
              link
              type="primary"
              size="small"
              data-test="create-box-strip-edit"
              @click="backToBoxes"
            >
              修改
            </el-button>
          </template>
          <span v-else class="box-strip-empty" data-test="create-box-strip-empty">未选采样箱</span>
        </div>
        <el-steps :active="step" finish-status="success" align-center class="steps">
          <el-step
            v-for="(item, index) in steps"
            :key="item.key"
            :title="item.title"
            :class="{ jump: index < step }"
            @click="index < step && (step = index)"
          />
        </el-steps>

        <!-- submit.prevent：「采样箱」这一步只有搜索框一个文本框，回车会触发浏览器默认提交、整页刷新，填的内容全丢 -->
        <el-form
          label-width="110px"
          class="body"
          :class="{ wide: current === 'boxes' || current === 'review' }"
          @submit.prevent
        >
          <template v-if="current === 'basic'">
            <el-form-item label="任务类型" required>
              <div class="kind-cards" data-test="create-kind-cards">
                <button
                  v-for="meta in KIND_META"
                  :key="meta.kind"
                  type="button"
                  class="kind-card"
                  :class="{ on: form.kind === meta.kind, disabled: !kindAllowed(meta.kind) }"
                  :disabled="!kindAllowed(meta.kind)"
                  :data-test="`create-kind-${meta.kind}`"
                  @click="pickKind(meta.kind)"
                >
                  <span class="kind-head">
                    <el-tag :type="kindTone(meta.kind)" effect="plain" size="small">
                      {{ meta.label }}
                    </el-tag>
                    <el-icon v-if="form.kind === meta.kind" class="check"><Check /></el-icon>
                  </span>
                  <span class="kind-desc">{{ meta.desc }}</span>
                  <span class="kind-flow">{{ meta.flow }}</span>
                </button>
              </div>
              <p class="tip">{{ kindFlowTip }}</p>
            </el-form-item>
            <el-form-item label="任务名称" required :error="errors.name">
              <el-input
                v-model="form.name"
                maxlength="120"
                placeholder="比如：华南分公司 第 3 批采样送检"
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
            <!-- R22：寄出方＝箱子当前归属，只读带出（双向＝检测站，单向＝分公司/总部）；R23 本地采样＝采样单位 -->
            <el-form-item
              :label="form.kind === '采样' ? '采样单位' : '寄出方'"
              data-test="create-from-readonly"
            >
              <div v-if="derivedFromText" class="station-fixed">
                <div class="station-line">
                  <b>{{ derivedFromOrg?.name || "总公司（未分配）" }}</b>
                  <el-tag size="small" type="info" effect="plain">按箱子归属带出 · 只读</el-tag>
                </div>
                <div v-if="derivedFromOrg" class="text-muted">{{ derivedFromOrg.path }}</div>
              </div>
              <span v-else class="tip">
                先在「采样箱」步选箱，{{
                  form.kind === "采样" ? "采样单位" : "寄出方"
                }}按箱子当前归属自动带出
              </span>
              <p v-if="form.kind === '采样'" class="tip">
                仅本地采样：封箱后任务结束，箱子留在该采样单位，不寄送检测站。
              </p>
            </el-form-item>
            <el-form-item
              v-if="trip && form.kind !== '采样'"
              label="寄送方向"
              data-test="create-trip-tag-from"
            >
              <el-tag :type="trip === '双向' ? 'warning' : 'success'" effect="plain" size="large">
                {{ trip }}
              </el-tag>
              <p class="tip">{{ tripText }}</p>
            </el-form-item>
            <el-form-item
              v-if="form.kind !== '采样'"
              label="采样单位"
              required
              :error="errors.fromOrgId"
            >
              <el-select
                v-model="form.fromOrgId"
                filterable
                placeholder="选择采样单位（分公司）"
                style="width: 100%"
              >
                <el-option
                  v-for="o in companyOrgs"
                  :key="o.id"
                  :value="o.id"
                  :label="o.path"
                  :disabled="!o.inScope"
                />
              </el-select>
              <p class="tip">
                采样单位可选分公司，默认箱归属分公司（箱在检测站时默认本单位）。单向＝本地采样后寄检测站；
                双向＝检测站把箱子寄到采样单位，采样封箱后寄回检测站。
              </p>
            </el-form-item>
            <el-form-item
              v-if="form.kind !== '采样'"
              label="寄出人"
              required
              :error="errors.sender"
            >
              <el-select
                v-model="senderPick"
                filterable
                allow-create
                default-first-option
                placeholder="选择人员，或直接输入姓名"
                style="width: 100%"
                :disabled="!chosenBoxes.length"
              >
                <el-option
                  v-for="u in senderUsers"
                  :key="u.id"
                  :value="`u:${u.id}`"
                  :label="u.name"
                >
                  <span>{{ u.name }}</span>
                  <span class="dept">{{ u.dept }}</span>
                </el-option>
              </el-select>
              <p class="tip">寄出人须是寄出方的人员（双向时＝检测站人员）。</p>
            </el-form-item>
            <el-alert
              v-if="outside.length && form.kind !== '采样'"
              type="warning"
              :closable="false"
              class="indent"
              :title="`${outside.join('、')} 不在寄出方「${derivedFromOrg?.name}」及其上下级里，确认要从这里寄出吗？`"
            />
            <el-form-item v-if="form.kind !== '采样'" label="寄出地址">
              <PlaceField
                v-if="form.fromOrgId"
                v-model="form.fromPlace"
                :org="derivedFromOrg || orgById(form.fromOrgId)"
                :default-radius="arriveRadius"
              />
              <span v-else class="tip">先选采样单位</span>
            </el-form-item>
          </template>

          <!-- R23 送检：寄出与接收一步（寄出方＝箱归属只读＋寄出人；接收方固定检测站＋签收人＋收货地址），无采样段 -->
          <template v-else-if="current === 'send'">
            <el-form-item label="寄出方" data-test="create-send-from">
              <div v-if="derivedFromText" class="station-fixed">
                <div class="station-line">
                  <b>{{ derivedFromOrg?.name || "总公司（未分配）" }}</b>
                  <el-tag size="small" type="info" effect="plain">按箱子归属带出 · 只读</el-tag>
                </div>
                <div v-if="derivedFromOrg" class="text-muted">{{ derivedFromOrg.path }}</div>
              </div>
              <span v-else class="tip">先在「采样箱」步选箱，寄出方按箱子当前归属自动带出</span>
            </el-form-item>
            <el-form-item label="寄出人" required :error="errors.sender">
              <el-select
                v-model="senderPick"
                filterable
                allow-create
                default-first-option
                placeholder="选择人员，或直接输入姓名"
                style="width: 100%"
                :disabled="!chosenBoxes.length"
              >
                <el-option
                  v-for="u in senderUsers"
                  :key="u.id"
                  :value="`u:${u.id}`"
                  :label="u.name"
                >
                  <span>{{ u.name }}</span>
                  <span class="dept">{{ u.dept }}</span>
                </el-option>
              </el-select>
              <p class="tip">寄出人须是寄出方的人员。箱子应已采样封箱。</p>
            </el-form-item>
            <el-form-item label="寄出地址">
              <PlaceField
                v-if="derivedFromOrg"
                v-model="form.fromPlace"
                :org="derivedFromOrg"
                :default-radius="arriveRadius"
              />
              <span v-else class="tip">先选采样箱</span>
            </el-form-item>
            <el-form-item label="接收单位" required :error="errors.toOrgId">
              <div v-if="station" class="station-fixed" data-test="create-station-fixed-send">
                <div class="station-line">
                  <b>{{ station.name }}</b>
                  <el-tag size="small" type="warning" effect="plain">检测站 · 唯一</el-tag>
                </div>
                <div class="text-muted">{{ station.path }}</div>
              </div>
              <el-alert
                v-else
                type="warning"
                :closable="false"
                show-icon
                title="尚未指定唯一检测站"
                description="请先在「系统设置 › 采样箱」指定唯一检测站，再回来创建任务单。"
              />
            </el-form-item>
            <el-form-item label="签收人" required :error="errors.signer">
              <el-select
                v-model="signerPick"
                filterable
                allow-create
                default-first-option
                placeholder="选择人员，或直接输入姓名"
                style="width: 100%"
                :disabled="!station"
              >
                <el-option v-for="u in toUsers" :key="u.id" :value="`u:${u.id}`" :label="u.name">
                  <span>{{ u.name }}</span>
                  <span class="dept">{{ u.dept }}</span>
                </el-option>
              </el-select>
              <p class="tip">默认检测站负责人。签收后箱子改归检测站。</p>
            </el-form-item>
            <el-form-item label="收货地址">
              <PlaceField
                v-if="station"
                v-model="form.toPlace"
                :org="stationOrg"
                :default-radius="arriveRadius"
              />
              <span v-else class="tip">指定检测站后带出收货地址</span>
            </el-form-item>
          </template>

          <template v-else-if="current === 'sample'">
            <el-form-item label="计划地点">
              <PlaceField
                :key="form.fromOrgId || 'none'"
                v-model="form.placeAt"
                :org="orgById(form.fromOrgId)"
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
                :disabled="!form.fromOrgId"
              >
                <el-option v-for="u in fromUsers" :key="u.id" :value="u.name" :label="u.name">
                  <span>{{ u.name }}</span>
                  <span class="dept">{{ u.dept }}</span>
                </el-option>
              </el-select>
            </el-form-item>
            <!-- 流程守卫：录像＋开箱上限都是任务级守卫，与寄送方向无关（合并单直寄检测站） -->
            <el-divider content-position="left">流程守卫</el-divider>
            <!-- R27：开箱录像只对带采样段的类型有意义。送检＝箱已封箱只寄送，没有采样现场开箱，整项隐藏（核对页同步，见 showRecordVideo） -->
            <el-form-item v-if="showRecordVideo" label="开箱录像" data-test="create-record-video">
              <el-switch
                v-model="form.recordVideo"
                :disabled="!isCompany"
                data-test="create-record-video-switch"
              />
              <p class="tip" data-test="create-record-video-tip">
                {{
                  isCompany
                    ? "分公司采样现场附近（计划地点误差范围内）每开一次箱触发一次录像：一次开箱一段，不是整单一段；录像显示在任务详情里。"
                    : "只有采样单位是分公司（公司类型）时才能开启；检测站不设录像。单位类型在「组织管理 › 部门」里设置。"
                }}
              </p>
            </el-form-item>
            <el-form-item label="开箱次数上限" data-test="create-open-limit">
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
                从任务开始到结束，按箱子上报的开箱次数计算。上限计采样开箱（装样+封箱=2）；
                寄出腿（寄往检测站／双向首腿检测站→分公司）途中开箱超限会在任务列表与详情标红。
              </p>
            </el-form-item>
          </template>

          <template v-else-if="current === 'to'">
            <el-form-item label="接收单位" required :error="errors.toOrgId">
              <div v-if="station" class="station-fixed" data-test="create-station-fixed">
                <div class="station-line">
                  <b>{{ station.name }}</b>
                  <el-tag size="small" type="warning" effect="plain">检测站 · 唯一</el-tag>
                </div>
                <div class="text-muted">{{ station.path }}</div>
              </div>
              <el-alert
                v-else
                type="warning"
                :closable="false"
                show-icon
                title="尚未指定唯一检测站"
                description="请先在「系统设置 › 采样箱」指定唯一检测站，再回来创建任务单。"
              />
              <p class="tip">任务单接收方固定为唯一检测站，总部 / 分公司不可作接收方。</p>
            </el-form-item>
            <el-form-item label="签收人" required :error="errors.signer">
              <el-select
                v-model="signerPick"
                filterable
                allow-create
                default-first-option
                placeholder="选择人员，或直接输入姓名"
                style="width: 100%"
                :disabled="!station"
              >
                <el-option v-for="u in toUsers" :key="u.id" :value="`u:${u.id}`" :label="u.name">
                  <span>{{ u.name }}</span>
                  <span class="dept">{{ u.dept }}</span>
                </el-option>
              </el-select>
              <p class="tip">
                默认是检测站的负责人。只有检测站的人员能签收；签收后箱子改归检测站，选了系统用户作签收人时由他保管。
              </p>
            </el-form-item>
            <el-form-item label="收货地址">
              <PlaceField
                v-if="station"
                v-model="form.toPlace"
                :org="stationOrg"
                :default-radius="arriveRadius"
              />
              <span v-else class="tip">指定检测站后带出收货地址</span>
            </el-form-item>
          </template>

          <template v-else-if="current === 'boxes'">
            <el-form-item label="绑定采样箱" required :error="errors.boxIds">
              <BoxPicker v-model="form.boxIds" v-model:boxes="chosenBoxes" />
            </el-form-item>
            <el-alert
              v-if="boxOrgIds.length > 1"
              type="error"
              :closable="false"
              class="indent"
              data-test="create-mixed-org"
              :title="`选中的箱子分属 ${boxOrgs.join('、')}。同一任务单的箱子须同归属，请按归属拆分任务单（跨公司批量请用划拨）`"
            />
            <!-- R22：方向由箱归属派生（只读）——选箱后即可见，采样单位步再确认一次 -->
            <el-form-item v-if="trip" label="寄送方向" data-test="create-trip-tag">
              <el-tag :type="trip === '双向' ? 'warning' : 'success'" effect="plain" size="large">
                {{ trip }}
              </el-tag>
              <p class="tip">{{ tripText }}方向按箱子当前归属自动派生，不可手选。</p>
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
                  <dd>{{ kindLabelText }}</dd>
                  <dt>名称</dt>
                  <dd>{{ form.name }}</dd>
                  <dt>备注</dt>
                  <dd>{{ form.note || "—" }}</dd>
                </dl>
              </section>
              <section>
                <header>
                  <b>
                    {{
                      form.kind === "采样"
                        ? "采样单位"
                        : form.kind === "送检"
                          ? "寄出与接收"
                          : "采样单位与寄出方"
                    }}
                  </b>
                  <el-button
                    link
                    type="primary"
                    @click="goto(form.kind === '送检' ? 'send' : 'from')"
                  >
                    修改
                  </el-button>
                </header>
                <dl>
                  <dt>{{ form.kind === "采样" ? "采样单位" : "寄出方" }}</dt>
                  <dd>
                    {{ derivedFromText || "—" }}
                    <el-tag size="small" type="info" class="tag">按箱归属 · 只读</el-tag>
                  </dd>
                  <template v-if="form.kind === '采样后送检'">
                    <dt>方向</dt>
                    <dd>
                      <el-tag
                        v-if="trip"
                        size="small"
                        :type="trip === '双向' ? 'warning' : 'success'"
                        class="tag"
                      >
                        {{ trip }}
                      </el-tag>
                      {{ tripText || "选箱后按归属派生" }}
                    </dd>
                    <dt>采样单位</dt>
                    <dd>{{ orgById(form.fromOrgId)?.path }}</dd>
                  </template>
                  <template v-if="form.kind !== '采样'">
                    <dt>寄出人</dt>
                    <dd>
                      {{ form.sender }}
                      <el-tag v-if="!form.senderId" size="small" type="info" class="tag">
                        外部人员
                      </el-tag>
                    </dd>
                    <dt>寄出地址</dt>
                    <dd>{{ placeText(form.fromPlace) }}</dd>
                  </template>
                  <template v-if="form.kind === '送检'">
                    <dt>接收方</dt>
                    <dd>{{ station?.path || "未指定" }}</dd>
                    <dt>签收人</dt>
                    <dd>
                      {{ form.signer }}
                      <el-tag v-if="!form.signerId" size="small" type="info" class="tag">
                        外部人员
                      </el-tag>
                    </dd>
                    <dt>收货地址</dt>
                    <dd>{{ placeText(form.toPlace) }}</dd>
                  </template>
                </dl>
              </section>
              <section v-if="form.kind !== '送检'">
                <header>
                  <b>采样安排</b>
                  <el-button link type="primary" @click="goto('sample')">修改</el-button>
                </header>
                <dl>
                  <dt>计划地点</dt>
                  <dd>{{ placeText(form.placeAt) }}</dd>
                  <dt>样品</dt>
                  <dd>{{ form.sample || "—" }}</dd>
                  <dt>授权人员</dt>
                  <dd>{{ form.people || "—" }}</dd>
                  <!-- R27：送检没有采样段，核对页也不出现「开箱录像」这一行（与采样安排步同一判据） -->
                  <template v-if="showRecordVideo">
                    <dt>开箱录像</dt>
                    <dd data-test="create-review-record-video">
                      {{ form.recordVideo ? "开启" : "不录" }}
                    </dd>
                  </template>
                  <dt>开箱上限</dt>
                  <dd>{{ limitOpens ? `每台最多 ${maxOpens} 次` : "不限" }}</dd>
                </dl>
              </section>
              <section v-if="form.kind === '采样后送检'">
                <header>
                  <b>检测站（接收方）</b>
                  <el-button link type="primary" @click="goto('to')">修改</el-button>
                </header>
                <dl>
                  <dt>单位</dt>
                  <dd>{{ station?.path || "未指定" }}</dd>
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
import { Check } from "@element-plus/icons-vue";
import type { Ref } from "vue";
import API, {
  policyPerm,
  type Place,
  type Policy,
  type PolicyState,
  type TaskCreate,
  type TaskOrg,
  type TaskStation,
} from "@/api/sample/report-policy";
import type { SampleBox } from "../data";
import PolicyFields from "../boxes/PolicyFields.vue";
import PlaceField from "./PlaceField.vue";
import BoxPicker from "./BoxPicker.vue";
import { radiusText } from "./radius";
import { boxTitle, imeiText } from "@/utils/boxLabel";
import { formatDuration } from "@/utils/duration";
import { KIND_META, MERGED_FLOW_TEXT, MERGED_TRIP_TEXT } from "./status";
import { kindLabel, kindTone } from "../doc-flow";
import { useUserStore } from "@/stores/user";
import SampleBoxAPI from "@/api/sample/box";
import PageHeader from "@/components/biz/PageHeader.vue";
import InfoList, { type InfoItem } from "@/components/biz/InfoList.vue";
import SectionCard from "@/components/biz/SectionCard.vue";

type Person = { id: string; name: string; dept: string };
type StepKey = "basic" | "boxes" | "from" | "sample" | "to" | "send" | "review";
const router = useRouter(),
  route = useRoute(),
  user = useUserStore();
// R23 三类型：采样/采样后送检按「新建采样任务」授权；送检按「新建送检单」或「新建采样任务」兜底。
const canSample = computed(() => Boolean(user.userInfo.perms?.includes("task:create:sample")));
const canInspect = computed(() => Boolean(user.userInfo.perms?.includes("task:create:inspect")));
const canPolicy = computed(() => Boolean(user.userInfo.perms?.includes(policyPerm.task)));
const canReadPolicy = computed(() => Boolean(user.userInfo.perms?.includes(policyPerm.read)));
const canManage = computed(() => canSample.value || canInspect.value);
/** 某类型当前账号能不能建（送检双码兜底，与服务器同口径）。 */
function kindAllowed(kind: string) {
  return kind === "送检" ? canInspect.value || canSample.value : canSample.value;
}
const previewFailed = ref(false);
let previewRequest = 0;
const form = reactive({
  kind: "采样后送检",
  name: "",
  boxIds: [] as string[],
  overrides: {} as Record<string, Policy>,
  fromOrgId: "",
  sender: "",
  senderId: "",
  signer: "",
  signerId: "",
  fromPlace: null as Place | null,
  toPlace: null as Place | null,
  placeAt: null as Place | null,
  people: "",
  sample: "",
  note: "",
  recordVideo: false,
});
/** 选类型：重置到基本信息步，清掉与旧类型相关的步骤错误。 */
function pickKind(kind: string) {
  if (!kindAllowed(kind) || form.kind === kind) return;
  form.kind = kind;
  step.value = 0;
  for (const name of Object.keys(errors)) delete errors[name];
}
const kindLabelText = computed(() => kindLabel(form));
const kindFlowTip = computed(() =>
  form.kind === "采样后送检"
    ? MERGED_FLOW_TEXT
    : KIND_META.find((m) => m.kind === form.kind)?.desc || ""
);
/** 各步骤的字段错误，显示在对应输入框下面。 */
const errors = reactive<Record<string, string>>({});
const advancedOpen = ref(false);
const saved = ref(false);
const peoplePick = computed({
  get: () => (form.people ? form.people.split("、").filter(Boolean) : []),
  set: (names: string[]) => {
    form.people = names
      .map((n) => n.trim())
      .filter(Boolean)
      .join("、");
  },
});
/** 采样单位＝所选分公司；录像 gate 公司类型（检测站禁录）。 */
const isCompany = computed(() => orgById(form.fromOrgId)?.type === "公司");
/**
 * R27：开箱录像这项只对带采样段的类型存在。
 * 采样＝仅本地采样（含旧合并别名），采样后送检＝合并全流；送检只有寄送，没有采样现场开箱，
 * 所以整项隐藏（采样安排步本来就不在该类型的步骤里，这里把判据写明，核对页那一行同步）。
 */
const showRecordVideo = computed(() => form.kind === "采样" || form.kind === "采样后送检");
/** R22：选中箱子的归属集合（未分配算空串）；>1＝混归属，整单拒（方向是单级派生事实）。 */
const boxOrgIds = computed(() => [
  ...new Set(chosenBoxes.value.map((box) => String(box.orgId || ""))),
]);
/** 箱子共同归属（混归属时为空）；未分配＝""，显示总公司。 */
const commonBoxOrgId = computed(() => (boxOrgIds.value.length === 1 ? boxOrgIds.value[0] : ""));
/** 寄出方＝箱子当前归属（只读派生）：双向＝检测站，单向＝分公司/总部。 */
const derivedFromOrg = computed(() =>
  commonBoxOrgId.value ? orgById(commonBoxOrgId.value) : null
);
const derivedFromText = computed(() => {
  if (!chosenBoxes.value.length || boxOrgIds.value.length > 1) return "";
  return derivedFromOrg.value?.path || "总公司（未分配）";
});
/**
 * R22 派生方向（只读，不手选）：箱在检测站且采样单位≠检测站→双向（检测站寄出→分公司采样→寄回），
 * 否则单向（本地采样后寄检测站）。选了箱子才可派生；混归属/未指定检测站时为空。
 */
const trip = computed<"单向" | "双向" | null>(() => {
  // R23：只有采样后送检（合并流）才有派生方向；本地采样/送检无方向概念
  if (form.kind !== "采样后送检") return null;
  if (!chosenBoxes.value.length || boxOrgIds.value.length > 1 || !station.value) return null;
  return commonBoxOrgId.value === station.value.id && form.fromOrgId !== station.value.id
    ? "双向"
    : "单向";
});
const tripText = computed(() => (trip.value ? MERGED_TRIP_TEXT[trip.value] : ""));
const boxNames = computed(() =>
  form.boxIds
    .map((id) => {
      const box = chosenBoxes.value.find((b) => b.id === id);
      // 名称为空时服务端给的是编号回显、编号就是 IMEI，统一走 boxTitle；查不到的箱子也按打码副本写
      return box ? boxTitle(box) : imeiText({ id });
    })
    .join("、")
);
/**
 * 「脏」按整页算：把可编辑状态整体序列化，跟初始化完成时的快照比一次；
 * 初始化（含 ?boxIds= 预选的箱子和从服务端取回的默认值）落在基线里，不算用户改过。
 */
const snapshot = () =>
  JSON.stringify({
    form,
    custom: custom.value,
    policy: policy.value,
    arriveRadius: arriveRadius.value,
    limitOpens: limitOpens.value,
    maxOpens: maxOpens.value,
  });
const baseline = ref("");
const dirty = computed(() => Boolean(baseline.value) && snapshot() !== baseline.value);
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
// 关标签页、刷新、浏览器地址栏跳转都不走路由守卫，只走 beforeunload
function onBeforeUnload(event: BeforeUnloadEvent) {
  if (saved.value || !dirty.value) return;
  event.preventDefault();
  event.returnValue = "";
}
const custom = ref(false),
  /** 「本任务统一」的初始策略取系统默认：默认周期归管理员在设置页改，前端不再写死 60 秒。 */
  defaultPolicy = ref<Policy>({ reportPeriodSec: 60, reportOnlyWhenCharging: false }),
  policy = ref<Policy>({ ...defaultPolicy.value });
const saving = ref(false),
  states = reactive<Record<string, PolicyState>>({});
const chosenBoxes = ref<SampleBox[]>([]);
const myOrgId = ref("");
// 换了箱子就重新取它们现在的策略，给「上报策略」预览
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
// 任务级流程守卫（与寄送方向无关），控件在「采样安排」步的流程守卫分组；
// 采样一般开一次装样、一次封箱，打开限制时默认 2 次
watch(limitOpens, (on) => {
  if (on) maxOpens.value = 2;
});
const orgs = ref<TaskOrg[]>([]),
  fromUsers = ref<Person[]>([]),
  toUsers = ref<Person[]>([]),
  /** R22：寄出人候选＝寄出方（箱归属）的人员；双向时是检测站的人。 */
  senderUsers = ref<Person[]>([]);
/** 唯一检测站（taskOptions 回生效值）：接收方固定为它，只读展示。 */
const station = ref<TaskStation | null>(null);
/** 采样单位候选＝公司类型（分公司自采），排除检测站。 */
const companyOrgs = computed(() =>
  orgs.value.filter((o) => o.type === "公司" && o.id !== station.value?.id)
);
/** 检测站作 PlaceField 的 org：优先用 orgs 里的行，取不到时按 station 拼一个。 */
const stationOrg = computed<TaskOrg | null>(() => {
  const st = station.value;
  if (!st) return null;
  return (
    orgById(st.id) || {
      id: st.id,
      parentId: "",
      name: st.name,
      type: "检测站",
      path: st.path,
      inScope: true,
      location: st.location,
      leader: st.leader,
    }
  );
});
// 采样单位不是公司类型时不能要求录像
watch(isCompany, (on) => {
  if (!on) form.recordVideo = false;
});

/**
 * R23 分步填写按类型动态：
 * - 采样后送检（合并全流）：基本 → 采样箱 → 采样单位 → 采样安排 → 检测站 → 核对（6 步）；
 * - 采样（仅本地）：基本 → 采样箱 → 采样单位 → 采样安排 → 核对（5 步，无检测站）；
 * - 送检（仅寄送）：基本 → 采样箱 → 寄出与接收 → 核对（4 步，无采样安排）。
 * 先选箱子，寄出方/采样单位就能按箱子归属自动带出。
 */
const steps = computed<{ key: StepKey; title: string }[]>(() => {
  if (form.kind === "送检")
    return [
      { key: "basic", title: "基本信息" },
      { key: "boxes", title: "采样箱" },
      { key: "send", title: "寄出与接收" },
      { key: "review", title: "核对" },
    ];
  if (form.kind === "采样")
    return [
      { key: "basic", title: "基本信息" },
      { key: "boxes", title: "采样箱" },
      { key: "from", title: "采样单位" },
      { key: "sample", title: "采样安排" },
      { key: "review", title: "核对" },
    ];
  return [
    { key: "basic", title: "基本信息" },
    { key: "boxes", title: "采样箱" },
    { key: "from", title: "采样单位" },
    { key: "sample", title: "采样安排" },
    { key: "to", title: "检测站" },
    { key: "review", title: "核对" },
  ];
});
const step = ref(0);
const current = computed(() => steps.value[step.value]?.key || "basic");
/** 选箱子和核对这两步要整宽，不显示右边的摘要；核对页本身就是完整摘要。 */
const showSummary = computed(() => current.value !== "boxes" && current.value !== "review");
const summaryItems = computed<InfoItem[]>(() => {
  const items: InfoItem[] = [
    { label: "类型", value: kindLabelText.value },
    { label: "名称", value: form.name.trim() || "—" },
    {
      label: "采样箱",
      value: form.boxIds.length ? `${form.boxIds.length} 台：${boxNames.value}` : "还没选",
    },
  ];
  if (form.kind === "采样后送检")
    items.push({
      label: "方向",
      value: trip.value ? `${trip.value}（按箱归属派生）` : "选箱后派生",
    });
  if (form.kind === "采样") {
    items.push({ label: "采样单位", value: derivedFromText.value || "选箱后带出" });
    items.push({ label: "地点", value: form.placeAt ? placeText(form.placeAt) : "—" });
  } else if (form.kind === "送检") {
    items.push({ label: "寄出方", value: derivedFromText.value || "选箱后带出" });
    items.push({
      label: "检测站",
      value: [station.value?.name, form.signer].filter(Boolean).join(" · ") || "—",
    });
  } else {
    items.push({
      label: "采样单位",
      value: [orgById(form.fromOrgId)?.name, form.sender].filter(Boolean).join(" · ") || "—",
    });
    items.push({ label: "地点", value: form.placeAt ? placeText(form.placeAt) : "—" });
    items.push({
      label: "检测站",
      value: [station.value?.name, form.signer].filter(Boolean).join(" · ") || "—",
    });
  }
  return items;
});
function goto(key: StepKey) {
  const index = steps.value.findIndex((s) => s.key === key);
  if (index >= 0) step.value = index;
}

/**
 * R27 常驻采样箱栏（步骤条上方那一行）：每一步都要看得见当前绑了哪几台，不用回第 2 步核对。
 * 称谓沿用 boxTitle / imeiText 的权限口径——没有「设备标识」权限的角色看到的是打码串或「无权查看」，
 * 整串 IMEI 不会从这一行漏出去（和列表页、核对页同一套规则）。
 */
const boxChips = computed(() =>
  form.boxIds.map((id) => {
    const box = chosenBoxes.value.find((b) => b.id === id);
    return { id, text: box ? boxTitle(box) : imeiText({ id }) };
  })
);
/** 一次最多能挑 100 台，这行不能撑成一片：超过 6 台收进「另 N 台」，跳步入口不受影响。 */
const CHIP_LIMIT = 6;
const boxChipsShown = computed(() => boxChips.value.slice(0, CHIP_LIMIT));
const boxChipsRest = computed(() => Math.max(0, boxChips.value.length - CHIP_LIMIT));
/**
 * 「采样箱」这一步在各类型里都是第 2 步，但 steps 按类型动态生成，还是按 key 找下标，不写死 1。
 * 回退沿用步骤条自己的规则（只能点回已走过的步骤），所以只有已经过了这一步才给跳；
 * 从第 1 步往前跳要过 checkStep，这里不新开一条绕过校验的路。
 */
const boxesStepIndex = computed(() => steps.value.findIndex((item) => item.key === "boxes"));
const canBackToBoxes = computed(
  () => boxesStepIndex.value >= 0 && step.value > boxesStepIndex.value
);
function backToBoxes() {
  if (!canBackToBoxes.value) return;
  step.value = boxesStepIndex.value;
}

/** 当前这一步没填完时，在对应输入框下面标出原因，返回 false。R23 按类型校验。 */
function checkStep(key: StepKey) {
  for (const name of Object.keys(errors)) delete errors[name];
  if (key === "basic" && !form.name.trim()) errors.name = "请填写任务名称";
  if (key === "boxes" && !form.boxIds.length) errors.boxIds = "请至少绑定一台采样箱";
  if (key === "boxes" && boxOrgIds.value.length > 1)
    errors.boxIds = "同一任务单的箱子须同归属，请按归属拆分任务单";
  // 本地采样：采样单位＝箱归属只读带出（选箱后即可），无寄出人
  if (key === "from" && form.kind === "采样" && !derivedFromOrg.value)
    errors.fromOrgId = "请先选采样箱，采样单位按箱子归属带出";
  if (key === "from" && form.kind !== "采样") {
    if (!form.fromOrgId) errors.fromOrgId = "请选择采样单位（寄出分公司）";
    else if (orgById(form.fromOrgId)?.type !== "公司")
      errors.fromOrgId = "采样单位必须是分公司（公司类型）";
    if (!form.sender) errors.sender = "请选择或填写寄出人";
  }
  // 送检：寄出与接收一步（寄出人＋检测站＋签收人）
  if (key === "send") {
    if (!form.sender) errors.sender = "请选择或填写寄出人";
    if (!station.value) errors.toOrgId = "请先在系统设置指定唯一检测站";
    if (!form.signer) errors.signer = "请选择或填写签收人";
  }
  if (key === "to" && !station.value) errors.toOrgId = "请先在系统设置指定唯一检测站";
  if (key === "to" && !form.signer) errors.signer = "请选择或填写签收人";
  return !Object.keys(errors).length;
}
function next() {
  if (!checkStep(current.value)) return;
  if (current.value === "boxes") {
    // 本地采样：采样单位＝箱共同归属；其余类型默认寄出分公司（suggestedFrom）
    if (form.kind === "采样") form.fromOrgId = commonBoxOrgId.value;
    else if (!form.fromOrgId) form.fromOrgId = suggestedFrom();
  }
  step.value = Math.min(step.value + 1, steps.value.length - 1);
}

/** 寄出单位默认取选中箱子共同的单位（在自己范围内、公司类型才用），否则用自己所在单位。 */
function suggestedFrom() {
  const ids = [...new Set(chosenBoxes.value.map((box) => String(box.orgId || "")))];
  const common = ids.length === 1 && ids[0] ? orgById(ids[0]) : null;
  if (common?.inScope && common.type === "公司" && common.id !== station.value?.id)
    return common.id;
  const mine = orgById(myOrgId.value);
  if (mine?.inScope && mine.type === "公司") return mine.id;
  return companyOrgs.value.find((o) => o.inScope)?.id || "";
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
    ? `本任务统一 ${formatDuration(policy.value.reportPeriodSec)}（${policy.value.reportPeriodSec} 秒）· ${policy.value.reportOnlyWhenCharging ? "仅充电时" : "持续定时"}`
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
const senderPick = personModel("sender", "senderId", senderUsers);
const signerPick = personModel("signer", "signerId", toUsers);

async function loadUsers(orgId: string, target: Ref<Person[]>) {
  target.value = orgId ? (await API.taskOptions(orgId)).users : [];
}
// 采样单位（授权人员）候选＋公司任务期间默认策略随采样单位；寄出人候选另按寄出方（箱归属）取
watch(
  () => form.fromOrgId,
  async (id) => {
    const opts = id ? await API.taskOptions(id) : null;
    fromUsers.value = opts?.users ?? [];
    // R13 拍板①：「本任务统一」初始值随采样公司的任务期间默认策略（公司未设回落系统默认）；
    // 用户已勾「单独设置」时不动其表单。提交未勾时服务端再以公司策略兜底入快照。
    if (opts) {
      defaultPolicy.value = opts.companyTaskPolicy
        ? { ...opts.companyTaskPolicy }
        : {
            reportPeriodSec: opts.defaultReportPeriodSec,
            reportOnlyWhenCharging: opts.defaultReportOnlyWhenCharging,
          };
      if (!custom.value) policy.value = { ...defaultPolicy.value };
    }
  }
);
// R22：寄出人默认是自己（自己在寄出方单位里时）；换了箱归属就重取寄出方人员
watch(
  () => derivedFromOrg.value?.id || "",
  async (id) => {
    form.sender = "";
    form.senderId = "";
    senderUsers.value = id ? (await API.taskOptions(id)).users : [];
    const me = senderUsers.value.find((u) => u.id === String(user.userInfo.userId || ""));
    if (me) Object.assign(form, { sender: me.name, senderId: me.id });
  }
);
// 签收人默认是检测站的负责人
watch(
  () => station.value?.id,
  async (id) => {
    const lead = station.value?.leader;
    form.signer = lead?.name || "";
    form.signerId = lead?.id || "";
    await loadUsers(id || "", toUsers);
    if (lead && !toUsers.value.some((u) => u.id === lead.id))
      toUsers.value = [
        { id: lead.id, name: lead.name, dept: station.value?.path || "" },
        ...toUsers.value,
      ];
  }
);

/**
 * 绑定的箱子里，单位既不是寄出方的下级、也不是它的上级的。
 * R22 同归属校验后通常为空；保留兜底提示。还没分配单位的箱子不提示。
 */
const outside = computed(() => {
  const root = derivedFromOrg.value;
  if (!root) return [];
  return (
    chosenBoxes.value
      .filter((box) => {
        const org = box.orgId ? orgById(String(box.orgId)) : null;
        if (!org) return false;
        const related =
          org.id === root.id ||
          org.path.startsWith(`${root.path} / `) ||
          root.path.startsWith(`${org.path} / `);
        return !related;
      })
      // 提示文案里只用称谓：没起名的箱子直接写编号等于下发整串 IMEI（M-1）
      .map((box) => boxTitle(box))
  );
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
  const base = policyForBox(id) || (!canReadPolicy.value ? { ...defaultPolicy.value } : null);
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
  return `${formatDuration(p.reportPeriodSec)}（${p.reportPeriodSec} 秒）· ${p.reportOnlyWhenCharging ? "仅充电时" : "持续定时"} · ${p.periodicGps === false ? "关闭卫星定位" : "随定时上报定位"} · ${source}`;
}

async function submit() {
  // 核对页上再整体校验一遍，防止回头改了前面的步骤
  for (const item of steps.value) {
    if (!checkStep(item.key)) return goto(item.key);
  }
  const base = {
    name: form.name.trim(),
    boxIds: form.boxIds,
    overrides: canPolicy.value ? form.overrides : {},
    policy: canPolicy.value && custom.value ? policy.value : null,
    note: form.note,
    maxOpens: limitOpens.value ? maxOpens.value : null,
  };
  let data: TaskCreate;
  if (form.kind === "采样") {
    // 仅本地采样：采样单位＝箱归属（只读），无检测站接收/寄出人/签收人
    const unit = derivedFromOrg.value?.id || form.fromOrgId;
    data = {
      ...base,
      kind: "采样",
      localOnly: true,
      fromOrgId: unit,
      orgId: unit,
      placeAt: form.placeAt,
      people: form.people,
      sample: form.sample,
      recordVideo: form.recordVideo,
    };
  } else if (form.kind === "送检") {
    if (!station.value) return goto("send");
    const from = derivedFromOrg.value?.id || form.fromOrgId;
    data = {
      ...base,
      kind: "送检",
      fromOrgId: from,
      orgId: from,
      toOrgId: station.value.id,
      sender: form.sender,
      senderId: form.senderId,
      signer: form.signer,
      signerId: form.signerId,
      fromPlace: form.fromPlace,
      toPlace: form.toPlace,
    };
  } else {
    if (!station.value) return goto("to");
    data = {
      ...base,
      kind: "采样后送检",
      fromOrgId: form.fromOrgId,
      toOrgId: station.value.id,
      sender: form.sender,
      senderId: form.senderId,
      signer: form.signer,
      signerId: form.signerId,
      fromPlace: form.fromPlace,
      toPlace: form.toPlace,
      orgId: form.fromOrgId,
      placeAt: form.placeAt,
      people: form.people,
      sample: form.sample,
      recordVideo: form.recordVideo,
    };
  }
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

const optionsFailed = ref(false);
/** 带过来的 ?boxIds= 里没取到的台数（不在范围内或已删除）：取到几台就用几台，但要告诉用户少了几台。 */
const presetMissing = ref(0);
/**
 * 初始化：单位列表、唯一检测站、系统默认（上报周期、到达误差）、?boxIds= 预选的箱子。
 * 取失败时页面会是一张填不下去的半张表，所以要留一条能重试的提示。
 */
async function init() {
  if (!canManage.value) return;
  optionsFailed.value = false;
  try {
    const loaded = await API.taskOptions();
    orgs.value = loaded.orgs;
    station.value = loaded.station;
    arriveRadius.value = loaded.arriveRadiusM;
    myOrgId.value = loaded.myOrgId;
    defaultPolicy.value = {
      reportPeriodSec: loaded.defaultReportPeriodSec,
      reportOnlyWhenCharging: loaded.defaultReportOnlyWhenCharging,
    };
    if (!custom.value) policy.value = { ...defaultPolicy.value };
    // 采样单位不在这里预设：选箱后离开「采样箱」步时按箱归属带出（suggestedFrom），
    // 避免先按本单位预设、选箱后不刷新导致「默认箱归属分公司」口径落空。
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
      if (chosenBoxes.value.length < preset.length)
        presetMissing.value = preset.length - chosenBoxes.value.length;
    }
  } catch {
    optionsFailed.value = true;
  } finally {
    // 到这里页面自己填的东西都算「初始状态」，之后用户改过才叫脏
    baseline.value = snapshot();
  }
}
onMounted(() => {
  window.addEventListener("beforeunload", onBeforeUnload);
  void init();
});
// 页面被 keep-alive 缓存时切走不会 unmount：不摘掉监听，在别的页面关标签也会被拦
onDeactivated(() => window.removeEventListener("beforeunload", onBeforeUnload));
onActivated(() => window.addEventListener("beforeunload", onBeforeUnload));
onBeforeUnmount(() => window.removeEventListener("beforeunload", onBeforeUnload));
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
/*
 * R27 常驻采样箱栏：和步骤条同宽、贴在它上面，只用一行小字＋标签＋一条虚线分隔。
 * 不铺底色做成独立横条（那种在页头和表单之间太突兀，先例 R20 的收尾口径是融入而不是加块）。
 */
.box-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  max-width: 960px;
  padding-bottom: 10px;
  margin: 0 auto 2px;
  border-bottom: 1px dashed var(--el-border-color-lighter);
}
.box-strip.idle {
  min-height: 22px;
}
.box-strip-label,
.box-strip-count,
.box-strip-more {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.box-strip-empty {
  font-size: 12px;
  color: var(--el-text-color-placeholder);
}
.box-strip :deep(.el-tag.jump) {
  cursor: pointer;
}
.box-strip :deep(.el-tag.jump:hover) {
  color: var(--el-color-primary);
  border-color: var(--el-color-primary-light-5);
}
@media (max-width: 640px) {
  .box-strip {
    gap: 4px;
  }
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
.init-alert {
  margin-bottom: 10px;
}
.indent {
  width: auto;
  margin: -6px 0 16px 110px;
}
.station-fixed {
  width: 100%;
  padding: 10px 12px;
  background: var(--el-fill-color-lighter);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 6px;
}
/* R23 三类型卡片：选中主色描边＋对勾，禁用灰显；流预览小字 */
.kind-cards {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
  width: 100%;
}
.kind-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px 14px;
  text-align: left;
  cursor: pointer;
  background: var(--el-fill-color-lighter);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
  transition:
    border-color 0.15s,
    background 0.15s;
}
.kind-card:hover:not(.disabled) {
  border-color: var(--el-color-primary-light-5);
}
.kind-card.on {
  background: var(--el-color-primary-light-9);
  border-color: var(--el-color-primary);
}
.kind-card.disabled {
  cursor: not-allowed;
  opacity: 0.5;
}
.kind-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.kind-head .check {
  color: var(--el-color-primary);
}
.kind-desc {
  font-size: 12px;
  line-height: 1.6;
  color: var(--el-text-color-regular);
}
.kind-flow {
  font-size: 12px;
  line-height: 1.5;
  color: var(--el-text-color-secondary);
}
@media (max-width: 900px) {
  .kind-cards {
    grid-template-columns: 1fr;
  }
}
.station-line {
  display: flex;
  gap: 8px;
  align-items: center;
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
