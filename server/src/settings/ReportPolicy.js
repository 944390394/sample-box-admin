import { createHash, randomUUID } from "node:crypto";
import { ENDED, ENDED_SQL, initialOf, nextOf, prefixOf } from "./taskFlow.js";
import { formatTimestamp } from "../domain/Clock.js";
import { voidBoxIds } from "./taskPlaces.js";
import {
  currentBoxSettings,
  firmwareAcceptsConfig,
  firmwareSupportsIndicators,
  firmwareSupportsQueueAck,
  firmwareSupportsLink,
} from "./boxConfig.js";
import { badRequest, conflict, noPermission, notVisible } from "../domain/AppError.js";
import { buildDeptTree, collectDeptIds } from "../../../shared/org.js";

export function supportsDispatch(firmware) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(firmware));
  return Boolean(
    match &&
    (Number(match[1]) > 1 ||
      (Number(match[1]) === 1 && (Number(match[2]) > 0 || Number(match[3]) >= 17)))
  );
}

export const POLICY_PERMS = {
  read: "device:box:policyRead",
  single: "device:box:policyWrite",
  batch: "device:box:policyBatch",
  task: "task:policy",
  defaults: "device:box:policyDefault",
};

export function validatePolicy(input) {
  if (input == null) return null;
  if (
    !Number.isInteger(input.reportPeriodSec) ||
    input.reportPeriodSec < 5 ||
    input.reportPeriodSec > 3600
  )
    throw badRequest("上报周期必须是 5–3600 秒的整数");
  if (typeof input.reportOnlyWhenCharging !== "boolean") throw badRequest("请选择定时上报模式");
  if (input.indicators != null && typeof input.indicators !== "boolean")
    throw badRequest("请选择指示灯模式");
  if (input.moduleLed != null && typeof input.moduleLed !== "boolean")
    throw badRequest("请选择模块指示灯模式");
  if (input.periodicGps != null && typeof input.periodicGps !== "boolean")
    throw badRequest("请选择定位策略");
  return {
    ...(typeof input.periodicGps === "boolean" ? { periodicGps: input.periodicGps } : {}),
    reportPeriodSec: input.reportPeriodSec,
    reportOnlyWhenCharging: input.reportOnlyWhenCharging,
    indicators: input.indicators !== false,
    ...(typeof input.moduleLed === "boolean" ? { moduleLed: input.moduleLed } : {}),
  };
}

/** 只有明确关 STM 灯、或明确设了模块灯才进版本哈希，已有策略的版本号不变，不会因为升级被重新下发。 */
function versioned(chosen) {
  const { indicators, moduleLed, ...rest } = chosen || {};
  return {
    ...rest,
    ...(indicators === false ? { indicators } : {}),
    ...(typeof moduleLed === "boolean" ? { moduleLed } : {}),
  };
}

/** 每一层是完整策略，避免周期和充电限制分别继承造成难以解释的组合。 */
export function resolvePolicy(single, batch, task, boxId) {
  const chosen =
    task?.overrides?.[boxId] || single || task?.policy || batch || currentBoxSettings();
  const source = task?.overrides?.[boxId]
    ? "任务内单箱"
    : single
      ? "单箱设置"
      : task?.policy
        ? "任务统一"
        : batch
          ? "批量设置"
          : "系统默认";
  const version = String(
    parseInt(
      createHash("sha256")
        .update(JSON.stringify([source, versioned(chosen), task?.id || ""]))
        .digest("hex")
        .slice(0, 8),
      16
    )
  );
  return { ...validatePolicy(chosen), source, version };
}

const parse = (v) => (v ? JSON.parse(v) : null);
const stamped = (v) => (v ? { ...validatePolicy(v), revision: randomUUID() } : null);

/**
 * 划拨提交守卫（§3.2 G-A/G-B/G-C）：向导候选箱（candidate-boxes）与提交端点用同一函数，
 * 不会出现「向导能选、提交被拒」。合格返回 null；否则 {reasonCode, reason, taskName?, taskStatus?}。
 * 历史上开过盖/做过检测不拦（D-9）：那是撤销时相对本单基线的判定，建单时基线还不存在。
 */
export async function transferBlock(db, box, target = null) {
  if (!box) return { reasonCode: "BOX_MISSING", reason: "采样箱已删除或停用，请刷新后重试" };
  if (box.life === "停用")
    return { reasonCode: "BOX_DISABLED", reason: "采样箱已删除或停用，请刷新后重试" };
  // 与 createTask 的 busy 查询同款：未结束单占用（检测站已开始检测的箱子不算占用）。
  // 划拨两态 ∈ ENDED，所以划拨单不会拦自己。
  const busy = await db.get(
    `SELECT t.name,t.status FROM sample_task t JOIN sample_task_box m ON m.task_id=t.id WHERE m.box_id=? AND t.status NOT IN (${ENDED_SQL}) AND m.inspected_at IS NULL LIMIT 1`,
    [box.id]
  );
  if (busy)
    return {
      reasonCode: "IN_ACTIVE_TASK",
      reason: `${box.name || box.id} 已在任务单「${busy.name}」里，那张单结束或取消后才能再绑定`,
      taskName: busy.name,
      taskStatus: busy.status,
    };
  if (target && String(box.org_id ?? "") === String(target.id))
    return { reasonCode: "ALREADY_TARGET", reason: `${box.name || box.id} 已属于 ${target.name}` };
  return null;
}

/**
 * 撤销划拨逐台守卫（§4.2，判定顺序 IN_ACTIVE_TASK → OPENED_AFTER → INSPECTED → ORG_MOVED，
 * 一台只报第一条命中）。撤销事务内实时判定与详情展示共用。可撤返回 null。
 * 已开箱只用 opens 增量（D-7）：lid 是瞬时态，合盖后又能撤会留下漏洞。
 */
export async function revokeBlock(db, box, link, task) {
  if (!box) return { reasonCode: "ORG_MOVED", reason: "箱子已删除，无法退回原公司" };
  const busy = await db.get(
    `SELECT t.name,t.status FROM sample_task t JOIN sample_task_box m ON m.task_id=t.id WHERE m.box_id=? AND t.status NOT IN (${ENDED_SQL}) AND t.id<>? AND m.inspected_at IS NULL LIMIT 1`,
    [box.id, task.id]
  );
  if (busy)
    return {
      reasonCode: "IN_ACTIVE_TASK",
      reason: `已进入未结束任务「${busy.name}」（${busy.status}）`,
      taskName: busy.name,
      taskStatus: busy.status,
    };
  const delta = Number(box.opens || 0) - Number(link?.opens_start || 0);
  if (delta > 0)
    return {
      reasonCode: "OPENED_AFTER",
      reason: `划拨后已开箱（箱盖异常开启 ×${delta}），不满足未开箱条件`,
      opensDelta: delta,
    };
  const inspected = await db.get(
    "SELECT t.name FROM sample_task t JOIN sample_task_box m ON m.task_id=t.id WHERE m.box_id=? AND m.inspected_at IS NOT NULL AND t.id<>? LIMIT 1",
    [box.id, task.id]
  );
  if (inspected)
    return {
      reasonCode: "INSPECTED",
      reason: `已完成开箱检测（${inspected.name} · 已检测），不满足未检测条件`,
    };
  if (String(box.org_id ?? "") !== String(task.to_org_id ?? "")) {
    const org = await db.get("SELECT name FROM sys_dept WHERE id=?", [String(box.org_id ?? "")]);
    const where = org?.name || String(box.org_id ?? "") || "总公司";
    return { reasonCode: "ORG_MOVED", reason: `归属已改挂到${where}` };
  }
  return null;
}

