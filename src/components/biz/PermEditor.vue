<template>
  <div class="perm-editor" :class="{ 'with-grant': showGrant }">
    <div class="pe-tools">
      <el-input
        v-model="word"
        :prefix-icon="Search"
        placeholder="搜权限名称、说明或 code，如「轨迹」「签收」"
        clearable
        class="pe-search"
        data-test="perm-search"
      />
      <el-radio-group v-model="filter" size="small" class="pe-filter" data-test="perm-filter">
        <el-radio-button value="all">全部</el-radio-button>
        <el-radio-button value="checked">已勾</el-radio-button>
        <el-radio-button v-if="showGrant" value="grant">可转授</el-radio-button>
        <el-radio-button v-if="editable && lockedCount" value="mine">我能改的</el-radio-button>
      </el-radio-group>
      <el-checkbox v-if="outside.size" v-model="showOutside" data-test="show-outside">
        显示上级没有的 {{ outside.size }} 项
      </el-checkbox>
      <span class="pe-total" data-test="perm-checked-count">
        已勾
        <b>{{ totalChecked }}</b>
        项
      </span>
      <span class="pe-foldops">
        <el-button link type="primary" data-test="perm-expand-all" @click="expandAll">
          展开全部
        </el-button>
        <el-button link type="primary" data-test="perm-collapse-all" @click="collapseAll">
          收起全部
        </el-button>
      </span>
    </div>

    <nav class="pe-nav" aria-label="权限模块">
      <a
        v-for="mod in modules"
        :key="mod.key"
        :class="{ on: active === mod.key, dim: !shownKeys.has(mod.key) }"
        :data-test="`perm-nav-${mod.key}`"
        @click="jump(mod.key)"
      >
        <span>{{ mod.label }}</span>
        <em
          :class="{
            full: mod.checked && mod.checked === mod.total,
            some: mod.checked && mod.checked < mod.total,
          }"
        >
          {{ mod.checked }}/{{ mod.total }}
        </em>
      </a>
    </nav>

    <div ref="mainRef" class="pe-main">
      <section v-for="mod in shown" :key="mod.key" class="pe-module" :data-module="mod.key">
        <header class="pe-mhead">
          <div class="pe-mtitle">
            <button
              type="button"
              class="pe-fold"
              :class="{ closed: folded(mod.key) }"
              :data-test="`perm-toggle-${mod.key}`"
              :aria-expanded="!folded(mod.key)"
              :aria-label="`${folded(mod.key) ? '展开' : '收起'}「${mod.label}」`"
              @click="toggleFold(mod.key)"
            >
              <el-icon><ArrowRight /></el-icon>
            </button>
            <b>{{ mod.label }}</b>
            <span
              class="pe-count"
              :class="{
                full: mod.checked && mod.checked === mod.total,
                some: mod.checked && mod.checked < mod.total,
              }"
            >
              {{ mod.checked }}/{{ mod.total }}
            </span>
            <el-tooltip v-if="mod.hint" :content="mod.hint" placement="top">
              <el-icon class="pe-help" tabindex="0" :aria-label="mod.hint">
                <QuestionFilled />
              </el-icon>
            </el-tooltip>
            <div v-if="editable && mod.changeable" class="pe-quick">
              <el-button
                link
                type="primary"
                :data-test="`quick-all-${mod.key}`"
                @click="quick(mod.key, 'all')"
              >
                全选
              </el-button>
              <el-button
                link
                type="primary"
                :data-test="`quick-read-${mod.key}`"
                @click="quick(mod.key, 'read')"
              >
                只读
              </el-button>
              <el-button
                link
                type="danger"
                :data-test="`quick-none-${mod.key}`"
                @click="quick(mod.key, 'none')"
              >
                清空
              </el-button>
            </div>
          </div>
          <span class="pe-col">
            <el-checkbox
              :model-value="mod.ownAll"
              :indeterminate="mod.checked > 0 && !mod.ownAll"
              :disabled="!editable || !mod.changeable"
              :data-test="`group-own-${mod.key}`"
              @change="(on: unknown) => quick(mod.key, on ? 'all' : 'none')"
            >
              拥有
            </el-checkbox>
          </span>
          <span v-if="showGrant" class="pe-col">
            <el-tooltip content="勾了的，拥有这个角色的人还能把这项再授给别人" placement="top">
              <el-checkbox
                :model-value="mod.grantAll"
                :indeterminate="mod.granted > 0 && !mod.grantAll"
                :disabled="!editable || !mod.changeable"
                :data-test="`group-pass-${mod.key}`"
                @change="(on: unknown) => grantColumn(mod.key, Boolean(on))"
              >
                可转授
              </el-checkbox>
            </el-tooltip>
          </span>
        </header>

        <div v-show="!folded(mod.key)" class="pe-mbody">
          <template v-for="tier in mod.tiers" :key="tier.key">
            <div class="pe-tier">{{ tier.label }}</div>
            <div
              v-for="item in tier.items"
              :key="item.code"
              class="pe-row"
              :class="{
                locked: !canChange(item.code),
                changed: isChanged(item.code),
                outside: outside.has(item.code),
              }"
              :data-code="item.code"
            >
              <div class="pe-name">
                <div class="pe-label">
                  <span>
                    <template v-for="(part, i) in parts(item.label)" :key="i">
                      <mark v-if="part.hit">{{ part.text }}</mark>
                      <template v-else>{{ part.text }}</template>
                    </template>
                  </span>
                  <el-tooltip
                    v-if="editable && reasonOf(item.code)"
                    :content="reasonOf(item.code)"
                    placement="top"
                    trigger="hover"
                  >
                    <el-icon class="pe-lock" tabindex="0" :aria-label="reasonOf(item.code)">
                      <Lock />
                    </el-icon>
                  </el-tooltip>
                </div>
                <span class="pe-code">
                  <template v-for="(part, i) in parts(item.code)" :key="i">
                    <mark v-if="part.hit">{{ part.text }}</mark>
                    <template v-else>{{ part.text }}</template>
                  </template>
                </span>
                <el-tooltip v-if="item.hint" placement="top" trigger="hover">
                  <template #content>
                    <span class="pe-tip">
                      <template v-for="(part, i) in parts(item.hint)" :key="i">
                        <mark v-if="part.hit">{{ part.text }}</mark>
                        <template v-else>{{ part.text }}</template>
                      </template>
                    </span>
                  </template>
                  <el-icon class="pe-help" tabindex="0" :aria-label="item.hint">
                    <QuestionFilled />
                  </el-icon>
                </el-tooltip>
                <el-tooltip
                  v-if="has(item.code) && missing(item)"
                  :content="`还要有${missing(item)}才用得上`"
                  placement="top"
                >
                  <el-icon class="pe-warn" tabindex="0" aria-label="缺前置权限">
                    <WarningFilled />
                  </el-icon>
                </el-tooltip>
                <el-tooltip v-if="notes[item.code]" :content="notes[item.code]" placement="top">
                  <el-icon class="pe-warn" tabindex="0" :aria-label="notes[item.code]">
                    <WarningFilled />
                  </el-icon>
                </el-tooltip>
              </div>
              <span class="pe-col">
                <el-checkbox
                  :model-value="has(item.code)"
                  :disabled="!canChange(item.code)"
                  :aria-label="`拥有：${item.label}`"
                  :data-test="`own-${item.code}`"
                  @change="(on: unknown) => toggle(item.code, Boolean(on))"
                />
              </span>
              <span v-if="showGrant" class="pe-col">
                <el-tooltip
                  :content="grantTip(item.code)"
                  :disabled="!grantTip(item.code)"
                  placement="top"
                >
                  <el-checkbox
                    :model-value="allFixed || grant.has(item.code)"
                    :disabled="!canChange(item.code) || !has(item.code)"
                    :aria-label="`可转授：${item.label}`"
                    :data-test="`pass-${item.code}`"
                    @change="(on: unknown) => toggleGrant(item.code, Boolean(on))"
                  />
                </el-tooltip>
              </span>
            </div>
          </template>
        </div>
      </section>
      <el-empty v-if="!shown.length" description="没有符合的权限" :image-size="60" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ArrowRight, Lock, QuestionFilled, Search, WarningFilled } from "@element-plus/icons-vue";
