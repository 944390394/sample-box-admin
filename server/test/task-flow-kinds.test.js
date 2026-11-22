import test from "node:test";
import assert from "node:assert/strict";
import {
  DOC_KINDS,
  ENDED,
  ENDED_OK,
  ENDED_VOID,
  SAMPLE_FLOW,
  SAMPLE_RETURN_FLOW,
  INSPECT_FLOW,
  INSPECT_RETURN_FLOW,
  LEGACY_KIND_MAP,
  LEGACY_STATUS_MAP,
  migrateKind,
  migrateStatus,
  stepsOf,
  nextOf,
  initialOf,
  signTargetOf,
  prefixOf,
  isLegacySample,
} from "../../shared/taskFlow.js";

test("B1a 合并状态机：采样单主路径 7 步、前缀 TK-、签收落待检测", () => {
  // R23 三类型反转合并：采样（本地）/送检（仅寄送）/采样后送检（合并全流）/划拨
  assert.deepEqual(DOC_KINDS, ["采样", "送检", "采样后送检", "划拨"]);
  assert.deepEqual(SAMPLE_FLOW, [
    "待采样",
    "采样中",
    "已封箱",
    "在途",
    "待签收",
    "待检测",
    "已检测",
  ]);
  // 合并单 body 恒 inspect=true（建单写入）；M2 后判别按 inspect，裸对象须带该键才是合并单
  assert.deepEqual(stepsOf({ kind: "采样", inspect: true }), SAMPLE_FLOW);
  assert.equal(initialOf({ kind: "采样", inspect: true }), "待采样");
  assert.equal(signTargetOf({ kind: "采样", inspect: true }), "待检测");
  assert.equal(prefixOf("采样"), "TK-");
  // trip 作废：新建忽略，带不带 trip 字段都不影响新单（无旧状态时一律合并流）
  assert.deepEqual(stepsOf({ kind: "采样", trip: "单向" }), [
    "待寄出",
    "运送中",
    "待采样",
    "采样中",
    "已封箱",
    "已完成",
  ]); // 旧数据只读兼容
  assert.equal(isLegacySample({ kind: "采样", inspect: true, status: "待采样" }), false);
  assert.equal(isLegacySample({ kind: "采样", trip: "双向", status: "在途" }), true);
  assert.equal(isLegacySample({ kind: "采样", status: "待核验" }), true);
  // M2：旧无 trip 采样单 inspect 恒 falsy——停共享态「在途」也是旧单（旧流 在途→待核验）；
  // 056 映射后的旧送检 inspect=true 走合并流；旧双向 inspect=true 带 trip 仍按旧流。
  assert.equal(isLegacySample({ kind: "采样", status: "在途" }), true);
  assert.equal(isLegacySample({ kind: "采样", inspect: true, status: "在途" }), false);
  assert.equal(isLegacySample({ kind: "采样", trip: "双向", inspect: true, status: "在途" }), true);
  assert.deepEqual(nextOf({ kind: "采样", status: "在途" }, "在途"), ["待核验", "已取消"]);
  assert.deepEqual(stepsOf({ kind: "采样", status: "在途" }), [
    "待采样",
    "采样中",
    "已封箱",
    "在途",
    "待核验",
    "已签收",
  ]);
  // M2：056 映射子集（待核验→待检测、已签收/已完成→已检测，inspect 仍 falsy）：
  // 进度条按合并流渲染检测段，收尾按旧核验语义（已检测/已拒收/已取消），不进新退回分支。
  assert.deepEqual(stepsOf({ kind: "采样", status: "待检测" }), SAMPLE_FLOW);
  assert.deepEqual(stepsOf({ kind: "采样", status: "已检测" }), SAMPLE_FLOW);
  assert.deepEqual(nextOf({ kind: "采样", status: "待检测" }, "待检测"), [
    "已检测",
    "已拒收",
    "已取消",
  ]);
  assert.deepEqual(nextOf({ kind: "采样", status: "已检测" }, "已检测"), []);
  assert.equal(signTargetOf({ kind: "采样", status: "待检测" }), "已签收");
});