/**
 * 建单时寄出单位下面的所有部门（R-5 自控制器层移入）：只有还挂在这些单位名下的箱子才跟着交接。
 * 旧数据没有 fromOrgId，退回按单位名找一个同名部门；都对不上时返回 null 表示不拦。
 */
export function senderOrgIds(depts, task) {
  const orgId = String(task.fromOrgId ?? "");
  if (orgId) return new Set(collectDeptIds(buildDeptTree(depts), orgId) || [orgId]);
  const byName = depts
    .filter((row) => String(row.name) === String(task.fromOrg || ""))
    .map((row) => String(row.id));
  return task.fromOrg && byName.length === 1 ? new Set(byName) : null;
}

/**
 * 签收时的归属交接（R-5）：与状态推进在同一个事务里直接写 sample_box。
 * 改造前是 transition 提交后控制器逐台调 boxes.updateBox（各自独立事务），
 * 中途失败会留下「已签收但归属只移了一半」；现在任一台失败整体回滚，状态与归属都不留半成品。
 * 跳过守卫语义不变：建单后被改挂到别的单位（不在寄出方子树）的箱子跳过并记录，不静默拉走；
 * 箱子已删除同样跳过。归属判定在行锁（MySQL FOR UPDATE）之后做，读写之间没有竞态窗口。
 * 返回 { moved, skipped }；skipped 带 where（现挂单位名）供控制器提交后写运行日志，
 * 持久化/响应时只取 { boxId, reason }。
 */
async function handOverBoxes(tx, task, ids, signerFit = "none") {
  const moved = [];
  const skipped = [];
  if (!ids.length) return { moved, skipped };
  const depts = await tx.all("SELECT id, parent_id AS parentId, name, sort FROM sys_dept");
  const nameOf = new Map(depts.map((row) => [String(row.id), row.name]));
  // null = 判不出寄出单位（旧单只存了单位名），沿用改造前的无条件交接，不批量跳过
  const fromIds = senderOrgIds(depts, task);
  // 签收人不在这张单的接收单位里时，别把他写成这批箱子的保管人：
  // 保管人会让自己数据范围里的账号看到这些箱子，等于给外来账号开了一条读取通道。
  const custodian = task.signerId && signerFit !== "foreign" ? String(task.signerId) : "";
  const owner = custodian ? String(task.signer ?? "") : "—";
  // 归属绑参兜底（review-org M2）：异常旧单可能 inspect=true 却缺 toOrgId/toOrg（损坏 body/极旧数据），
  // undefined 绑参会被 node:sqlite/mysql2 拒绝→整个事务回滚 500、单子卡死。
  // 依次取 显式接收方→原寄出单位（旧双向寄回语义）→采样单位快照，名称再兜底部门表现名；绝不绑 undefined。
  const toOrgId =
    String(task.toOrgId ?? "") || String(task.fromOrgId ?? "") || String(task.orgId ?? "");
  const toOrg = task.toOrg || task.fromOrg || task.org || nameOf.get(toOrgId) || "";
  // 与 createTransfer/revokeTransfer 同一加锁顺序（排序后逐台 FOR UPDATE），避免交叉死锁
  for (const boxId of [...ids].sort()) {
    const box = await tx.get(
      "SELECT id, org_id FROM sample_box WHERE id=?" +
        (tx.dialect === "mysql" ? " FOR UPDATE" : ""),
      [boxId]
    );
    if (!box) {
      skipped.push({ boxId, reason: "箱子已删除" });
      continue;
    }
    const current = String(box.org_id ?? "");
    if (fromIds && !fromIds.has(current)) {
      const where = nameOf.get(current) || current || "总公司";
      skipped.push({ boxId, reason: `已改挂到${where}`, where });
      continue;
    }
    await tx.run("UPDATE sample_box SET org_id=?, org=?, owner_id=?, owner=? WHERE id=?", [
      toOrgId,
      toOrg,
      custodian,
      owner,
      boxId,
    ]);
    moved.push(boxId);
  }
  return { moved, skipped };
}

/**
 * 退回目的地子树（组织简化 D3）：合并采样单退回时，箱子归属回原寄出分公司 fromOrg。
 * 与 senderOrgIds 对称——按 toOrgId（检测站）取子树，只拉回还挂在检测站名下的箱子。
 * 旧数据没有 toOrgId 时按单位名唯一匹配；都对不上返回 null（不拦，沿用无条件交接）。
 */
export function receiverOrgIds(depts, task) {
  const orgId = String(task.toOrgId ?? "");
  if (orgId) return new Set(collectDeptIds(buildDeptTree(depts), orgId) || [orgId]);
  const byName = depts
    .filter((row) => String(row.name) === String(task.toOrg || ""))
    .map((row) => String(row.id));
  return task.toOrg && byName.length === 1 ? new Set(byName) : null;
}

/**
 * 已退回时的归属回迁（组织简化 D3/P6）：合并采样单从 待检测/已检测 发起退回，
 * 箱子在 已退回 这一刻归属回原寄出分公司 fromOrg（退回中仍挂检测站，不动归属）。
 * 与 handOverBoxes 同一事务、同一加锁顺序（排序后逐台 FOR UPDATE）、同一跳过守卫：
 * 建单后被改挂到检测站子树之外的箱子跳过并记录，不静默拉走；箱子已删除同样跳过。
 * 保管人写回寄出人（senderId），前提是寄出人仍挂在 fromOrg 子树里（外来用户不写成保管人）。
 * 返回 { moved, skipped }，结构与签收交接一致，控制器/详情读模型复用。
 */
async function returnHandOverBoxes(tx, task, ids) {
  const moved = [];
  const skipped = [];
  if (!ids.length) return { moved, skipped };
  const depts = await tx.all("SELECT id, parent_id AS parentId, name, sort FROM sys_dept");
  const nameOf = new Map(depts.map((row) => [String(row.id), row.name]));
  const fromId = String(task.fromOrgId ?? "");
  const toIds = receiverOrgIds(depts, task);
  const fromIds = senderOrgIds(depts, task);
  // 寄出人还在原寄出分公司里才写回保管人；调走了就清空（与签收交接的外来守卫同口径）
  let custodian = "";
  if (task.senderId) {
    const sender = await tx.get("SELECT dept_id FROM sys_user WHERE id=?", [String(task.senderId)]);
    const deptId = String(sender?.dept_id ?? "");
    if (sender && (!fromIds || fromIds.has(deptId))) custodian = String(task.senderId);
  }
  const owner = custodian ? String(task.sender ?? "") : "—";
  for (const boxId of [...ids].sort()) {
    const box = await tx.get(
      "SELECT id, org_id FROM sample_box WHERE id=?" +
        (tx.dialect === "mysql" ? " FOR UPDATE" : ""),
      [boxId]
    );
    if (!box) {
      skipped.push({ boxId, reason: "箱子已删除" });
      continue;
    }
    const current = String(box.org_id ?? "");
    if (toIds && !toIds.has(current)) {
      const where = nameOf.get(current) || current || "总公司";
      skipped.push({ boxId, reason: `已改挂到${where}`, where });
      continue;
    }
    if (!fromId) {
      skipped.push({ boxId, reason: "原寄出单位不明，未自动改归属" });
      continue;
    }
    await tx.run("UPDATE sample_box SET org_id=?, org=?, owner_id=?, owner=? WHERE id=?", [
      fromId,
      // 名称兜底（M2 同口径）：旧单可能只有 fromOrgId 没有 fromOrg 名，绝不绑 undefined
      task.fromOrg || nameOf.get(fromId) || "",
      custodian,
      owner,
      boxId,
    ]);
    moved.push(boxId);
  }
  return { moved, skipped };
}

