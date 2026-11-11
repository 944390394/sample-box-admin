import { createHash, randomUUID } from "node:crypto";
import { ENDED, ENDED_SQL, initialOf, nextOf } from "./taskFlow.js";
import {
  currentBoxSettings,
  firmwareAcceptsConfig,
  firmwareSupportsIndicators,
  firmwareSupportsQueueAck,
  firmwareSupportsLink,
} from "./boxConfig.js";

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
    throw new Error("上报周期必须是 5–3600 秒的整数");
  if (typeof input.reportOnlyWhenCharging !== "boolean") throw new Error("请选择定时上报模式");
  if (input.indicators != null && typeof input.indicators !== "boolean")
    throw new Error("请选择指示灯模式");
  if (input.moduleLed != null && typeof input.moduleLed !== "boolean")
    throw new Error("请选择模块指示灯模式");
  if (input.periodicGps != null && typeof input.periodicGps !== "boolean")
    throw new Error("请选择定位策略");
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
    if (!["single", "batch"].includes(layer)) throw new Error("策略层级不正确");
    const value = stamped(policy);
    await this.db.transaction(async (tx) => {
      for (const id of ids) {
        const box = await tx.get(
          "SELECT id FROM sample_box WHERE id=?" + (tx.dialect === "mysql" ? " FOR UPDATE" : ""),
          [id]
        );
        if (!box) throw new Error("采样箱已删除，请刷新后重试");
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
    if (uplink.why === "boot")
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
    const id = `TK-${Date.now()}-${randomUUID().slice(0, 6)}`;
    const initial = initialOf(input);
    // 带寄送的采样单：接收方是采样单位，记进 to_org_id，采样单位不管箱子也能看到这张单
    const toOrgId = input.kind === "采样" && input.trip ? input.orgId : input.toOrgId;
    const body = {
      ...input,
      policy: stamped(input.policy),
      overrides: Object.fromEntries(
        Object.entries(input.overrides || {}).map(([k, v]) => [k, stamped(v)])
      ),
    };
    await this.db.transaction(async (tx) => {
      const snapshots = new Map();
      for (const boxId of [...input.boxIds].sort()) {
        const box = await tx.get(
          "SELECT id,name,life,org_id,owner_id FROM sample_box WHERE id=?" +
            (tx.dialect === "mysql" ? " FOR UPDATE" : ""),
          [boxId]
        );
        if (!box || box.life === "停用") throw new Error("采样箱已删除或停用，请刷新后重试");
        // 一台箱子同时只能在一张没结束的任务单里（还没开始的也算）
        // 检测站已开始检测的箱子，这张单对它来说已经结束
        const busy = await tx.get(
          `SELECT t.name FROM sample_task t JOIN sample_task_box m ON m.task_id=t.id WHERE m.box_id=? AND t.status NOT IN (${ENDED_SQL}) AND m.inspected_at IS NULL LIMIT 1`,
          [boxId]
        );
        if (busy)
          throw new Error(
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
        "INSERT INTO sample_task (id,name,kind,status,body,created_at,from_org_id,to_org_id) VALUES (?,?,?,?,?,?,?,?)",
        [
          id,
          input.name,
          input.kind,
          initial,
          JSON.stringify(body),
          new Date().toISOString(),
          input.fromOrgId || null,
          toOrgId || null,
        ]
      );
      for (const boxId of input.boxIds) {
        const box = snapshots.get(boxId);
        await tx.run(
          "INSERT INTO sample_task_box (task_id,box_id,org_id,owner_id) VALUES (?,?,?,?)",
          [id, boxId, box.org_id, box.owner_id]
        );
        // 建单就占用：箱子显示「在途」，选箱时不再出现在「可用」里。
        // 任务策略：旧固件等任务开始才生效；1.0.17 起建单即按 assignedPolicies 快照下发，任务期间不变
        await tx.run("UPDATE sample_box SET life='在途' WHERE id=? AND life='未使用'", [boxId]);
      }
      await this.refresh(input.boxIds, tx);
      await addTaskLog(tx, { taskId: id, status: initial, action: "创建", actor });
    });
    this.onPolicyChanged?.(input.boxIds);
    return id;
  }

  /** note、detail 记进流转记录；action 不填按状态取默认动作名。返回推进前的状态。 */
  async transition(id, status, { actor = {}, note = "", detail = null, action = "" } = {}) {
    let from = "";
    let changed = [];
    await this.db.transaction(async (tx) => {
      const task = await tx.get(
        "SELECT * FROM sample_task WHERE id=?" + (tx.dialect === "mysql" ? " FOR UPDATE" : ""),
        [id]
      );
      if (
        !task ||
        !nextOf({ ...JSON.parse(task.body), kind: task.kind }, task.status).includes(status)
      )
        throw new Error("任务状态已改变，请刷新后重试");
      const ids = await tx.all("SELECT box_id FROM sample_task_box WHERE task_id=?", [id]);
      if (["执行中", "运送中", "采样中"].includes(status)) {
        for (const { box_id } of ids) {
          // 带寄送的采样单在「运送中」就开始占用箱子，到「采样中」时已是本任务的，不再重复登记
          const busy = await tx.get("SELECT task_id FROM box_active_task WHERE box_id=?", [box_id]);
          if (busy && busy.task_id === id) continue;
          if (busy) throw new Error(`${box_id} 已有执行中的任务`);
          await tx.run("INSERT INTO box_active_task (box_id,task_id) VALUES (?,?)", [box_id, id]);
          // 任务开始后箱子算「在途」，结束后没有别的进行中任务再回到「未使用」
          await tx.run("UPDATE sample_box SET life='在途' WHERE id=? AND life='未使用'", [box_id]);
          // 记下开始时的开箱次数，任务期间开了几次 = 当前 − 开始
          await tx.run(
            "UPDATE sample_task_box SET opens_start=(SELECT opens FROM sample_box WHERE id=?) WHERE task_id=? AND box_id=?",
            [box_id, id, box_id]
          );
        }
      } else if (status === "待检测") {
        // 检测站签收：开箱次数到此为止（检测时开箱不算），箱子等着逐台扫码开始检测
        await tx.run(
          "UPDATE sample_task_box SET opens_end=(SELECT opens FROM sample_box WHERE id=sample_task_box.box_id) WHERE task_id=? AND opens_start IS NOT NULL AND opens_end IS NULL",
          [id]
        );
      } else if (ENDED.includes(status)) {
        if (status === "已检测") {
          // 整张单一起「开始检测」：还没扫的箱子都记上
          await tx.run(
            "UPDATE sample_task_box SET inspected_at=?, inspected_by=? WHERE task_id=? AND inspected_at IS NULL",
            [new Date().toISOString(), String(actor.name || "").slice(0, 64), id]
          );
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
    });
    this.onPolicyChanged?.(changed);
    return from;
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
      if (!task || task.status !== "待检测") throw new Error("这张单不在「待检测」，请刷新后重试");
      const link = await tx.get(
        "SELECT box_id, inspected_at FROM sample_task_box WHERE task_id=? AND box_id=?",
        [taskId, boxId]
      );
      if (!link) throw new Error("这台箱子不在这张任务单里");
      if (link.inspected_at) throw new Error("这台箱子已经开始检测了");
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
      const left = Number(
        (
          await tx.get(
            "SELECT COUNT(*) AS n FROM sample_task_box WHERE task_id=? AND inspected_at IS NULL",
            [taskId]
          )
        ).n
      );
      if (left === 0) {
        await tx.run("DELETE FROM box_active_task WHERE task_id=?", [taskId]);
        await tx.run("UPDATE sample_task SET status='已检测' WHERE id=? AND status='待检测'", [
          taskId,
        ]);
        // 晚 1 毫秒，流转记录按时间排时一定在最后一台「开始检测」之后
        await addTaskLog(tx, {
          taskId,
          status: "已检测",
          action: "检测完成",
          actor,
          note: "全部箱子已开始检测",
          at: new Date(Date.parse(now) + 1).toISOString(),
        });
      }
      await this.refresh([boxId], tx);
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
  在途: "寄回",
  待核验: "到达核验点",
  // 带寄送的采样单：箱子寄到采样单位
  待采样: "确认到达",
};

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