test("B1a 合并状态机：主路径全步推进集合＋取消时点（待签收前）", () => {
  const t = { kind: "采样", inspect: true };
  assert.deepEqual(nextOf(t, "待采样"), ["采样中", "已取消"]);
  assert.deepEqual(nextOf(t, "采样中"), ["已封箱", "已取消"]);
  assert.deepEqual(nextOf(t, "已封箱"), ["在途", "已取消"]);
  assert.deepEqual(nextOf(t, "在途"), ["待签收", "已取消"]);
  // 待签收只能签收或拒收，不能再取消
  assert.deepEqual(nextOf(t, "待签收"), ["待检测", "已拒收"]);
  assert.deepEqual(nextOf(t, "待检测"), ["已检测", "退回中"]);
  // 已检测是终态OK，但仍可发起退回
  assert.deepEqual(nextOf(t, "已检测"), ["退回中"]);
  assert.deepEqual(nextOf(t, "退回中"), ["已退回"]); // 退回途中不能取消
  for (const ended of ["已取消", "已拒收", "已退回"]) assert.deepEqual(nextOf(t, ended), []);
});

test("B1a 合并状态机：退回路径与终态语义（ENDED_OK/ENDED_VOID）", () => {
  assert.deepEqual(SAMPLE_RETURN_FLOW, [
    "待采样",
    "采样中",
    "已封箱",
    "在途",
    "待签收",
    "待检测",
    "退回中",
    "已退回",
  ]);
  assert.deepEqual(stepsOf({ kind: "采样", inspect: true, status: "退回中" }), SAMPLE_RETURN_FLOW);
  assert.deepEqual(stepsOf({ kind: "采样", inspect: true, status: "已退回" }), SAMPLE_RETURN_FLOW);
  assert.ok(ENDED_OK.includes("已检测"));
  for (const s of ["已取消", "已拒收", "已退回"]) assert.ok(ENDED_VOID.includes(s));
  assert.ok(ENDED.includes("已检测") && ENDED.includes("已退回"));
  // 合并流状态集（主路径∪返程∪拒收/取消）共 11 个持久态，无「已签收/待核验」
  const states = new Set([...SAMPLE_FLOW, ...SAMPLE_RETURN_FLOW, "已拒收", "已取消"]);
  assert.equal(states.size, 11);
  assert.ok(!states.has("已签收") && !states.has("待核验"));
});

test("B1a/R25 划拨三态、无物流步骤、不走通用 transition（回归锁）", () => {
  // 通用进度条不渲染划拨（详情页用 TRANSFER_TRACK 三步条）；专用端点推进，nextOf 恒空
  assert.deepEqual(stepsOf({ kind: "划拨" }), []);
  for (const s of ["待接受", "已完成", "已取消", "已拒收", "已划拨", "已撤销"])
    assert.deepEqual(nextOf({ kind: "划拨" }, s), [], `划拨 ${s} 不走通用 transition`);
  // R25：创建落待接受（进行中态，占用箱子）；接受落已完成
  assert.equal(initialOf({ kind: "划拨" }), "待接受");
  assert.ok(!ENDED.includes("待接受"), "待接受是进行中态");
  assert.ok(ENDED.includes("已完成") && ENDED.includes("已取消") && ENDED.includes("已拒收"));
  assert.ok(ENDED.includes("已划拨") && ENDED.includes("已撤销"), "历史别名仍终态");
  assert.equal(prefixOf("划拨"), "AL-");
});

test("B1a 旧送检/调拨只读保留：历史进度条仍渲染、在途旧单仍能收尾", () => {
  // 旧送检 9 状态（INSPECT_* 常量保留供迁移映射引用）
  assert.deepEqual(INSPECT_FLOW, ["待寄出", "运送中", "待签收", "待检测", "已检测"]);
  assert.deepEqual(INSPECT_RETURN_FLOW, ["待寄出", "运送中", "待签收", "退回中", "已退回"]);
  assert.deepEqual(stepsOf({ kind: "送检" }), INSPECT_FLOW);
  assert.equal(signTargetOf({ kind: "送检" }), "待检测");
  assert.equal(prefixOf("送检"), "IN-");
  assert.deepEqual(nextOf({ kind: "送检" }, "待签收"), ["待检测", "已拒收", "退回中", "已取消"]);
  assert.deepEqual(nextOf({ kind: "送检" }, "已检测"), []);
  // 旧调拨（direct 与发货）
  assert.deepEqual(stepsOf({ kind: "调拨", direct: true }), ["待签收", "已签收"]);
  assert.deepEqual(stepsOf({ kind: "调拨" }), ["待寄出", "运送中", "待签收", "已签收"]);
  assert.deepEqual(nextOf({ kind: "调拨" }, "待签收"), ["已签收", "已拒收", "退回中", "已取消"]);
  assert.deepEqual(nextOf({ kind: "调拨", inspect: true }, "待检测"), ["已检测", "已取消"]);
  // 旧采样（双向寄回核验）
  assert.deepEqual(nextOf({ kind: "采样", trip: "双向" }, "待核验"), [
    "已签收",
    "已拒收",
    "已取消",
  ]);
  assert.deepEqual(nextOf({ kind: "采样" }, "待核验"), ["已签收", "已拒收", "已取消"]);
});