export class ReportPolicy {
  constructor(db) {
    this.db = db;
  }

  async get(box, db = this.db) {
    const row = await db.get("SELECT * FROM box_report_policy WHERE box_id = ?", [box.id]);
    let active = await db.get(
      "SELECT t.id,t.body FROM sample_task t JOIN box_active_task a ON a.task_id=t.id WHERE a.box_id=?",
      [box.id]
    );
    // The new terminal can receive a dispatch as soon as the assignment commits.
    if (!active && supportsDispatch(box.firmware)) {
      active = await db.get(
        "SELECT t.id,t.body FROM sample_task t JOIN sample_task_box m ON m.task_id=t.id WHERE m.box_id=? AND m.inspected_at IS NULL AND t.status NOT IN (" +
          ENDED_SQL +
          ") LIMIT 1",
        [box.id]
      );
    }
    const task = active ? { ...parse(active.body), id: active.id } : null;
    const single = parse(row?.single_json),
      batch = parse(row?.batch_json);
    const snapshot = supportsDispatch(box.firmware) ? task?.assignedPolicies?.[box.id] : null;
    const effective = snapshot ?? resolvePolicy(single, batch, task, box.id);
    const delivery = await db.get("SELECT * FROM box_report_delivery WHERE box_id=?", [box.id]);
    const matching = delivery?.version === effective.version;
    const echo =
      matching && delivery?.echo_version != null
        ? {
            version: String(delivery.echo_version),
            periodSec: Number(delivery.echo_period),
            charging: Number(delivery.echo_charge) === 1,
          }
        : null;
    const echoMatches =
      echo &&
      echo.version === effective.version &&
      echo.periodSec === effective.reportPeriodSec &&
      echo.charging === effective.reportOnlyWhenCharging;
    const status = !box.firmware
      ? "待首次上报"
      : !firmwareAcceptsConfig(box.firmware)
        ? "固件不支持"
        : matching && delivery.confirmed_at
          ? "已生效"
          : echo && !echoMatches
            ? "未生效"
            : matching && delivery.sent_at
              ? "已发送待确认"
              : "待下发";
    return {
      single,
      batch,
      effective,
      taskId: active?.id || null,
      status,
      echo,
      sentAt: matching ? delivery?.sent_at : null,
      confirmedAt: matching ? delivery?.confirmed_at : null,
    };
  }

  // Existing open tasks have no assignment snapshot. Capture the effective policy
  // once at upgrade; historical values before the upgrade are not recoverable.
  async initializeAssignments() {
    const rows = await this.db.all(
      "SELECT id FROM sample_task WHERE status NOT IN (" + ENDED_SQL + ")"
    );
    for (const { id } of rows) {
      await this.db.transaction(async (tx) => {
        const row = await tx.get(
          "SELECT body FROM sample_task WHERE id=?" + (tx.dialect === "mysql" ? " FOR UPDATE" : ""),
          [id]
        );
        if (!row) return;
        const body = parse(row.body);
        if (!body || body.assignedPolicies) return;
        const boxes = await tx.all(
          "SELECT m.box_id,p.single_json,p.batch_json FROM sample_task_box m LEFT JOIN box_report_policy p ON p.box_id=m.box_id WHERE m.task_id=?",
          [id]
        );
        body.assignedPolicies = Object.fromEntries(
          boxes.map((b) => [
            b.box_id,
            resolvePolicy(parse(b.single_json), parse(b.batch_json), { ...body, id }, b.box_id),
          ])
        );
        await tx.run("UPDATE sample_task SET body=? WHERE id=?", [JSON.stringify(body), id]);
      });
    }
  }

  async refresh(ids, tx) {
    for (const id of ids) {
      const box = await tx.get("SELECT id,firmware FROM sample_box WHERE id=?", [id]);
      const p = (await this.get(box || { id }, tx)).effective;
      await tx.run("UPDATE sample_box SET policy_period_sec=?,policy_charge_only=? WHERE id=?", [
        p.source === "系统默认" ? null : p.reportPeriodSec,
        p.source === "系统默认" ? null : Number(p.reportOnlyWhenCharging),
        id,
      ]);
    }
  }

  async save(ids, layer, policy) {
    if (!["single", "batch"].includes(layer)) throw badRequest("策略层级不正确");
    const value = stamped(policy);
    await this.db.transaction(async (tx) => {
      for (const id of ids) {
        const box = await tx.get(
          "SELECT id FROM sample_box WHERE id=?" + (tx.dialect === "mysql" ? " FOR UPDATE" : ""),
          [id]
        );
        if (!box) throw conflict("采样箱已删除，请刷新后重试");
        const row = await tx.get("SELECT * FROM box_report_policy WHERE box_id=?", [id]);
        const single = layer === "single" ? JSON.stringify(value) : row?.single_json || null;
        const batch = layer === "batch" ? JSON.stringify(value) : row?.batch_json || null;
        if (row)
          await tx.run("UPDATE box_report_policy SET single_json=?,batch_json=? WHERE box_id=?", [
            single,
            batch,
            id,
          ]);
        else
          await tx.run(
            "INSERT INTO box_report_policy (box_id,single_json,batch_json) VALUES (?,?,?)",
            [id, single, batch]
          );
      }
      await this.refresh(ids, tx);
    });
    this.onPolicyChanged?.(ids);
  }

  /** 写入 socket 之前只计算内容，写入成功回调之后才标记已发送。 */
  /** opts.ack：离线队列的累计确认号，只对固件 1.0.9 及以上带，放在 v= 之前。 */
  async packet(box, opts = {}) {
    if (!firmwareAcceptsConfig(box?.firmware)) return { text: "ok\n", version: null };
    const { effective: p, taskId } = await this.get(box);
    const led = firmwareSupportsIndicators(box.firmware) ? ` l=${p.indicators ? 1 : 0}` : "";
    /**
     * m= 放在 v= 之后，由 DTU 接收模板读出来调用 PerSetLedSta。它会连 RDY 引脚一起拉低，
     * 所以只在设备已经改用模块的 net= 链路状态（上报里 rn=1）时才下发，否则 STM 会把模块当成断网。
     */
    const module =
      typeof p.moduleLed === "boolean" && opts.link === 1 && firmwareSupportsLink(box.firmware)
        ? ` m=${p.moduleLed ? 1 : 0}`
        : "";
    const ack = opts.ack != null && firmwareSupportsQueueAck(box.firmware) ? ` a=${opts.ack}` : "";
    /**
     * g= 放在最末：DTU 接收模板读出来控制定位电源，并从行里删掉，STM 收不到。
     * 有进行中的任务或正在充电时要定位（g=1，定位芯片常开，热启动几秒就有坐标），其余时候关掉省电。
     * 接收模板没更新时 STM 会在 v= 之后遇到它停下，和 m= 一样不影响策略生效。
     */
    if (opts.scheduled && supportsDispatch(box.firmware)) {
      const gps = p.periodicGps ?? Boolean(taskId);
      return {
        text: `ok p=${p.reportPeriodSec} c=${Number(p.reportOnlyWhenCharging)}${led}${ack} t=${Number(Boolean(taskId))} j=${Number(gps)} v=${p.version}${module}\n`,
        version: p.version,
      };
    }
    const busy = box?.id
      ? await this.db
          .get("SELECT task_id FROM box_active_task WHERE box_id=?", [box.id])
          .catch(() => null)
      : null;
    const gnss = ` g=${busy || Number(box?.charge) === 1 || Number(box?.charge) === 2 ? 1 : 0}`;
    return {
      text: `ok p=${p.reportPeriodSec} c=${p.reportOnlyWhenCharging ? 1 : 0}${led}${ack} v=${p.version}${module}${gnss}\n`,
      version: p.version,
    };
  }