import type { PermGroup, PermItem } from "@/api/system/role";
import {
  addWithNeeds,
  brokenBy,
  buildIndex,
  namesOf,
  needsMet,
  removeWithDependents,
} from "@/utils/permDeps";

/**
 * 授权编辑器：角色页、部门「权限上限」页签共用。企业级密排（阿里云 RAM 基线）：
 * - 工具栏：搜索（名称/说明/code）＋筛选 chips＋已勾计数＋展开/收起全部；
 * - 模块目录一条横向 sticky 导航（和菜单一一对应），每个模块显示已勾 / 总数，点一下展开并滚过去；
 * - 每个模块是可折叠 section，sticky 组头＝折叠把手＋组名＋已勾/总数 badge＋全选/只读/清空
 *   ＋「拥有」「可转授」两列的列头三态 checkbox（组级全选）；
 * - 行 32px 密排：权限名＋code（等宽 12px）＋说明 tooltip（?）＋拥有/可转授两列；
 *   「可转授」未拥有时禁用并 tooltip 说明（先勾拥有）；灰掉的项悬停锁图标看原因；
 * - 勾一项自动补上前置（如「编辑人员资料」补上「查看人员」），取消前置时连带取消依赖它的项（先确认）；
 * - 搜索高亮＋自动展开命中组；筛选 全部 / 已勾 / 可转授 / 我能改的。
 * 只改 v-model 里的集合，保存由页面负责。
 */
