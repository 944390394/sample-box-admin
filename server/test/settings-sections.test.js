/**
 * #26 m-04：系统设置页分区状态纯逻辑的行为断言。
 * 被测对象＝src/views/system/settings/sections.ts（从 index.vue 抽出的快照隔离 + scrollspy 补挂逻辑，
 * 不依赖 Vue/DOM，node 直接以 type-stripping 导入 .ts）。harness 按 index.vue 的接线方式复刻
 * snapOf/snapshotAll/markSaved/dirtySections/saveAllDirty，钉死两个缺陷不再复现：
 * 1. 集成区 dirty 快照互相覆盖：存 smtp 不得吞掉 video/wechat 的未保存改动（静默丢改）；
 * 2. scrollspy 漏挂后渲染分区：settings 异步加载后出现的分区必须被补 observe。
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  dirtyIntegrationParts,
  integrationKey,
  sectionIsDirty,
  snapshotKeys,
  syncSectionSpy,
} from "../../src/views/system/settings/sections.ts";

/** 按 index.vue 的接线复刻一份分区状态（forms 模拟各 reactive 表单，saved 模拟 savedSnap）。 */
function harness() {
  const forms = {
    map: { tk: "", sk: "" },
    box: { reportPeriodSec: 60, enableTransferInspect: false },
    labels: { task: "任务单" },
    security: { minLength: 8 },
    smtp: { enabled: false, host: "", password: "" },
    video: { enabled: false, url: "", token: "" },
    wechat: { appId: "", appSecret: "" },
    db: { host: "", password: "" },
  };
  const saved = {};
  let brandingDirty = false;
  // settings 异步加载前只有这四个分区渲染（index.vue sections computed 的初始形态）
  let sectionIds = ["sec-access", "sec-map", "sec-box", "sec-labels"];
  const snapOf = (id) => {
    switch (id) {
      case "sec-map":
        return JSON.stringify(forms.map);
      case "sec-box":
        return JSON.stringify(forms.box);
      case "sec-labels":
        return JSON.stringify(forms.labels);
      case "sec-security":
        return JSON.stringify(forms.security);
      case "sec-integration:smtp":
        return JSON.stringify(forms.smtp);
      case "sec-integration:video":
        return JSON.stringify(forms.video);
      case "sec-integration:wechat":
        return JSON.stringify(forms.wechat);
      case "sec-db":
        return JSON.stringify(forms.db);
      default:
        return "";
    }
  };
  return {
    forms,
    saved,
    snapOf,
    setBrandingDirty: (v) => (brandingDirty = v),
    setSections: (ids) => (sectionIds = ids),
    snapshotAll: () => {
      for (const key of snapshotKeys(sectionIds)) saved[key] = snapOf(key);
    },
    markSaved: (id) => {
      saved[id] = snapOf(id);
    },
    dirtySections: () =>
      sectionIds.filter((id) => sectionIsDirty(id, snapOf, saved, brandingDirty)),
    dirtyParts: () => dirtyIntegrationParts(snapOf, saved),
    /** saveAllDirty 的集成区分支：只保存脏的子表单 */
    saveDirtyIntegration: () => {
      const done = [];
      for (const part of dirtyIntegrationParts(snapOf, saved)) {
        // 模拟保存成功：服务端回写后清密码/令牌，再 markSaved 对应子表单键
        if (part === "smtp") forms.smtp.password = "";
        if (part === "video") forms.video.token = "";
        if (part === "wechat") forms.wechat.appSecret = "";
        saved[integrationKey(part)] = snapOf(integrationKey(part));
        done.push(part);
      }
      return done;
    },
  };
}

const ALL_SECTIONS = [
  "sec-access",
  "sec-map",
  "sec-box",
  "sec-branding",
  "sec-labels",
  "sec-security",
  "sec-integration",
  "sec-db",
];

test("m-04 快照隔离：存 smtp 不吞 video/wechat 的未保存改动；保存全部只保存脏的子表单", async () => {
  const h = harness();
  // 加载前快照一次，加载后（分区齐了、表单填了）再快照——加载完成不应有脏标记
  h.snapshotAll();
  h.setSections(ALL_SECTIONS);
  Object.assign(h.forms.smtp, { enabled: true, host: "smtp.example.com", password: "" });
  Object.assign(h.forms.video, { enabled: true, url: "https://video.example.com", token: "" });
  Object.assign(h.forms.wechat, { appId: "wx123", appSecret: "" });
  h.snapshotAll();
  assert.deepEqual(h.dirtySections(), []);

  // 同时改 smtp 和 video：集成区脏（只计一个分区）
  h.forms.smtp.host = "smtp.new.example.com";
  h.forms.video.url = "https://video.new.example.com";
  assert.deepEqual(h.dirtySections(), ["sec-integration"]);
  assert.deepEqual(h.dirtyParts(), ["smtp", "video"]);

  // 存 smtp（markSaved 只刷 smtp 子快照）：video 的改动必须还脏——旧实现这里会静默丢改
  Object.assign(h.forms.smtp, { host: "smtp.new.example.com", password: "" });
  h.markSaved(integrationKey("smtp"));
  assert.deepEqual(h.dirtySections(), ["sec-integration"]);
  assert.deepEqual(h.dirtyParts(), ["video"]);

  // 「保存全部」只保存 video，不再把没改的 smtp 重复提交
  assert.deepEqual(h.saveDirtyIntegration(), ["video"]);
  assert.deepEqual(h.dirtySections(), []);

  // wechat 同样纳入脏快照（旧实现整区快照不含它，改了也不计脏）
  h.forms.wechat.appId = "wx456";
  assert.deepEqual(h.dirtySections(), ["sec-integration"]);
  assert.deepEqual(h.dirtyParts(), ["wechat"]);
  // 再存一次 smtp（此时 smtp 没改）：不得吞掉 wechat 的改动
  h.markSaved(integrationKey("smtp"));
  assert.deepEqual(h.dirtyParts(), ["wechat"]);
  assert.deepEqual(h.saveDirtyIntegration(), ["wechat"]);
  assert.deepEqual(h.dirtySections(), []);

  // 放弃更改＝重新 load + snapshotAll：全部回干净
  h.forms.video.url = "https://changed.example.com";
  h.forms.db.host = "mysql.example.com";
  assert.deepEqual(h.dirtySections(), ["sec-integration", "sec-db"]);
  Object.assign(h.forms.video, { url: "https://video.new.example.com" });
  h.forms.db.host = "";
  h.snapshotAll();
  assert.deepEqual(h.dirtySections(), []);
});