  async sent(boxId, version) {
    if (!version) return;
    await this.db.transaction(async (tx) => {
      if (
        !(await tx.get(
          "SELECT id FROM sample_box WHERE id=?" + (tx.dialect === "mysql" ? " FOR UPDATE" : ""),
          [boxId]
        ))
      )
        return;
      const row = await tx.get("SELECT version FROM box_report_delivery WHERE box_id=?", [boxId]);
      if (row?.version === version) return;
      const now = new Date().toISOString();
      if (row)
        await tx.run(
          "UPDATE box_report_delivery SET version=?,sent_at=?,confirmed_at=NULL,echo_version=NULL,echo_period=NULL,echo_charge=NULL WHERE box_id=?",
          [version, now, boxId]
        );
      else
        await tx.run("INSERT INTO box_report_delivery (box_id,version,sent_at) VALUES (?,?,?)", [
          boxId,
          version,
          now,
        ]);
    });
  }

  async observe(box, uplink) {
    // Flash replay describes the policy at the event time, possibly before a reboot.
    if (uplink.backfill) return;
    // 派生 kind 优先：连续上报的固件重启只发 why=timer + opens=0，认 why 就漏掉这次重启、不清投递记录
    if ((uplink.kind ?? uplink.why) === "boot")
      await this.db.run("DELETE FROM box_report_delivery WHERE box_id=?", [box.id]);
    if (
      uplink.policyVersion == null ||
      uplink.reportPeriodSec == null ||
      uplink.reportCharging == null
    )
      return;
    const { effective: p } = await this.get(box);
    const match =
      String(uplink.policyVersion) === p.version &&
      uplink.reportPeriodSec === p.reportPeriodSec &&
      uplink.reportCharging === Number(p.reportOnlyWhenCharging);
    const now = new Date().toISOString();
    await this.db.run(
      `UPDATE box_report_delivery SET echo_version=?,echo_period=?,echo_charge=?,confirmed_at=CASE WHEN ?=1 THEN COALESCE(confirmed_at,?) ELSE NULL END WHERE box_id=? AND version=?`,
      [
        String(uplink.policyVersion),
        uplink.reportPeriodSec,
        uplink.reportCharging,
        match ? 1 : 0,
        now,
        box.id,
        p.version,
      ]
    );
  }

  async createTask(input, actor = {}) {
    // 单号前缀按 kind：采样 TK-（合并采样+送检）、划拨走 createTransfer（AL-）。前缀只是显示，kind 才是权威。
    const id = `${prefixOf(input.kind)}${Date.now()}-${randomUUID().slice(0, 6)}`;
    const initial = initialOf(input);
    // 合并采样单接收方固定检测站（控制器已校验 toOrgId＝stationDeptId）；trip 作废，不再按 orgId 改写接收方。
    const toOrgId = input.toOrgId;
    const body = {
      ...input,
      policy: stamped(input.policy),
      overrides: Object.fromEntries(
        Object.entries(input.overrides || {}).map(([k, v]) => [k, stamped(v)])
      ),
    };
    // is_inspect 真列（050）：合并采样单恒送检测站（body.inspect=true）；旧送检/旧调拨送检测站的按 body.inspect，与统计侧 LIKE 判定同源
    const isInspect = input.kind === "送检" || body.inspect === true ? 1 : 0;
    await this.db.transaction(async (tx) => {
      const snapshots = new Map();
      for (const boxId of [...input.boxIds].sort()) {
        const box = await tx.get(
          "SELECT id,name,life,org_id,owner_id,opens FROM sample_box WHERE id=?" +
            (tx.dialect === "mysql" ? " FOR UPDATE" : ""),
          [boxId]
        );
        if (!box || box.life === "停用") throw conflict("采样箱已删除或停用，请刷新后重试");
        // 一台箱子同时只能在一张没结束的任务单里（还没开始的也算）
        // 检测站已开始检测的箱子，这张单对它来说已经结束
        const busy = await tx.get(
          `SELECT t.name FROM sample_task t JOIN sample_task_box m ON m.task_id=t.id WHERE m.box_id=? AND t.status NOT IN (${ENDED_SQL}) AND m.inspected_at IS NULL LIMIT 1`,
          [boxId]
        );
        if (busy)
          throw conflict(
            `${box.name || boxId} 已在任务单「${busy.name}」里，那张单结束或取消后才能再绑定`
          );
        snapshots.set(boxId, box);
        const layers = await tx.get(
          "SELECT single_json,batch_json FROM box_report_policy WHERE box_id=?",
          [boxId]
        );
        body.assignedPolicies ??= Object.create(null);
        body.assignedPolicies[boxId] = resolvePolicy(
          parse(layers?.single_json),
          parse(layers?.batch_json),
          { ...body, id },
          boxId
        );
      }
      await tx.run(
        "INSERT INTO sample_task (id,name,kind,status,body,created_at,from_org_id,to_org_id,is_inspect) VALUES (?,?,?,?,?,?,?,?,?)",
        [
          id,
          input.name,
          input.kind,
          initial,
          JSON.stringify(body),
          new Date().toISOString(),
          input.fromOrgId || null,
          toOrgId || null,
          isInspect,
        ]
      );
      for (const boxId of input.boxIds) {
        const box = snapshots.get(boxId);
        await tx.run(
          "INSERT INTO sample_task_box (task_id,box_id,org_id,owner_id,opens_start) VALUES (?,?,?,?,?)",
          [id, boxId, box.org_id, box.owner_id, Number(box.opens) || 0]
        );
        // 建单就占用：箱子显示「在途」，选箱时不再出现在「可用」里。
        // 任务策略：旧固件等任务开始才生效；1.0.17 起建单即按 assignedPolicies 快照下发，任务期间不变
        await tx.run("UPDATE sample_box SET life='在途' WHERE id=? AND life='未使用'", [boxId]);
        await syncBoundTask(tx, boxId);
      }
      await this.refresh(input.boxIds, tx);
      await addTaskLog(tx, { taskId: id, status: initial, action: "创建", actor });
    });
    this.onPolicyChanged?.(input.boxIds);
    return id;
  }