test("B1a 存量映射（P7）：kind 送检→采样，映射外同名；送检状态映射单射", () => {
  assert.deepEqual(LEGACY_KIND_MAP, { 送检: "采样" });
  assert.equal(migrateKind("送检"), "采样");
  assert.equal(migrateKind("采样"), "采样");
  assert.equal(migrateKind("调拨"), "调拨"); // 只读保留
  assert.equal(migrateKind("划拨"), "划拨");
  // 送检：待寄出→已封箱、运送中→在途，其余同名
  assert.deepEqual(LEGACY_STATUS_MAP.送检, { 待寄出: "已封箱", 运送中: "在途" });
  const inspectStates = [...new Set([...INSPECT_FLOW, ...INSPECT_RETURN_FLOW, "已拒收", "已取消"])];
  assert.equal(inspectStates.length, 9); // 送检 9 个持久状态
  const mapped = inspectStates.map((s) => migrateStatus("送检", s));
  // 单射：不同旧状态映射到不同新状态（双射到像集）
  assert.equal(new Set(mapped).size, mapped.length);
  for (const s of inspectStates) {
    const to = migrateStatus("送检", s);
    // 映射结果都是合并采样单的合法状态
    assert.ok(
      [...SAMPLE_FLOW, ...SAMPLE_RETURN_FLOW, "已拒收", "已取消"].includes(to),
      `${s}→${to}`
    );
    // 终态语义保持：OK→OK、VOID→VOID
    if (ENDED_OK.includes(s)) assert.ok(ENDED_OK.includes(to), `${s}→${to} 终态OK`);
    if (ENDED_VOID.includes(s)) assert.ok(ENDED_VOID.includes(to), `${s}→${to} 终态VOID`);
  }
  assert.equal(migrateStatus("送检", "待寄出"), "已封箱");
  assert.equal(migrateStatus("送检", "运送中"), "在途");
  assert.equal(migrateStatus("送检", "待签收"), "待签收");
  assert.equal(migrateStatus("送检", "已检测"), "已检测");
  assert.equal(migrateStatus("送检", "已退回"), "已退回");
});

test("B1a 存量映射（P7）：旧采样终态归并到已检测，其余同名、终态语义保持", () => {
  assert.deepEqual(LEGACY_STATUS_MAP.采样, {
    待核验: "待检测",
    已签收: "已检测",
    已完成: "已检测",
  });
  assert.equal(migrateStatus("采样", "待核验"), "待检测");
  assert.equal(migrateStatus("采样", "已签收"), "已检测");
  assert.equal(migrateStatus("采样", "已完成"), "已检测");
  // 其余同名
  for (const s of ["待采样", "采样中", "已封箱", "在途", "已取消", "已拒收", "退回中", "已退回"])
    assert.equal(migrateStatus("采样", s), s);
  // 终态语义：已签收/已完成（OK）归并到 已检测（OK）；VOID 保持 VOID
  for (const s of ["已签收", "已完成"]) {
    assert.ok(ENDED_OK.includes(s) && ENDED_OK.includes(migrateStatus("采样", s)));
  }
  for (const s of ["已取消", "已拒收", "已退回"])
    assert.ok(ENDED_VOID.includes(migrateStatus("采样", s)));
  // 映射结果都是合并采样单合法状态
  for (const s of ["待核验", "已签收", "已完成", "待采样", "在途", "已退回"])
    assert.ok(
      [...SAMPLE_FLOW, ...SAMPLE_RETURN_FLOW, "已拒收", "已取消"].includes(migrateStatus("采样", s))
    );
});