const props = withDefaults(
  defineProps<{
    groups: PermGroup[];
    tiers?: Record<string, string>;
    codes: Set<string>;
    grant?: Set<string>;
    /** 显示「可转授」列 */
    showGrant?: boolean;
    editable?: boolean;
    /** 能改的码，null 表示全部能改 */
    assignable?: Set<string> | null;
    /** 不能改的项为什么不能改 */
    reasons?: Record<string, string>;
    /** 默认收起的项（部门上限页：上级没有的），可以展开查看 */
    outside?: Set<string>;
    outsideReason?: string;
    /** 每项附加的提醒，如「上级已收回，不生效」 */
    notes?: Record<string, string>;
    /** 保存前的样子，改过的行左边标一条色带 */
    original?: Set<string> | null;
    originalGrant?: Set<string> | null;
    /** 系统管理员：全部拥有、全部可转授，只能看 */
    allFixed?: boolean;
  }>(),
  {
    tiers: () => ({ enter: "能进这页", see: "能看到什么", do: "能做什么" }),
    grant: () => new Set<string>(),
    showGrant: false,
    editable: false,
    assignable: null,
    reasons: () => ({}),
    outside: () => new Set<string>(),
    outsideReason: "上级部门没有这一项，下级不能勾",
    notes: () => ({}),
    original: null,
    originalGrant: null,
    allFixed: false,
  }
);
const emit = defineEmits<{ "update:codes": [Set<string>]; "update:grant": [Set<string>] }>();

const word = ref("");
const filter = ref<"all" | "checked" | "grant" | "mine">("all");
const showOutside = ref(false);
const active = ref("");
const mainRef = ref<HTMLElement>();
/** 收起的模块 key（纯呈现状态；搜索时命中组强制展开）。 */
const collapsed = ref(new Set<string>());

const index = computed(() => buildIndex(props.groups));
const TIER_ORDER = ["enter", "see", "do"] as const;

function has(code: string) {
  return props.allFixed || props.codes.has(code);
}
function canChange(code: string) {
  if (!props.editable || props.allFixed) return false;
  if (props.outside.has(code)) return false;
  return !props.assignable || props.assignable.has(code);
}
function reasonOf(code: string) {
  if (props.outside.has(code)) return props.outsideReason;
  if (props.assignable && !props.assignable.has(code))
    return props.reasons[code] || "你不能转授这一项";
  return "";
}
/** 「可转授」禁用时的解释：不能改→原因；还没拥有→先勾拥有。 */
function grantTip(code: string) {
  if (!canChange(code)) return reasonOf(code);
  if (!has(code)) return "先勾「拥有」，才能设置可转授";
  return "";
}
function isChanged(code: string) {
  if (!props.original) return false;
  const own = props.original.has(code) !== props.codes.has(code);
  const pass = props.originalGrant
    ? props.originalGrant.has(code) !== props.grant.has(code)
    : false;
  return own || pass;
}
/** 勾了但前置一项都没有时，返回「X」或「Y」这样的提示。 */
function missing(item: PermItem) {
  if (props.allFixed || needsMet(item, props.codes)) return "";
  return item.needs!.map((code) => `「${index.value.byCode.get(code)?.label || code}」`).join("或");
}