  /**
   * 创建划拨单（§3.2）：提交即生效。单据、箱单快照、归属迁移在同一个 db.transaction 里写完，
   * 任一步失败整体回滚（归属不得残留）；不调 boxes.updateBox（它另开事务）、不写 box_active_task、
   * 不改 life、不下发任务策略——划拨两态 ∈ ENDED，不是任务、不占用箱子。
   * clientToken 幂等（051 transfer_request）：重复提交返回原 task_id，不重复转移。
   * actor 可带 scope（控制器传 ctx.access.scope）：目标公司必须在操作人范围内，口径同单箱 assign。
   * P8（组织简化 B1c）：目标部门 type 必须=公司——检测站拒绝（友好报错），总部允许（收回未分配语义）。
   */
  async createTransfer(input, actor = {}) {
    const name = String(input?.name ?? "").trim();
    if (!name || name.length > 120) throw badRequest("请填写划拨单名称");
    const toOrgId = String(input?.toOrgId ?? "");
    if (!toOrgId) throw badRequest("请选择目标公司");
    const boxIds = [
      ...new Set((Array.isArray(input?.boxIds) ? input.boxIds : []).map((id) => String(id))),
    ];
    if (!boxIds.length) throw badRequest("请选择要划拨的采样箱");
    if (boxIds.length > 500) throw badRequest("一张划拨单最多 500 台箱子，请分批提交");
    const note = String(input?.note ?? "").slice(0, 1000);
    const clientToken = String(input?.clientToken ?? "").slice(0, 64);
    const scope = actor.scope || null;

    // 幂等先查一次（事务外快路径）；锁内还会再查一次兜住并发双击
    if (clientToken) {
      const prior = await this.db.get("SELECT task_id FROM transfer_request WHERE client_token=?", [
        clientToken,
      ]);
      if (prior) return { id: prior.task_id, idempotent: true };
    }

    const id = `AL-${Date.now()}-${randomUUID().slice(0, 6)}`;
    const createdAt = new Date().toISOString();
    let result = null;
    await this.db.transaction(async (tx) => {
      const target = await tx.get("SELECT id,name,type FROM sys_dept WHERE id=? AND status=1", [
        toOrgId,
      ]);
      if (!target) throw badRequest("目标公司不存在或已停用");
      // P8：划拨目标限 type=公司——检测站不参与归属划拨（友好报错）；
      // 总部（公司类型）允许＝收回未分配语义。前端选项过滤由 B2 同步，这里是提交侧权威闸门。
      if (target.type !== "公司")
        throw badRequest(
          target.type === "检测站"
            ? "检测站不参与归属划拨，请改选分公司或总部"
            : "划拨目标必须是公司类型（分公司或总部）"
        );
      if (scope && !scope.all && !scope.orgIds.includes(String(target.id)))
        throw noPermission("只能划拨到自己范围内的单位");
      if (clientToken) {
        const prior = await tx.get("SELECT task_id FROM transfer_request WHERE client_token=?", [
          clientToken,
        ]);
        if (prior) {
          result = { id: prior.task_id, idempotent: true };
          return;
        }
      }
      // 与 createTask 同一加锁顺序（boxIds 排序后逐台 FOR UPDATE），避免交叉死锁
      const sorted = [...boxIds].sort();
      const snapshots = new Map();
      const blocked = [];
      for (const boxId of sorted) {
        const box = await tx.get(
          "SELECT id,name,life,org_id,owner_id,opens FROM sample_box WHERE id=?" +
            (tx.dialect === "mysql" ? " FOR UPDATE" : ""),
          [boxId]
        );
        const hit = await transferBlock(tx, box, { id: String(target.id), name: target.name });
        if (hit) blocked.push({ boxId, code: boxId, name: box?.name || boxId, ...hit });
        else snapshots.set(boxId, box);
      }
      // 整单拒（D-2）：不做部分成功，逐台原因一次性回给页面
      if (blocked.length)
        throw Object.assign(conflict(blocked[0].reason), {
          data: { blocked, totalCount: boxIds.length, blockedCount: blocked.length },
        });

      const depts = await tx.all("SELECT id,name FROM sys_dept");
      const orgNameOf = new Map(depts.map((row) => [String(row.id), row.name]));
      const ownerIds = [
        ...new Set(sorted.map((bid) => String(snapshots.get(bid).owner_id ?? "")).filter(Boolean)),
      ];
      const owners = ownerIds.length
        ? await tx.all(
            `SELECT id,nickname FROM sys_user WHERE id IN (${ownerIds.map(() => "?").join(",")})`,
            ownerIds
          )
        : [];
      const ownerNameOf = new Map(owners.map((row) => [String(row.id), row.nickname]));
      const fromMap = new Map();
      const boxes = [];
      for (const boxId of sorted) {
        const box = snapshots.get(boxId);
        const orgId = String(box.org_id ?? "");
        const orgName = orgNameOf.get(orgId) || orgId || "总公司";
        const bucket = fromMap.get(orgId) || { orgId, orgName, count: 0 };
        bucket.count += 1;
        fromMap.set(orgId, bucket);
        const ownerId = String(box.owner_id ?? "");
        boxes.push({
          boxId,
          code: boxId,
          name: box.name || boxId,
          fromOrgId: orgId,
          fromOrg: orgName,
          fromOwnerId: ownerId,
          fromOwner: ownerNameOf.get(ownerId) || "",
          life: box.life,
          revocable: true,
        });
      }
      const from = [...fromMap.values()];
      // from_org_id 单值列表达不了跨公司批量：存 NULL，「原公司」一律读 sample_task_box 快照（D-12）
      const body = {
        kind: "划拨",
        name,
        toOrg: target.name,
        toOrgId: String(target.id),
        from,
        note,
        boxIds: sorted,
        ...(clientToken ? { clientToken } : {}),
        createdBy: String(actor.name || "").slice(0, 64),
        createdById: String(actor.id || ""),
      };
      await tx.run(
        "INSERT INTO sample_task (id,name,kind,status,body,created_at,from_org_id,to_org_id,is_inspect) VALUES (?,?,?,?,?,?,?,?,0)",
        [id, name, "划拨", "已划拨", JSON.stringify(body), createdAt, null, String(target.id)]
      );
      for (const boxId of sorted) {
        const box = snapshots.get(boxId);
        // 快照 = 撤销时的回滚目标（唯一权威来源）；opens_start = 「划拨后是否开箱」的基线
        await tx.run(
          "INSERT INTO sample_task_box (task_id,box_id,org_id,owner_id,opens_start) VALUES (?,?,?,?,?)",
          [id, boxId, box.org_id, box.owner_id, Number(box.opens) || 0]
        );
        // 归属即时转移，与单据同一事务。保管人清空：旧保管人不应再跨公司看到这批箱子
        await tx.run("UPDATE sample_box SET org_id=?, org=?, owner_id='', owner='' WHERE id=?", [
          String(target.id),
          target.name,
          boxId,
        ]);
      }
      await addTaskLog(tx, {
        taskId: id,
        status: "已划拨",
        action: "提交划拨",
        actor,
        note,
        detail: {
          count: sorted.length,
          from: boxes.map((b) => ({
            boxId: b.boxId,
            code: b.code,
            name: b.name,
            orgId: b.fromOrgId,
            orgName: b.fromOrg,
            ownerName: b.fromOwner,
          })),
          toOrgId: String(target.id),
          toOrgName: target.name,
        },
      });
      if (clientToken)
        await tx.run(
          "INSERT INTO transfer_request (client_token,task_id,created_at) VALUES (?,?,?)",
          [clientToken, id, createdAt]
        );
      result = { id, idempotent: false };
    });
    return result;
  }