test("m-04 其余分区与 branding 的脏判定不受集成区拆分影响", async () => {
  const h = harness();
  h.setSections(ALL_SECTIONS);
  h.snapshotAll();
  // 普通分区整区快照照旧
  h.forms.map.tk = "tk-1";
  h.forms.box.reportPeriodSec = 120;
  assert.deepEqual(h.dirtySections(), ["sec-map", "sec-box"]);
  h.markSaved("sec-map");
  assert.deepEqual(h.dirtySections(), ["sec-box"]);
  // branding 走子组件 emit，不走快照
  h.setBrandingDirty(true);
  assert.ok(h.dirtySections().includes("sec-branding"));
  h.setBrandingDirty(false);
  assert.ok(!h.dirtySections().includes("sec-branding"));
  // 集成区三个子表单都干净时整区不脏
  assert.ok(!h.dirtySections().includes("sec-integration"));
  // snapshotKeys：集成区拆三键，其余一区一键
  assert.deepEqual(snapshotKeys(["sec-integration", "sec-db"]), [
    "sec-integration:smtp",
    "sec-integration:video",
    "sec-integration:wechat",
    "sec-db",
  ]);
});

/** 假 IntersectionObserver + 假 DOM：记录 observe/unobserve 调用。 */
function spyHarness() {
  const calls = { observe: [], unobserve: [] };
  const spy = {
    observe: (el) => calls.observe.push(el),
    unobserve: (el) => calls.unobserve.push(el),
  };
  const dom = new Map();
  const observed = new Map();
  let sectionIds = [];
  return {
    calls,
    dom,
    observed,
    setSections: (ids) => (sectionIds = ids),
    mount: (id) => {
      const el = { id };
      dom.set(id, el);
      return el;
    },
    unmount: (id) => dom.delete(id),
    sync: () => syncSectionSpy(spy, observed, sectionIds, (id) => dom.get(id) ?? null),
  };
}

test("m-04 scrollspy 补挂：异步加载后渲染的分区被 observe，消失的 unobserve，重建的换绑", async () => {
  const s = spyHarness();
  // onMounted 时刻：只有先渲染的四区在 DOM 里（settings 还没加载）
  const early = ["sec-access", "sec-map", "sec-box", "sec-labels"];
  for (const id of early) s.mount(id);
  s.setSections(early);
  s.sync();
  assert.equal(s.calls.observe.length, 4);

  // load 完成：branding/security/integration/db 渲染出来，分区列表变化后补挂
  const late = ["sec-branding", "sec-security", "sec-integration", "sec-db"];
  for (const id of late) s.mount(id);
  s.setSections([...early, ...late]);
  s.sync();
  assert.equal(s.calls.observe.length, 8);
  for (const id of late) assert.ok(s.observed.has(id), `${id} 应被补 observe`);
  // 已挂的同一元素不重复 observe
  s.sync();
  assert.equal(s.calls.observe.length, 8);
  assert.equal(s.calls.unobserve.length, 0);

  // 分区消失（如 settings.database 没了）：unobserve 掉
  s.unmount("sec-db");
  s.setSections([...early, ...late.filter((id) => id !== "sec-db")]);
  s.sync();
  assert.equal(s.calls.unobserve.length, 1);
  assert.ok(!s.observed.has("sec-db"));

  // 元素重建（v-if 重新挂载，DOM 节点换了）：换绑新元素
  const old = s.dom.get("sec-integration");
  const fresh = s.mount("sec-integration");
  s.sync();
  assert.ok(s.calls.unobserve.includes(old));
  assert.ok(s.calls.observe.includes(fresh));
  assert.equal(s.observed.get("sec-integration"), fresh);

  // 分区在列表里但元素还没渲染：不挂、不报错；下一轮补上
  s.setSections([...early, ...late, "sec-extra"]);
  s.sync();
  assert.ok(!s.observed.has("sec-extra"));
  s.mount("sec-extra");
  s.sync();
  assert.ok(s.observed.has("sec-extra"));
});