const lockedCount = computed(
  () => index.value.items.filter((item) => !canChange(item.code)).length
);
const visible = (item: PermItem) => showOutside.value || !props.outside.has(item.code);

/** 每个模块的计数（不含收起的项），目录和模块标题都用。 */
const modules = computed(() =>
  props.groups.map((group) => {
    const items = group.items.filter(visible);
    const changeable = items.filter((item) => canChange(item.code));
    const checked = items.filter((item) => has(item.code)).length;
    const granted = items.filter((item) => props.allFixed || props.grant.has(item.code)).length;
    return {
      key: group.key,
      label: group.label,
      hint: group.hint,
      items,
      total: items.length,
      checked,
      granted,
      changeable: changeable.length > 0,
      ownAll: items.length > 0 && checked === items.length,
      grantAll: items.length > 0 && granted === items.length,
    };
  })
);
/** 工具栏的当前已勾总数（和组头 badge 同口径：不含收起的上级没有项）。 */
const totalChecked = computed(() => modules.value.reduce((n, mod) => n + mod.checked, 0));

/* ---------------- 折叠 ---------------- */

/** 搜索时命中组自动展开；清空搜索恢复用户自己的折叠状态。 */
function folded(key: string) {
  return word.value.trim() ? false : collapsed.value.has(key);
}
function toggleFold(key: string) {
  const next = new Set(collapsed.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  collapsed.value = next;
}
function expandAll() {
  collapsed.value = new Set();
}
function collapseAll() {
  collapsed.value = new Set(modules.value.map((mod) => mod.key));
}

function parts(text = "") {
  const key = word.value.trim();
  if (!key) return [{ text, hit: false }];
  const out: { text: string; hit: boolean }[] = [];
  let rest = text;
  while (rest) {
    const at = rest.toLowerCase().indexOf(key.toLowerCase());
    if (at < 0) {
      out.push({ text: rest, hit: false });
      break;
    }
    if (at) out.push({ text: rest.slice(0, at), hit: false });
    out.push({ text: rest.slice(at, at + key.length), hit: true });
    rest = rest.slice(at + key.length);
  }
  return out;
}

const shown = computed(() => {
  const key = word.value.trim().toLowerCase();
  return modules.value
    .map((mod) => {
      const items = mod.items.filter((item) => {
        if (filter.value === "checked" && !has(item.code)) return false;
        if (filter.value === "grant" && !(props.allFixed || props.grant.has(item.code)))
          return false;
        if (filter.value === "mine" && !canChange(item.code)) return false;
        if (
          key &&
          !`${mod.label}${item.label}${item.hint || ""}${item.code}`.toLowerCase().includes(key)
        )
          return false;
        return true;
      });
      const tiers = TIER_ORDER.map((tier) => ({
        key: tier,
        label: props.tiers[tier] || tier,
        items: items.filter((item) => (item.tier || "do") === tier),
      })).filter((tier) => tier.items.length);
      return { ...mod, tiers, matched: items.length };
    })
    .filter((mod) => mod.matched);
});
const shownKeys = computed(() => new Set(shown.value.map((mod) => mod.key)));

/* ---------------- 改动 ---------------- */

function commit(next: Set<string>, nextGrant?: Set<string>) {
  emit("update:codes", next);
  const pruned = new Set([...(nextGrant || props.grant)].filter((code) => next.has(code)));
  if (nextGrant || pruned.size !== props.grant.size) emit("update:grant", pruned);
}
function tellAdded(added: string[]) {
  if (added.length)
    ElMessage({
      type: "info",
      message: `已自动勾上前置：${namesOf(added, index.value)}`,
      grouping: true,
    });
}
const canChangeFn = (code: string) => canChange(code);

async function toggle(code: string, on: boolean) {
  const next = new Set(props.codes);
  if (on) {
    const added = addWithNeeds(next, code, index.value, canChangeFn);
    commit(next);
    tellAdded(added);
    return;
  }
  const { broken, locked } = brokenBy(next, code, index.value, canChangeFn);
  if (locked.length) {
    ElMessage.warning(
      `${namesOf(locked, index.value)}依赖这一项，你不能改它们，所以这一项也不能取消`
    );
    return;
  }
  if (broken.length) {
    try {
      await ElMessageBox.confirm(
        `下面 ${broken.length} 项依赖「${index.value.byCode.get(code)?.label || code}」，会一起取消：${namesOf(broken, index.value, 8)}`,
        "一起取消",
        { type: "warning", confirmButtonText: "一起取消", cancelButtonText: "不取消" }
      );
    } catch {
      return;
    }
  }
  removeWithDependents(next, code, index.value, canChangeFn);
  commit(next);
}

function toggleGrant(code: string, on: boolean) {
  const next = new Set(props.codes);
  const nextGrant = new Set(props.grant);
  let added: string[] = [];
  if (on) {
    // 勾「可转授」同时勾上「拥有」（行内未拥有时已禁用，这里保留兜底语义）
    if (!next.has(code)) added = addWithNeeds(next, code, index.value, canChangeFn);
    nextGrant.add(code);
  } else nextGrant.delete(code);
  commit(next, nextGrant);
  tellAdded(added);
}

/** 整列「可转授」：只动能改、而且已拥有的项。 */
function grantColumn(key: string, on: boolean) {
  const mod = modules.value.find((m) => m.key === key);
  if (!mod) return;
  const nextGrant = new Set(props.grant);
  for (const item of mod.items) {
    if (!canChange(item.code) || !props.codes.has(item.code)) continue;
    if (on) nextGrant.add(item.code);
    else nextGrant.delete(item.code);
  }
  commit(new Set(props.codes), nextGrant);
}

/** 模块快捷：全部 / 只读（能进这页、能看到什么，不含操作）/ 清空。只动能改的项。 */
async function quick(key: string, mode: "all" | "read" | "none") {
  const mod = modules.value.find((m) => m.key === key);
  if (!mod) return;
  const next = new Set(props.codes);
  const inModule = new Set(mod.items.map((item) => item.code));
  const added: string[] = [];
  const cascaded: string[] = [];
  const kept: string[] = [];
  const remove = (code: string) => {
    if (!next.has(code)) return;
    const { locked } = brokenBy(next, code, index.value, canChangeFn);
    if (locked.length) {
      kept.push(code);
      return;
    }
    cascaded.push(...removeWithDependents(next, code, index.value, canChangeFn));
  };
  for (const item of mod.items) {
    if (!canChange(item.code)) continue;
    const want = mode === "all" || (mode === "read" && item.tier !== "do");
    if (want) added.push(...addWithNeeds(next, item.code, index.value, canChangeFn));
  }
  // 先勾后取消，取消从「能做什么」往前，依赖关系从后往前拆
  for (const item of [...mod.items].reverse()) {
    if (!canChange(item.code)) continue;
    const want = mode === "all" || (mode === "read" && item.tier !== "do");
    if (!want) remove(item.code);
  }
  const outsideCascade = cascaded.filter((code) => !inModule.has(code));
  if (outsideCascade.length) {
    try {
      await ElMessageBox.confirm(
        `别的模块里有 ${outsideCascade.length} 项依赖这些权限，会一起取消：${namesOf(outsideCascade, index.value, 8)}`,
        "一起取消",
        {
          type: "warning",
          confirmButtonText: "一起取消",
          cancelButtonText: "不改了",
        }
      );
    } catch {
      return;
    }
  }
  commit(next);
  tellAdded(added.filter((code) => !inModule.has(code)));
  if (kept.length) ElMessage.warning(`${namesOf(kept, index.value)}保留：有你不能改的项依赖它`);
}

/* ---------------- 目录 ---------------- */

function sectionOf(key: string) {
  return mainRef.value?.querySelector<HTMLElement>(`[data-module="${key}"]`) || null;
}
/** 点目录滚动期间不让滚动监听改高亮：最后几个模块滚不到顶，监听会高亮成上一个。 */
let pinnedUntil = 0;
function jump(key: string) {
  pinnedUntil = Date.now() + 1200;
  if (!shownKeys.value.has(key)) {
    // 被搜索或筛选藏起来了：清掉再跳
    word.value = "";
    filter.value = "all";
  }
  // 折叠着的组先展开再滚
  if (collapsed.value.has(key)) {
    const next = new Set(collapsed.value);
    next.delete(key);
    collapsed.value = next;
  }
  active.value = key;
  nextTick(() => sectionOf(key)?.scrollIntoView({ behavior: "smooth", block: "start" }));
}

let observer: IntersectionObserver | null = null;
function observe() {
  observer?.disconnect();
  if (!mainRef.value || typeof IntersectionObserver === "undefined") return;
  observer = new IntersectionObserver(
    (entries) => {
      if (Date.now() < pinnedUntil) return;
      const top = entries
        .filter((entry) => entry.isIntersecting)
        .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (top) active.value = (top.target as HTMLElement).dataset.module || active.value;
    },
    { rootMargin: "0px 0px -60% 0px" }
  );
  mainRef.value.querySelectorAll("[data-module]").forEach((el) => observer!.observe(el));
}
watch(shown, () => nextTick(observe), { flush: "post" });
onMounted(() => {
  active.value = props.groups[0]?.key || "";
  nextTick(observe);
});
onBeforeUnmount(() => observer?.disconnect());
</script>

<style scoped>
/* 按自身宽度切换窄屏布局；container-type 会让内容撑不开宽度，所以显式占满父级 */
.perm-editor {
  width: 100%;
  min-width: 0;
  container-type: inline-size;
  --pe-nav-h: 36px;
  --pe-col-w: 72px;
}
.pe-tools {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 12px;
  align-items: center;
  margin-bottom: 8px;
}
.pe-search {
  width: 260px;
  max-width: 100%;
}
/* 筛选 chips：浅灰底圆角小片，选中浅蓝底主色字（阿里云紧凑密度） */
.pe-filter :deep(.el-radio-button__inner) {
  padding: 5px 12px;
  font-size: 12px;
  color: var(--el-text-color-regular);
  background: var(--el-fill-color-light);
  border: none;
  border-radius: 4px !important;
  box-shadow: none !important;
}
.pe-filter :deep(.el-radio-button + .el-radio-button) {
  margin-left: 4px;
}
.pe-filter :deep(.el-radio-button__original-radio:checked + .el-radio-button__inner) {
  color: var(--el-color-primary);
  background: var(--menu-active-bg);
  box-shadow: none !important;
}
.pe-total {
  margin-left: auto;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.pe-total b {
  font-variant-numeric: tabular-nums;
  color: var(--el-color-primary);
}
.pe-foldops {
  display: flex;
  gap: 4px;
}
.pe-foldops .el-button {
  padding: 4px 2px;
  font-size: 12px;
}

/* 模块目录：一条横向 sticky 导航，滚动时钉在编辑区顶部 */
.pe-nav {
  position: sticky;
  top: 0;
  z-index: 3;
  display: flex;
  gap: 4px;
  align-items: center;
  height: var(--pe-nav-h);
  padding: 0 2px;
  margin-bottom: 8px;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: thin;
  background: var(--content-bg);
  border-bottom: 1px solid var(--card-divider);
}
.pe-nav a {
  display: flex;
  flex: none;
  gap: 6px;
  align-items: center;
  padding: 4px 10px;
  font-size: 12px;
  color: var(--el-text-color-regular);
  white-space: nowrap;
  cursor: pointer;
  border-radius: 4px;
}
.pe-nav a:hover {
  background: var(--el-fill-color-light);
}
.pe-nav a.on {
  font-weight: 600;
  color: var(--el-color-primary);
  background: var(--menu-active-bg);
}
.pe-nav a.dim {
  opacity: 0.45;
}
.pe-nav em {
  font-size: 12px;
  font-style: normal;
  font-variant-numeric: tabular-nums;
  color: var(--el-text-color-placeholder);
}
.pe-nav em.some {
  color: var(--el-color-primary);
}
.pe-nav em.full {
  color: var(--el-color-success);
}

/* 模块列表：一张带边线的表，组间 1px divider，组头 sticky 钉在目录下面 */
.pe-main {
  display: flex;
  flex-direction: column;
  min-width: 0;
  border: 1px solid var(--card-border);
  border-radius: 6px;
}
.pe-module {
  scroll-margin-top: calc(var(--pe-nav-h) + 8px);
}
.pe-module + .pe-module {
  border-top: 1px solid var(--card-divider);
}
.pe-module:first-child .pe-mhead {
  border-radius: 6px 6px 0 0;
}
.pe-mhead {
  position: sticky;
  top: var(--pe-nav-h);
  z-index: 2;
  display: grid;
  grid-template-columns: minmax(0, 1fr) var(--pe-col-w);
  gap: 8px;
  align-items: center;
  min-height: 40px;
  padding: 4px 12px;
  background: var(--content-bg);
  border-bottom: 1px solid var(--card-divider);
}
.with-grant .pe-mhead {
  grid-template-columns: minmax(0, 1fr) var(--pe-col-w) var(--pe-col-w);
}
.pe-mtitle {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 8px;
  align-items: center;
  min-width: 0;
}
.pe-mtitle b {
  font-size: 14px;
}
.pe-fold {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  color: var(--el-text-color-secondary);
  cursor: pointer;
  background: none;
  border: none;
  border-radius: 4px;
}
.pe-fold:hover {
  color: var(--el-text-color-primary);
  background: var(--el-fill-color-light);
}
.pe-fold .el-icon {
  transform: rotate(90deg);
  transition: transform 0.15s;
}
.pe-fold.closed .el-icon {
  transform: rotate(0deg);
}
.pe-count {
  padding: 0 6px;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  line-height: 18px;
  color: var(--el-text-color-secondary);
  background: var(--el-fill-color-light);
  border-radius: 9px;
}
.pe-count.some {
  color: var(--el-color-primary);
  background: var(--menu-active-bg);
}
.pe-count.full {
  color: var(--el-color-success);
  background: var(--status-ok-bg);
}
.pe-help {
  flex: none;
  font-size: 14px;
  color: var(--el-text-color-placeholder);
  cursor: help;
}
.pe-help:hover {
  color: var(--el-color-primary);
}
.pe-quick {
  display: flex;
  gap: 2px;
  margin-left: 4px;
}
.pe-quick .el-button {
  padding: 4px;
  font-size: 12px;
}
.pe-col {
  display: flex;
  justify-content: center;
}
.pe-col :deep(.el-checkbox) {
  height: auto;
  margin-right: 0;
}
.pe-mhead .pe-col :deep(.el-checkbox__label) {
  padding-left: 4px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

/* 三段小标 + 32px 密排行 */
.pe-tier {
  display: flex;
  align-items: center;
  height: 26px;
  padding: 0 12px;
  font-size: 12px;
  font-weight: 600;
  color: var(--el-text-color-secondary);
  background: var(--el-fill-color-lighter);
}
.pe-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) var(--pe-col-w);
  gap: 8px;
  align-items: center;
  min-height: 32px;
  padding: 0 12px;
  border-top: 1px solid var(--el-border-color-extra-light);
  border-left: 3px solid transparent;
}
.with-grant .pe-row {
  grid-template-columns: minmax(0, 1fr) var(--pe-col-w) var(--pe-col-w);
}
.pe-row:hover {
  background: var(--el-fill-color-lighter);
}
.pe-row.changed,
.pe-row.changed:hover {
  background: var(--menu-active-bg);
  border-left-color: var(--el-color-primary);
}
.pe-row.locked .pe-label {
  color: var(--el-text-color-secondary);
}
.pe-row.outside {
  opacity: 0.6;
}
.pe-name {
  display: flex;
  gap: 6px;
  align-items: center;
  min-width: 0;
}
.pe-label {
  display: flex;
  flex: 0 1 auto;
  gap: 6px;
  align-items: center;
  min-width: 0;
  font-size: 14px;
}
.pe-label > span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pe-code {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  color: var(--el-text-color-placeholder);
  white-space: nowrap;
}
.pe-lock {
  flex: none;
  color: var(--el-text-color-placeholder);
  cursor: help;
}
.pe-warn {
  flex: none;
  font-size: 14px;
  color: var(--el-color-warning);
  cursor: help;
}
mark {
  padding: 0 1px;
  color: inherit;
  background: var(--el-color-warning-light-7);
  border-radius: 2px;
}
/* tooltip 内容是深色底：高亮块里用主文字色保证对比 */
.pe-tip mark {
  color: var(--el-text-color-primary);
}

/* 窄的时候：两列开关收窄、行内边距减小；更窄时藏 code（说明仍在 tooltip） */
@container (max-width: 760px) {
  .pe-mhead,
  .pe-row {
    grid-template-columns: minmax(0, 1fr) 52px;
    padding-right: 10px;
    padding-left: 10px;
  }
  .with-grant .pe-mhead,
  .with-grant .pe-row {
    grid-template-columns: minmax(0, 1fr) 52px 52px;
  }
  .pe-tier {
    padding: 0 10px;
  }
}
@container (max-width: 560px) {
  .pe-code {
    display: none;
  }
  .pe-search {
    width: 100%;
  }
  .pe-total {
    margin-left: 0;
  }
}
</style>