  /**
   * 撤销划拨（§4）：仅 kind=划拨 且 status=已划拨 可撤。事务内锁单锁箱后逐台实时判定四类守卫，
   * 任一不合格 → 整单禁撤（状态不变、归属不动），409 带逐台原因；全合格 → 归属退回建单快照
   * （sample_task_box.org_id/owner_id）+ status=已撤销 + 审计。不删行：箱单与日志全部保留。
   * 已撤销不可再撤，也没有「撤销撤销」（D-8）。
   */
  async revokeTransfer(taskId, { reason = "", actor = {} } = {}) {
    const note = String(reason ?? "").trim();
    if (!note || note.length > 100) throw badRequest("请填写撤销原因（100 字以内）");
    let result = null;
    await this.db.transaction(async (tx) => {
      const task = await tx.get(
        "SELECT * FROM sample_task WHERE id=?" + (tx.dialect === "mysql" ? " FOR UPDATE" : ""),
        [taskId]
      );
      if (!task) throw notVisible("划拨单不存在或不在你的管理范围内");
      if (task.kind !== "划拨") throw conflict("只有划拨单可以撤销");
      if (task.status === "已撤销") throw conflict("这张划拨单已撤销，不能重复撤销");
      if (task.status !== "已划拨") throw conflict("任务状态已改变，请刷新后重试");
      const links = await tx.all(
        "SELECT box_id,org_id,owner_id,opens_start FROM sample_task_box WHERE task_id=? ORDER BY box_id",
        [taskId]
      );
      const boxes = [];
      const restored = [];
      let blockedCount = 0;
      for (const link of links) {
        const box = await tx.get(
          "SELECT id,name,life,org_id,owner_id,opens FROM sample_box WHERE id=?" +
            (tx.dialect === "mysql" ? " FOR UPDATE" : ""),
          [link.box_id]
        );
        const hit = await revokeBlock(tx, box, link, task);
        const entry = { boxId: link.box_id, code: link.box_id, name: box?.name || link.box_id };
        if (hit) {
          blockedCount += 1;
          boxes.push({ ...entry, ok: false, ...hit });
          continue;
        }
        // 退回目标 = 建单快照；名称按当前部门/人员表解析，快照 owner_id 为空串按空处理（显示「—」）
        const orgId = String(link.org_id ?? "");
        const orgRow = orgId ? await tx.get("SELECT name FROM sys_dept WHERE id=?", [orgId]) : null;
        const ownerId = String(link.owner_id ?? "");
        const ownerRow = ownerId
          ? await tx.get("SELECT nickname FROM sys_user WHERE id=?", [ownerId])
          : null;
        const toOrg = orgRow?.name || orgId || "总公司";
        const owner = ownerRow?.nickname || "";
        restored.push({ ...entry, toOrgId: orgId, toOrg, ownerId, owner });
        boxes.push({
          ...entry,
          ok: true,
          restoreTo: { orgId, orgName: toOrg, ownerName: owner || "—" },
        });
      }
      if (blockedCount)
        throw Object.assign(conflict(`存在 ${blockedCount} 台不可撤销箱子，整单禁止撤销。`), {
          data: {
            canRevoke: false,
            banner: "整单禁止撤销",
            confirmLabel: "整单不可撤销",
            totalCount: links.length,
            blockedCount,
            okCount: links.length - blockedCount,
            boxes,
          },
        });
      const revokedAt = new Date().toISOString();
      for (const item of restored)
        await tx.run("UPDATE sample_box SET org_id=?, org=?, owner_id=?, owner=? WHERE id=?", [
          item.toOrgId,
          item.toOrg,
          item.ownerId,
          item.owner,
          item.boxId,
        ]);
      // 带 status 条件：并发第二次撤销落到 0 行 → 整体回滚
      const updated = await tx.run(
        "UPDATE sample_task SET status='已撤销' WHERE id=? AND status='已划拨'",
        [taskId]
      );
      if (!Number(updated?.changes ?? updated?.affectedRows ?? 0))
        throw conflict("任务状态已改变，请刷新后重试");
      await addTaskLog(tx, {
        taskId,
        status: "已撤销",
        action: "撤销划拨",
        actor,
        note,
        at: revokedAt,
        detail: {
          count: restored.length,
          restored: restored.map((r) => ({
            boxId: r.boxId,
            code: r.code,
            name: r.name,
            toOrgId: r.toOrgId,
            toOrgName: r.toOrg,
            ownerId: r.ownerId,
            ownerName: r.owner,
          })),
        },
      });
      result = {
        id: taskId,
        status: "已撤销",
        revokedAt,
        restoredCount: restored.length,
        restored,
        log: { action: "撤销划拨", actorName: String(actor.name || ""), at: revokedAt },
      };
    });
    return result;
  }

  /**
   * 划拨单读模型（§6.2）：创建响应、幂等重放、详情共用。
   * 「原公司」一律按 sample_task_box 快照聚合（跨公司批量时 from 多条，D-12）；
   * status=已划拨 时逐台实时评估撤销守卫，给 revocable/reasonCode。
   */
  async transferView(taskId) {
    const row = await this.db.get("SELECT * FROM sample_task WHERE id=? AND kind='划拨'", [taskId]);
    if (!row) return null;
    const body = parse(row.body) || {};
    const links = await this.db.all(
      "SELECT box_id,org_id,owner_id,opens_start FROM sample_task_box WHERE task_id=? ORDER BY box_id",
      [taskId]
    );
    const depts = await this.db.all("SELECT id,name FROM sys_dept");
    const orgNameOf = new Map(depts.map((d) => [String(d.id), d.name]));
    const ownerIds = [...new Set(links.map((l) => String(l.owner_id ?? "")).filter(Boolean))];
    const owners = ownerIds.length
      ? await this.db.all(
          `SELECT id,nickname FROM sys_user WHERE id IN (${ownerIds.map(() => "?").join(",")})`,
          ownerIds
        )
      : [];
    const ownerNameOf = new Map(owners.map((u) => [String(u.id), u.nickname]));
    const fromMap = new Map();
    const boxes = [];
    for (const link of links) {
      const box = await this.db.get("SELECT id,name,life,org_id,opens FROM sample_box WHERE id=?", [
        link.box_id,
      ]);
      const orgId = String(link.org_id ?? "");
      const orgName = orgNameOf.get(orgId) || orgId || "总公司";
      const bucket = fromMap.get(orgId) || { orgId, orgName, count: 0 };
      bucket.count += 1;
      fromMap.set(orgId, bucket);
      const ownerId = String(link.owner_id ?? "");
      const hit = row.status === "已划拨" ? await revokeBlock(this.db, box, link, row) : null;
      boxes.push({
        boxId: link.box_id,
        code: link.box_id,
        name: box?.name || link.box_id,
        fromOrgId: orgId,
        fromOrg: orgName,
        fromOwnerId: ownerId,
        fromOwner: ownerNameOf.get(ownerId) || "",
        life: box?.life || "",
        revocable: row.status === "已划拨" && !hit,
        ...(hit ? { reasonCode: hit.reasonCode, reason: hit.reason } : {}),
      });
    }
    const revokeLog =
      row.status === "已撤销"
        ? await this.db.get(
            "SELECT created_at,note FROM sample_task_log WHERE task_id=? AND action='撤销划拨' ORDER BY created_at DESC LIMIT 1",
            [taskId]
          )
        : null;
    return {
      id: row.id,
      kind: row.kind,
      status: row.status,
      name: row.name,
      createdAt: row.created_at,
      toOrg: {
        id: String(row.to_org_id ?? ""),
        name: body.toOrg || orgNameOf.get(String(row.to_org_id ?? "")) || "",
      },
      from: [...fromMap.values()],
      boxCount: links.length,
      boxes,
      steps: [],
      ...(revokeLog ? { revokedAt: revokeLog.created_at, revokeReason: revokeLog.note || "" } : {}),
    };
  }

  /**
   * note、detail 记进流转记录；action 不填按状态取默认动作名。
   * handOver（R-5）：签收时传 { signerFit }，归属交接与状态更新同事务执行，任一台失败整体回滚；
   * 跳过明细持久化进本条流转记录的 detail.handOver，任务详情读最近一次交接结果。
   * 返回 { from: 推进前的状态, handOver: { moved, skipped } | null }。
   */
  async transition(
    id,
    status,
    {
      actor = {},
      note = "",
      detail = null,
      action = "",
      handOver = null,
      returnHandOver = null,
    } = {}
  ) {
    let from = "";
    let changed = [];
    let handOverResult = null;
    await this.db.transaction(async (tx) => {
      const task = await tx.get(
        "SELECT * FROM sample_task WHERE id=?" + (tx.dialect === "mysql" ? " FOR UPDATE" : ""),
        [id]
      );
      if (
        !task ||
        !nextOf({ ...JSON.parse(task.body), kind: task.kind }, task.status).includes(status)
      )
        throw conflict("任务状态已改变，请刷新后重试");
      const ids = await tx.all("SELECT box_id FROM sample_task_box WHERE task_id=?", [id]);
      if (["执行中", "运送中", "采样中"].includes(status)) {
        for (const { box_id } of ids) {
          // 带寄送的采样单在「运送中」就开始占用箱子，到「采样中」时已是本任务的，不再重复登记
          const busy = await tx.get("SELECT task_id FROM box_active_task WHERE box_id=?", [box_id]);
          if (busy && busy.task_id === id) {
            await tx.run(
              "UPDATE sample_task_box SET opens_start=(SELECT opens FROM sample_box WHERE id=?) WHERE task_id=? AND box_id=? AND opens_start IS NULL",
              [box_id, id, box_id]
            );
            continue;
          }
          if (busy) throw conflict(`${box_id} 已有执行中的任务`);
          await tx.run("INSERT INTO box_active_task (box_id,task_id) VALUES (?,?)", [box_id, id]);
          // 任务开始后箱子算「在途」，结束后没有别的进行中任务再回到「未使用」
          await tx.run("UPDATE sample_box SET life='在途' WHERE id=? AND life='未使用'", [box_id]);
          // 建单时已经记下开箱次数。这里只补旧单：当时还没记，就从这一步开始算。
          await tx.run(
            "UPDATE sample_task_box SET opens_start=(SELECT opens FROM sample_box WHERE id=?) WHERE task_id=? AND box_id=? AND opens_start IS NULL",
            [box_id, id, box_id]
          );
        }
      } else if (status === "已封箱") {
        // 记下封箱时的开箱次数：之后再开箱就是「封箱后开箱」
        await tx.run(
          "UPDATE sample_task_box SET opens_seal=(SELECT opens FROM sample_box WHERE id=sample_task_box.box_id) WHERE task_id=? AND opens_start IS NOT NULL",
          [id]
        );
      } else if (status === "待检测") {
        // 检测站签收：开箱次数到此为止（检测时开箱不算），箱子等着逐台扫码开始检测
        await tx.run(
          "UPDATE sample_task_box SET opens_end=(SELECT opens FROM sample_box WHERE id=sample_task_box.box_id) WHERE task_id=? AND opens_start IS NOT NULL AND opens_end IS NULL",
          [id]
        );
      } else if (status === "退回中") {
        // 退回（组织简化 D3）：箱子重新占用、生命周期回「在途」。
        // 从 待检测 退回时箱子本就占用（幂等）；从 已检测 退回时箱子已释放，这里重新登记，
        // 避免返程途中被别的单抢走。归属此刻不动，到「已退回」才回迁原寄出分公司。
        for (const { box_id } of ids) {
          const busy = await tx.get("SELECT task_id FROM box_active_task WHERE box_id=?", [box_id]);
          if (!busy)
            await tx.run("INSERT INTO box_active_task (box_id,task_id) VALUES (?,?)", [box_id, id]);
          await tx.run("UPDATE sample_box SET life='在途' WHERE id=? AND life='未使用'", [box_id]);
        }
      } else if (ENDED.includes(status)) {
        if (status === "已检测") {
          // 整张单一起「开始检测」：还没扫的箱子都记上；开箱超限作废的不检测，不记
          const voided = await voidBoxIds(tx, id, JSON.parse(task.body));
          const at = new Date().toISOString(),
            by = String(actor.name || "").slice(0, 64);
          for (const { box_id } of ids) {
            if (voided.has(box_id)) continue;
            await tx.run(
              "UPDATE sample_task_box SET inspected_at=?, inspected_by=? WHERE task_id=? AND box_id=? AND inspected_at IS NULL",
              [at, by, id, box_id]
            );
          }
        }
        await tx.run("DELETE FROM box_active_task WHERE task_id=?", [id]);
        for (const { box_id } of ids) {
          // 没有别的进行中任务、也没有别的没结束的单（这张单的状态还没改，要排除自己）才回到「未使用」
          await tx.run(
            `UPDATE sample_box SET life='未使用' WHERE id=? AND life='在途' AND NOT EXISTS (SELECT 1 FROM box_active_task WHERE box_id=?)
              AND NOT EXISTS (SELECT 1 FROM sample_task t JOIN sample_task_box m ON m.task_id=t.id WHERE m.box_id=? AND t.id<>? AND t.status NOT IN (${ENDED_SQL}) AND m.inspected_at IS NULL)`,
            [box_id, box_id, box_id, id]
          );
        }
        // 已经在签收时定下的（送检测站的单）不再改
        await tx.run(
          "UPDATE sample_task_box SET opens_end=(SELECT opens FROM sample_box WHERE id=sample_task_box.box_id) WHERE task_id=? AND opens_start IS NOT NULL AND opens_end IS NULL",
          [id]
        );
      }
      await tx.run("UPDATE sample_task SET status=? WHERE id=? AND status=?", [
        status,
        id,
        task.status,
      ]);
      // 签收交接（R-5）：归属迁移与状态更新同事务。放在状态更新之后、流转记录之前，
      // 跳过明细才能记进本条签收记录；任一台抛错整个事务回滚（状态、占用、归属都不留半成品）。
      if (handOver) {
        handOverResult = await handOverBoxes(
          tx,
          JSON.parse(task.body),
          ids.map((b) => b.box_id),
          handOver.signerFit || "none"
        );
        detail = {
          ...(detail || {}),
          handOver: {
            movedCount: handOverResult.moved.length,
            skippedCount: handOverResult.skipped.length,
            // detail 列是 TEXT（MySQL 64KB）：超大单只持久化前 200 台明细，总数另记
            skipped: handOverResult.skipped
              .slice(0, 200)
              .map(({ boxId, reason }) => ({ boxId, reason })),
          },
        };
      } else if (returnHandOver && status === "已退回") {
        // 退回交接（D3）：归属回迁原寄出分公司，与状态更新同事务，任一台失败整体回滚
        handOverResult = await returnHandOverBoxes(
          tx,
          JSON.parse(task.body),
          ids.map((b) => b.box_id)
        );
        detail = {
          ...(detail || {}),
          handOver: {
            movedCount: handOverResult.moved.length,
            skippedCount: handOverResult.skipped.length,
            skipped: handOverResult.skipped
              .slice(0, 200)
              .map(({ boxId, reason }) => ({ boxId, reason })),
          },
        };
      }
      await addTaskLog(tx, {
        taskId: id,
        status,
        action: action || TASK_ACTIONS[status] || status,
        actor,
        note,
        detail,
      });
      await this.refresh(
        ids.map((b) => b.box_id),
        tx
      );
      from = task.status;
      changed = ids.map((b) => b.box_id);
      for (const boxId of changed) await syncBoundTask(tx, boxId);
    });
    this.onPolicyChanged?.(changed);
    return { from, handOver: handOverResult };
  }

  /**
   * 检测站扫一台箱子「开始检测」：这台箱子的本次任务结束——不再占用、回到「未使用」、
   * 开箱次数定在签收那一刻（下一张单从头算，相当于清零）。全部箱子都开始检测后整张单变「已检测」。
   * 返回 { done: 整张单是否已结束, left: 还剩几台没检测 }。
   */
  async inspectBox(taskId, boxId, { actor = {} } = {}) {
    let result = { done: false, left: 0 };
    await this.db.transaction(async (tx) => {
      const task = await tx.get(
        "SELECT * FROM sample_task WHERE id=?" + (tx.dialect === "mysql" ? " FOR UPDATE" : ""),
        [taskId]
      );
      if (!task || task.status !== "待检测") throw conflict("这张单不在「待检测」，请刷新后重试");
      const link = await tx.get(
        "SELECT box_id, inspected_at FROM sample_task_box WHERE task_id=? AND box_id=?",
        [taskId, boxId]
      );
      if (!link) throw conflict("这台箱子不在这张任务单里");
      if (link.inspected_at) throw conflict("这台箱子已经开始检测了");
      // 开箱超过任务上限的箱子样品作废（强制签收也一样），不检测；整张单结束时一起释放
      const voided = await voidBoxIds(tx, taskId, JSON.parse(task.body));
      if (voided.has(boxId)) throw conflict("这台箱子开箱次数超过上限，样品已作废，不能开始检测");
      const now = new Date().toISOString();
      const by = String(actor.name || "").slice(0, 64);
      await tx.run(
        "UPDATE sample_task_box SET inspected_at=?, inspected_by=?, opens_end=COALESCE(opens_end,(SELECT opens FROM sample_box WHERE id=?)) WHERE task_id=? AND box_id=?",
        [now, by, boxId, taskId, boxId]
      );
      await tx.run("DELETE FROM box_active_task WHERE box_id=? AND task_id=?", [boxId, taskId]);
      await tx.run(
        `UPDATE sample_box SET life='未使用' WHERE id=? AND life='在途' AND NOT EXISTS (SELECT 1 FROM box_active_task WHERE box_id=?)
          AND NOT EXISTS (SELECT 1 FROM sample_task t JOIN sample_task_box m ON m.task_id=t.id WHERE m.box_id=? AND t.status NOT IN (${ENDED_SQL}) AND m.inspected_at IS NULL)`,
        [boxId, boxId, boxId]
      );
      const box = await tx.get("SELECT name FROM sample_box WHERE id=?", [boxId]);
      await addTaskLog(tx, {
        taskId,
        status: "待检测",
        action: "开始检测",
        actor,
        note: box?.name || boxId,
        at: now,
      });
      const waiting = await tx.all(
        "SELECT box_id FROM sample_task_box WHERE task_id=? AND inspected_at IS NULL",
        [taskId]
      );
      const left = waiting.filter((row) => !voided.has(row.box_id)).length;
      const released = [boxId];
      if (left === 0) {
        await tx.run("DELETE FROM box_active_task WHERE task_id=?", [taskId]);
        await tx.run("UPDATE sample_task SET status='已检测' WHERE id=? AND status='待检测'", [
          taskId,
        ]);
        // 作废的箱子不检测，整张单结束时一起回到「未使用」
        for (const { box_id } of waiting) {
          await tx.run(
            `UPDATE sample_box SET life='未使用' WHERE id=? AND life='在途' AND NOT EXISTS (SELECT 1 FROM box_active_task WHERE box_id=?)
              AND NOT EXISTS (SELECT 1 FROM sample_task t JOIN sample_task_box m ON m.task_id=t.id WHERE m.box_id=? AND t.status NOT IN (${ENDED_SQL}) AND m.inspected_at IS NULL)`,
            [box_id, box_id, box_id]
          );
          released.push(box_id);
        }
        const note = waiting.length
          ? `其余箱子已开始检测，${waiting.length} 台开箱超限作废、不检测`
          : "全部箱子已开始检测";
        // 晚 1 毫秒，流转记录按时间排时一定在最后一台「开始检测」之后
        await addTaskLog(tx, {
          taskId,
          status: "已检测",
          action: "检测完成",
          actor,
          note,
          at: new Date(Date.parse(now) + 1).toISOString(),
        });
      }
      await this.refresh(released, tx);
      for (const boxId of released) await syncBoundTask(tx, boxId);
      result = { done: left === 0, left };
    });
    this.onPolicyChanged?.([boxId]);
    return result;
  }
}

/** 推进到某个状态时，流转记录里写的动作名。 */
export const TASK_ACTIONS = {
  执行中: "开始执行",
  已完成: "完成",
  运送中: "确认寄出",
  待签收: "确认到达",
  已签收: "签收",
  已拒收: "拒收",
  已取消: "取消",
  // 送检测站的单：签收后待检测，整张单一起开始检测
  待检测: "签收",
  已检测: "全部开始检测",
  // 调拨单拒收时选了退回寄出单位，寄出方收到后接收
  退回中: "拒收并退回",
  已退回: "接收退回",
  采样中: "开始采样",
  已封箱: "封箱",
  // 合并采样单：封箱后寄往唯一检测站
  在途: "寄出",
  待核验: "到达核验点",
  // 带寄送的旧采样单：箱子寄到采样单位
  待采样: "确认到达",
};

/**
 * B3/#18 占用锚点维护：重算箱子当前「未结束且未检测」的最早任务，写 bound_task_id/bound_task_at。
 * bound_task_at 用 formatTimestamp 墙钟（与 onlineSql 的 now 同格式），避免 ISO/墙钟混比。
 * 在建单/流转/开始检测的事务内调用，保证占用与锚点同事务一致。
 */
async function syncBoundTask(db, boxId) {
  const row = await db.get(
    `SELECT t.id, t.created_at FROM sample_task_box m JOIN sample_task t ON t.id=m.task_id
     WHERE m.box_id=? AND t.status NOT IN (${ENDED_SQL}) AND m.inspected_at IS NULL
     ORDER BY t.created_at LIMIT 1`,
    [boxId]
  );
  const at = row ? formatTimestamp(new Date(row.created_at)).slice(0, 19) : "";
  await db.run("UPDATE sample_box SET bound_task_id=?, bound_task_at=? WHERE id=?", [
    row ? row.id : "",
    at,
    boxId,
  ]);
}

async function addTaskLog(
  tx,
  { taskId, status, action, actor = {}, note = "", detail = null, at = null }
) {
  await tx.run(
    "INSERT INTO sample_task_log (id,task_id,status,action,actor_id,actor_name,note,detail,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
    [
      randomUUID(),
      taskId,
      status,
      action,
      String(actor.id || ""),
      String(actor.name || "").slice(0, 64),
      String(note || "").slice(0, 1000),
      detail ? JSON.stringify(detail) : null,
      at || new Date().toISOString(),
    ]
  );
}
