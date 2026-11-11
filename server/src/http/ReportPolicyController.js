import { filterEvents, limits } from "./SampleController.js";
import { canSee, flagAllowed, scopeSql, BOX } from "../auth/boxAccess.js";
import { POLICY_PERMS as P, supportsDispatch, validatePolicy } from "../settings/ReportPolicy.js";
import { audit } from "../log/audit.js";
import { currentBoxSettings } from "../settings/boxConfig.js";
import { effectiveDeptLocation, hasCoords, readPlace } from "../geo/place.js";
import { taskTrack, taskWindow } from "../settings/taskTrack.js";
import { maskBox, maskUplink } from "../auth/boxAccess.js";
import { readCameras } from "../settings/deptCameras.js";
import { receiveCheck } from "../settings/receiveCheck.js";

/** 任务相关的新权限码，见 permCatalog TASK_PERMS。 */
const T = {
  createTransfer: "task:create:transfer",
  createSample: "task:create:sample",
  policy: "task:policy",
  send: "task:send",
  arrive: "task:arrive",
  sign: "task:sign",
  reject: "task:reject",
  rejectReturn: "task:reject-return",
  forceSign: "task:force-sign",
  acceptReturn: "task:accept-return",
  inspect: "task:inspect",
  sampleStart: "task:sample-start",
  seal: "task:seal",
  finish: "task:finish",
  sendBack: "task:send-back",
  cancel: "task:cancel",
  video: "task:video",
  camera: "task:camera",
  videoRetry: "task:video-retry",
  log: "task:log",
};
import {
  MOVING,
  boxDistances,
  distanceSnapshot,
  openCounts,
  overOpenLimit,
  radiusOf,
  targetOf,
} from "../settings/taskPlaces.js";

import { ENDED, ENDED_SQL, TRIPS, nextOf, signTargetOf, stepsOf } from "../settings/taskFlow.js";

/** 签收人以外的人代签：流转里记成「已签收」，动作名记「强制签收」。 */
const FORCE_SIGN = "强制签收";

function inScope(ctx, orgId) {
  const scope = ctx.access?.scope;
  return !scope || scope.all || scope.orgIds.includes(String(orgId ?? ""));
}

/** 当前用户是不是调拨单指定的签收人。 */
function isSigner(ctx, task) {
  return Boolean(task.signerId) && String(ctx.user?.id ?? "") === String(task.signerId);
}

function actorOf(ctx) {
  return { id: ctx.user?.id, name: ctx.user?.nickname || ctx.user?.username || "" };
}

/** 所有策略写入都再次校验目标设备范围；批量操作不接受客户端声称的权限。 */
export class ReportPolicyController {
  constructor(boxes, policies) {
    this.boxes = boxes;
    this.policies = policies;
    this.db = policies.db;
  }
  require(ctx, perm) {
    if (!ctx.access?.perms?.has(perm))
      throw Object.assign(new Error("没有这项操作权限"), { httpStatus: 403, publicCode: "A0301" });
  }
  async targets(ctx, ids) {
    if (
      !Array.isArray(ids) ||
      !ids.length ||
      ids.length > 10000 ||
      ids.some((id) => typeof id !== "string" || id.length > 64)
    )
      throw new Error("请选择 1–10000 台采样箱");
    const unique = [...new Set(ids)],
      result = [];
    for (let i = 0; i < unique.length; i += 200) {
      const part = unique.slice(i, i + 200);
      const rows = await this.db.all(
        `SELECT * FROM sample_box WHERE id IN (${part.map(() => "?").join(",")})`,
        part
      );
      if (
        rows.length !== part.length ||
        rows.some(
          (b) =>
            !canSee(ctx.access, {
              orgId: String(b.org_id ?? ""),
              ownerId: String(b.owner_id ?? ""),
            })
        )
      )
        throw new Error("部分采样箱不存在或不在你的管理范围内，请刷新选择");
      result.push(...rows);
    }
    return result;
  }
  async read(ctx) {
    this.require(ctx, P.read);
    const [box] = await this.targets(ctx, [ctx.params.id]);
    ctx.ok(await this.policies.get(box));
  }
  async save(ctx) {
    this.require(ctx, P.single);
    await this.targets(ctx, [ctx.params.id]);
    const policy = validatePolicy(ctx.body.policy);
    await this.policies.save([ctx.params.id], "single", policy);
    await this.log(ctx, policy ? "设置单箱上报策略" : "恢复上报策略继承", ctx.params.id);
    ctx.ok({ saved: true });
  }
  async preview(ctx) {
    this.require(ctx, P.batch);
    let ids = ctx.body.ids;
    if (ctx.body.filter) {
      this.require(ctx, BOX.list);
      const filter = ctx.body.filter;
      if (
        (filter.q && (typeof filter.q !== "string" || filter.q.length > 100)) ||
        (filter.life && !["待激活", "未使用", "在途", "停用"].includes(filter.life)) ||
        (filter.flag && !["alert", "offline", "low", "lid", "ready"].includes(filter.flag))
      )
        throw new Error("筛选条件不正确");
      if (filter.flag && !flagAllowed(filter.flag, ctx.access.perms))
        this.require(ctx, filter.flag === "lid" ? BOX.lid : BOX.power);
      if (Object.keys(filter).some((k) => !["q", "life", "flag"].includes(k)))
        throw new Error("筛选条件不正确");
      const rows = [];
      // 只分页读取当前状态表，冻结本次目标，提交时不会扩大到新匹配的箱子。
      for (let page = 1; page <= 101; page++) {
        const result = await this.boxes.page({
          ...filter,
          page,
          pageSize: 100,
          limits: limits(),
          scope: ctx.access.scope,
          matchImei: ctx.access.perms.has(BOX.identity),
        });
        if (result.total > 10000)
          throw new Error("单次最多设置 10000 台，请缩小筛选范围后分批操作");
        rows.push(...result.list.map((b) => b.id));
        if (rows.length >= result.total) break;
      }
      ids = rows;
    }
    const boxes = await this.targets(ctx, ids);
    let overridden = 0;
    for (const box of boxes) {
      const p = await this.policies.get(box);
      if (
        (p.taskId && supportsDispatch(box.firmware)) ||
        ["单箱设置", "任务内单箱", "任务统一"].includes(p.effective.source)
      )
        overridden++;
    }
    ctx.ok({ ids: boxes.map((b) => b.id), total: boxes.length, overridden });
  }
  async batch(ctx) {
    this.require(ctx, P.batch);
    const boxes = await this.targets(ctx, ctx.body.ids);
    const policy = validatePolicy(ctx.body.policy);
    await this.policies.save(
      boxes.map((b) => b.id),
      "batch",
      policy
    );
    await this.log(
      ctx,
      `批量${policy ? "设置" : "清除"}上报策略（${boxes.length}台）`,
      boxes
        .slice(0, 3)
        .map((b) => b.id)
        .join(",")
    );
    ctx.ok({ saved: boxes.length });
  }
  async createTask(ctx) {
    const input = ctx.body;
    this.require(ctx, input?.kind === "调拨" ? T.createTransfer : T.createSample);
    // 任务期间的上报策略、单箱例外单独授权
    if (input?.policy != null || Object.keys(input?.overrides || {}).length)
      this.require(ctx, T.policy);
    const boxes = await this.targets(ctx, input.boxIds);
    if (boxes.length > 100) throw new Error("一张任务单最多绑定 100 台箱子");
    if (boxes.some((b) => b.life === "停用")) throw new Error("停用的箱子不能绑定任务");
    if (
      typeof input.name !== "string" ||
      !input.name.trim() ||
      input.name.length > 120 ||
      !["采样", "调拨"].includes(input.kind)
    )
      throw new Error("请填写任务名称和类型");
    if (
      input.overrides != null &&
      (typeof input.overrides !== "object" || Array.isArray(input.overrides))
    )
      throw new Error("单箱策略格式不正确");
    const overrides = {};
    for (const [id, value] of Object.entries(input.overrides || {})) {
      if (!boxes.some((b) => b.id === id)) throw new Error("单箱策略必须属于任务绑定的箱子");
      overrides[id] = validatePolicy(value);
    }
    const metadata = {};
    for (const key of [
      "fromOrg",
      "toOrg",
      "sender",
      "signer",
      "place",
      "people",
      "note",
      "sample",
    ]) {
      if (input[key] != null && (typeof input[key] !== "string" || input[key].length > 1000))
        throw new Error("任务字段格式不正确");
      metadata[key] = input[key] || "";
    }
    const depts = await this.db.all("SELECT id,name,status,type FROM sys_dept");
    const deptOf = (id) =>
      id == null || id === "" ? null : depts.find((row) => String(row.id) === String(id)) || null;
    if (input.kind === "调拨") {
      // 新页面选单位，名称以库里为准；旧调用只给文字时照旧保存
      if (input.fromOrgId != null || input.toOrgId != null) {
        const from = deptOf(input.fromOrgId),
          to = deptOf(input.toOrgId);
        if (!from || !to) throw new Error("请选择寄出和接收单位");
        if (String(from.id) === String(to.id)) throw new Error("寄出和接收单位不能相同");
        if (!inScope(ctx, from.id)) throw new Error("寄出单位不在你的管理范围内");
        Object.assign(metadata, {
          fromOrgId: String(from.id),
          fromOrg: from.name,
          toOrgId: String(to.id),
          toOrg: to.name,
        });
      }
      metadata.fromPlace = readPlace(input.fromPlace);
      metadata.toPlace = readPlace(input.toPlace);
      for (const [idKey, nameKey] of [
        ["senderId", "sender"],
        ["signerId", "signer"],
      ]) {
        if (input[idKey] == null || input[idKey] === "") continue;
        const user = await this.db.get("SELECT id,nickname FROM sys_user WHERE id=? AND status=1", [
          String(input[idKey]),
        ]);
        if (!user) throw new Error("寄出人或签收人不存在或已停用");
        metadata[idKey] = String(user.id);
        metadata[nameKey] = user.nickname;
      }
    } else {
      if (input.trip != null && input.trip !== "") {
        // 带寄送：寄出单位把箱子寄给采样单位；双向的封箱后寄回寄出单位
        if (!TRIPS.includes(input.trip)) throw new Error("寄送方式只能是单向或双向");
        const from = deptOf(input.fromOrgId),
          org = deptOf(input.orgId);
        if (!from || !org) throw new Error("寄送采样箱要选择寄出单位和采样单位");
        if (String(from.id) === String(org.id)) throw new Error("寄出单位和采样单位不能相同");
        if (!inScope(ctx, from.id)) throw new Error("寄出单位不在你的管理范围内");
        Object.assign(metadata, {
          trip: input.trip,
          fromOrgId: String(from.id),
          fromOrg: from.name,
          fromPlace: readPlace(input.fromPlace),
        });
        if (input.senderId != null && input.senderId !== "") {
          const user = await this.db.get(
            "SELECT id,nickname FROM sys_user WHERE id=? AND status=1",
            [String(input.senderId)]
          );
          if (!user) throw new Error("寄出人不存在或已停用");
          Object.assign(metadata, { senderId: String(user.id), sender: user.nickname });
        }
        if (!metadata.sender) throw new Error("请填写寄出人");
      }
      if (input.orgId != null && input.orgId !== "") {
        const org = deptOf(input.orgId);
        if (!org) throw new Error("采样单位不存在");
        metadata.orgId = String(org.id);
        metadata.org = org.name;
      }
      metadata.placeAt = readPlace(input.placeAt);
      if (metadata.placeAt?.address && !metadata.place) metadata.place = metadata.placeAt.address;
      // 开箱录像只给采样机构：采样单位必须是「采样机构」类型
      if (input.recordVideo) {
        const org = deptOf(input.orgId);
        if (!org || org.type !== "采样机构")
          throw new Error("只有采样单位是采样机构时才能要求开箱录像");
        metadata.recordVideo = true;
      }
    }
    if (input.kind === "调拨" && input.recordVideo) throw new Error("调拨任务不能要求开箱录像");
    // 签收方是采样机构（就是检测站；调拨的接收单位、双向采样单寄回的寄出单位）：签收后待检测，逐台扫码开始检测
    const receiver =
      input.kind === "调拨"
        ? deptOf(metadata.toOrgId)
        : metadata.trip === "双向"
          ? deptOf(metadata.fromOrgId)
          : null;
    if (receiver?.type === "采样机构") metadata.inspect = true;
    metadata.createdBy = actorOf(ctx).name;
    // 任务期间每台箱子最多开几次箱，不填不限
    if (input.maxOpens != null && input.maxOpens !== "") {
      const max = Number(input.maxOpens);
      if (!Number.isInteger(max) || max < 0 || max > 999)
        throw new Error("开箱次数上限要在 0 到 999 之间");
      metadata.maxOpens = max;
    }
    if (
      input.kind === "调拨" &&
      (!metadata.fromOrg ||
        !metadata.toOrg ||
        !metadata.sender ||
        !metadata.signer ||
        metadata.fromOrg === metadata.toOrg)
    )
      throw new Error("请填写不同的寄出、接收公司及寄出人、签收人");
    const id = await this.policies.createTask(
      {
        ...metadata,
        name: input.name.trim(),
        kind: input.kind,
        fromOrgId: metadata.fromOrgId,
        toOrgId: metadata.toOrgId,
        orgId: metadata.orgId,
        boxIds: boxes.map((b) => b.id),
        policy: validatePolicy(input.policy),
        overrides,
      },
      actorOf(ctx)
    );
    await this.log(ctx, "创建任务单", id);
    ctx.ok({ id });
  }

  /**
   * 能看到的任务：绑定的箱子都在自己范围内（按历史快照），
   * 或者自己是调拨单的寄出、接收单位——接收方看不到寄出方的箱子，也要能签收。
   */
  #visible(ctx) {
    const scope = scopeSql(ctx.access.scope);
    if (!scope) return { sql: "", params: [] };
    const historicalScope = scope.sql
      .replace(/\borg_id\b/g, "COALESCE(b.org_id,m.org_id,'')")
      .replace(/\bowner_id\b/g, "COALESCE(b.owner_id,m.owner_id,'')");
    const orgIds = ctx.access.scope.orgIds;
    const own = orgIds.length
      ? ` OR t.from_org_id IN (${orgIds.map(() => "?").join(",")}) OR t.to_org_id IN (${orgIds.map(() => "?").join(",")})`
      : "";
    return {
      sql: `(NOT EXISTS (SELECT 1 FROM sample_task_box m LEFT JOIN sample_box b ON b.id=m.box_id WHERE m.task_id=t.id AND NOT (${historicalScope}))${own})`,
      params: [...scope.params, ...orgIds, ...orgIds],
    };
  }

  #taskView(ctx, row) {
    const body = JSON.parse(row.body);
    if (!ctx.access.perms.has(P.read)) {
      delete body.policy;
      delete body.overrides;
    }
    return {
      ...body,
      id: row.id,
      status: row.status,
      createdAt: row.created_at,
      steps: stepsOf({ ...body, kind: row.kind, status: row.status }),
    };
  }

  /**
   * 任务列表。筛选：类型、状态（含「进行中」「已结束」）、单位、创建日期、关键字（任务名、编号、箱号、箱子名称）。
   * mine=1 只列我现在能推进的任务。counts 是同样筛选下各状态的数量，给页面上的状态标签用。
   */
  async tasks(ctx) {
    this.require(ctx, BOX.task);
    const visible = this.#visible(ctx);
    const clauses = visible.sql ? [visible.sql] : [];
    const params = [...visible.params];
    if (ctx.query.boxId) {
      await this.targets(ctx, [ctx.query.boxId]);
      clauses.push("EXISTS (SELECT 1 FROM sample_task_box m WHERE m.task_id=t.id AND m.box_id=?)");
      params.push(ctx.query.boxId);
    }
    if (["采样", "调拨"].includes(ctx.query.kind)) {
      clauses.push("t.kind=?");
      params.push(ctx.query.kind);
    }
    const orgId = typeof ctx.query.orgId === "string" ? ctx.query.orgId.slice(0, 32) : "";
    if (orgId) {
      clauses.push("(t.from_org_id=? OR t.to_org_id=? OR t.body LIKE ?)");
      params.push(orgId, orgId, `%"orgId":"${orgId.replace(/[%_]/g, "")}"%`);
    }
    const day = (value, endOfDay) => {
      if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
      const date = new Date(`${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}`);
      return Number.isNaN(date.getTime()) ? null : date.toISOString();
    };
    const from = day(ctx.query.from, false),
      to = day(ctx.query.to, true);
    if (from) {
      clauses.push("t.created_at>=?");
      params.push(from);
    }
    if (to) {
      clauses.push("t.created_at<=?");
      params.push(to);
    }
    const q = typeof ctx.query.q === "string" ? ctx.query.q.trim().slice(0, 60) : "";
    if (q) {
      clauses.push(
        "(t.id LIKE ? OR t.name LIKE ? OR EXISTS (SELECT 1 FROM sample_task_box m LEFT JOIN sample_box b ON b.id=m.box_id WHERE m.task_id=t.id AND (m.box_id LIKE ? OR b.name LIKE ?)))"
      );
      params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
    }
    const base = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    // 各状态数量（不受状态筛选影响）
    const grouped = await this.db.all(
      `SELECT t.status, COUNT(*) AS n FROM sample_task t ${base} GROUP BY t.status`,
      params
    );
    const counts = { 全部: 0, 进行中: 0, 已结束: 0 };
    for (const row of grouped) {
      const n = Number(row.n);
      counts[row.status] = n;
      counts.全部 += n;
      counts[ENDED.includes(row.status) ? "已结束" : "进行中"] += n;
    }
    // 我能推进的：只在进行中的任务里找，最多看 500 张
    const activeRows = await this.db.all(
      `SELECT t.* FROM sample_task t ${base ? `${base} AND` : "WHERE"} t.status NOT IN (${ENDED_SQL}) ORDER BY created_at DESC LIMIT 500`,
      params
    );
    const mineRows = activeRows.filter((row) =>
      Object.values(this.#abilities(ctx, JSON.parse(row.body), row.status)).some(Boolean)
    );
    counts.mine = mineRows.length;

    const statusClauses = [...clauses],
      statusParams = [...params];
    if (ctx.query.status === "进行中") statusClauses.push(`t.status NOT IN (${ENDED_SQL})`);
    else if (ctx.query.status === "已结束") statusClauses.push(`t.status IN (${ENDED_SQL})`);
    else if (
      typeof ctx.query.status === "string" &&
      ctx.query.status &&
      ctx.query.status.length <= 16
    ) {
      statusClauses.push("t.status=?");
      statusParams.push(ctx.query.status);
    }
    const where = statusClauses.length ? `WHERE ${statusClauses.join(" AND ")}` : "";
    const page = Math.max(1, Math.floor(Number(ctx.query.page) || 1));
    const pageSize = Math.min(100, Math.max(1, Math.floor(Number(ctx.query.pageSize) || 20)));
    let rows, total;
    if (ctx.query.mine === "1") {
      total = mineRows.length;
      rows = mineRows.slice((page - 1) * pageSize, page * pageSize);
    } else {
      rows = await this.db.all(
        `SELECT t.* FROM sample_task t ${where} ORDER BY created_at DESC,id DESC LIMIT ${pageSize} OFFSET ?`,
        [...statusParams, (page - 1) * pageSize]
      );
      total = Number(
        (await this.db.get(`SELECT COUNT(*) AS n FROM sample_task t ${where}`, statusParams)).n
      );
    }
    const withPosition = ctx.access.perms.has(BOX.location);
    const list = [];
    for (const row of rows) {
      const task = this.#taskView(ctx, row);
      // 正在去某地的任务，算出有几台已到附近
      const target = MOVING.includes(row.status) ? targetOf(task, row.status) : null;
      if (target && withPosition && hasCoords(target)) {
        const boxes = await boxDistances(this.db, task.boxIds || [], target);
        task.arrival = {
          role: target.role,
          near: boxes.filter((b) => b.near).length,
          total: boxes.length,
        };
      }
      if (Number.isInteger(task.maxOpens))
        task.openOver = overOpenLimit(task, await openCounts(this.db, row.id)).length;
      task.actions = Object.entries(this.#abilities(ctx, task, row.status))
        .filter(([, ok]) => ok)
        .map(([to]) => to);
      list.push(task);
    }
    ctx.ok({ list, total, counts });
  }

  /** 创建页的候选：所有启用单位（含有效位置、是否在自己范围内），选了单位再取人员。 */
  async taskOptions(ctx) {
    if (!ctx.access?.perms?.has(T.createTransfer)) this.require(ctx, T.createSample);
    const rows = await this.db.all(
      "SELECT d.*, u.nickname AS leader_name FROM sys_dept d LEFT JOIN sys_user u ON u.id = d.leader_user_id AND u.status = 1 WHERE d.status = 1"
    );
    const byId = new Map(rows.map((row) => [String(row.id), row]));
    const pathOf = (id) => {
      const names = [];
      const seen = new Set();
      for (
        let cursor = byId.get(String(id));
        cursor && !seen.has(String(cursor.id));
        cursor = byId.get(String(cursor.parent_id))
      ) {
        seen.add(String(cursor.id));
        names.unshift(cursor.name);
      }
      return names.join(" / ");
    };
    const orgs = rows
      .map((row) => ({
        id: String(row.id),
        parentId: String(row.parent_id),
        name: row.name,
        type: row.type || "公司",
        path: pathOf(row.id),
        inScope: inScope(ctx, row.id),
        location: effectiveDeptLocation(rows, row.id),
        leader: row.leader_name ? { id: String(row.leader_user_id), name: row.leader_name } : null,
      }))
      .sort((a, b) => a.path.localeCompare(b.path, "zh-CN"));
    let users = [];
    const orgId = String(ctx.query.orgId || "");
    if (byId.has(orgId)) {
      const ids = [
        orgId,
        ...orgs.filter((org) => org.path.startsWith(`${pathOf(orgId)} / `)).map((org) => org.id),
      ];
      const found = await this.db.all(
        `SELECT id,nickname,dept_id FROM sys_user WHERE status=1 AND dept_id IN (${ids.map(() => "?").join(",")}) ORDER BY nickname LIMIT 200`,
        ids
      );
      users = found.map((row) => ({
        id: String(row.id),
        name: row.nickname,
        dept: pathOf(row.dept_id),
      }));
    }
    ctx.ok({
      orgs,
      users,
      myOrgId: String(ctx.user?.dept_id || ""),
      arriveRadiusM: currentBoxSettings().arriveRadiusM,
    });
  }

  /** 任务详情：任务、流转记录、各箱当前位置和到当前目标的距离。 */
  async taskDetail(ctx) {
    this.require(ctx, BOX.task);
    const visible = this.#visible(ctx);
    const row = await this.db.get(
      `SELECT t.* FROM sample_task t WHERE t.id=?${visible.sql ? ` AND ${visible.sql}` : ""}`,
      [ctx.params.id, ...visible.params]
    );
    if (!row)
      throw Object.assign(new Error("任务不存在或不在你的管理范围内"), {
        httpStatus: 404,
        publicCode: "A0404",
      });
    const task = this.#taskView(ctx, row);
    const logs = await this.db.all(
      "SELECT * FROM sample_task_log WHERE task_id=? ORDER BY created_at, id",
      [row.id]
    );
    const target = targetOf(task, row.status);
    const withPosition = ctx.access.perms.has(BOX.location);
    const counts = await openCounts(this.db, row.id);
    const perms0 = ctx.access.perms;
    // 工况按字段给：电量、充电、箱盖、信号各要各的权限；一项都没有时 status 为空
    const statusOf = (state) => {
      if (!state) return null;
      const out = { alert: state.alert };
      let any = false;
      if (perms0.has(BOX.power)) {
        out.battery = state.battery;
        out.batteryUsable = state.batteryUsable ?? null;
        any = true;
      }
      if (perms0.has(BOX.charging)) {
        out.charge = state.charge;
        any = true;
      }
      if (perms0.has(BOX.lid)) {
        out.lid = state.lid;
        any = true;
      }
      if (perms0.has(BOX.signal)) {
        out.csq = state.csq;
        any = true;
      }
      return any ? out : null;
    };
    const inspected = new Map(
      (
        await this.db.all(
          "SELECT box_id, inspected_at, inspected_by FROM sample_task_box WHERE task_id=?",
          [row.id]
        )
      ).map((r) => [r.box_id, r])
    );
    const boxes = [];
    for (const box of await boxDistances(this.db, task.boxIds || [], target, { withPosition })) {
      const state = box.missing ? null : (await this.boxes.findById(box.id))?.toJSON();
      boxes.push({
        ...box,
        opensDuring: counts.get(box.id) ?? null,
        owner: state?.owner || "",
        inspectedAt: inspected.get(box.id)?.inspected_at || "",
        inspectedBy: inspected.get(box.id)?.inspected_by || "",
        // 电量、箱盖要有状态权限，地址要有位置权限
        status: statusOf(state),
        address:
          state && withPosition
            ? (box.position?.source === "GPS" ? state.gpsAddress : state.lbsAddress) || ""
            : "",
        // 位置是什么时候的，页面显示「几分钟前」；用了基站时 gpsAt 是最后一次 GPS 定位时间
        gpsAt: state && withPosition ? state.gpsInfo?.at || "" : "",
        positionAt: withPosition ? box.position?.at || "" : "",
      });
    }
    // 轨迹和开关箱事件按任务窗口取；没有位置权限只给事件不给坐标
    const window = taskWindow(row.created_at, row.status, logs);
    await this.boxes.flush?.();
    const track = await taskTrack(this.db, task.boxIds || [], window, { places: taskPlaces(task) });
    const perms = ctx.access.perms;
    ctx.ok({
      task,
      target,
      boxes,
      tracks: withPosition ? track.tracks : [],
      // 开关箱、上电、充电各要各的记录权限
      events: filterEvents(track.events, perms),
      window,
      // 开箱录像：采样机构开箱时向视频平台请求的录像，按开箱时间排
      videos: perms.has(T.video) && this.videos ? await this.videos.list(row.id) : [],
      // 监控通道（1–8 路）：采样任务取采样单位的、调拨取接收单位的；还没接平台时状态是「未接入」
      cameras: perms.has(T.camera) ? await this.#cameras(task) : [],
      allow: {
        log: perms.has(T.log) || perms.has(BOX.log),
        raw: perms.has(BOX.raw),
        video: perms.has(T.video),
        camera: perms.has(T.camera),
        retry: perms.has(T.videoRetry),
        policy: perms.has(P.read),
      },
      arriveRadiusM: radiusOf(target),
      ...(await this.#receiveDetail(ctx, task, row)),
      logs: logs.map((log) => ({
        status: log.status,
        action: log.action,
        by: log.actor_name || "",
        note: log.note || "",
        time: log.created_at,
        detail: log.detail && withPosition ? JSON.parse(log.detail) : null,
      })),
    });
  }

  /** 详情里的 can；在等这个人收货时换成核验后的结果，并带上 check。 */
  async #receiveDetail(ctx, task, row) {
    const plain = this.#receiveCan(ctx, task, row.status, null);
    if (this.#receiveMode(task, plain) === "none")
      return { can: this.#abilities(ctx, task, row.status), check: null };
    const check = await receiveCheck(this.db, this.boxes, task, row.id, row.status, {
      perms: ctx.access.perms,
    });
    return { can: this.#receiveCan(ctx, task, row.status, check), check };
  }

  /**
   * 谁能推进哪一步。调拨单：寄出、取消归寄出单位；确认到达寄出、接收方都可以；签收、拒收只归接收单位。
   * 接收方只需能看任务（device:box:task），不需要上报策略权限。
   * 指定了签收人（系统用户）时只有他能正常签收；接收单位里其他有签收权限的人只能「强制签收」，要写原因。
   */
  #abilities(ctx, task, status) {
    const has = (perm) => ctx.access.perms.has(perm);
    const view = has(BOX.task);
    const transfer = task.kind === "调拨" && task.toOrgId;
    // 参与方：寄出单位、收货单位（调拨）、指定签收人、采样单位、寄回的寄出单位（带寄送的采样单）
    const sender = transfer ? inScope(ctx, task.fromOrgId) : true;
    const receiver = transfer ? inScope(ctx, task.toOrgId) : false;
    const signer = transfer && isSigner(ctx, task);
    const sampler = task.orgId ? inScope(ctx, task.orgId) : true;
    const home = task.kind === "采样" && task.trip ? inScope(ctx, task.fromOrgId) : true;
    const may = (perm, party) => Boolean(view && has(perm) && party);
    const next = nextOf(task, status);
    const signTo = signTargetOf(task);
    // 采样单、通用任务每一步要的权限和参与方
    const STEP = {
      运送中: [T.send, home],
      待采样: [T.arrive, sampler || home],
      采样中: [T.sampleStart, sampler || home],
      已封箱: [T.seal, sampler || home],
      已完成: [T.finish, sampler || home],
      在途: [T.sendBack, sampler || home],
      待核验: [T.arrive, home],
      执行中: [T.sampleStart, sampler],
    };
    const can = Object.fromEntries(
      next.map((to) => {
        if (to === "已取消") return [to, may(T.cancel, transfer ? sender : true)];
        if (transfer) {
          if (to === "运送中") return [to, may(T.send, sender)];
          if (to === "待签收") return [to, may(T.arrive, sender || receiver)];
          if (to === signTo) return [to, may(T.sign, task.signerId ? signer : receiver)];
          if (to === "已拒收") return [to, may(T.reject, signer || receiver)];
          if (to === "退回中") return [to, may(T.rejectReturn, signer || receiver)];
          if (to === "已退回") return [to, may(T.acceptReturn, sender)];
          if (to === "已检测") return [to, may(T.inspect, receiver)];
          return [to, false];
        }
        if (to === signTo) return [to, may(T.sign, home)];
        if (to === "已拒收") return [to, may(T.reject, home)];
        if (to === "已检测") return [to, may(T.inspect, home)];
        const step = STEP[to];
        return [to, step ? may(step[0], step[1]) : false];
      })
    );
    // 指定了签收人：接收单位里不是签收人的人只能强制签收
    if (transfer && task.signerId && next.includes(signTo))
      can[FORCE_SIGN] = !signer && may(T.forceSign, receiver);
    return can;
  }

  /**
   * 收货时能做什么：在 #abilities 的基础上，
   * - 调拨运送中：收货方扫码可以直接签收、拒收（推进时先自动记一笔「确认到达」）；
   * - 签收核验有问题（check.problems）：不能直接签收，只能拒收或强制签收（要写原因）。
   */
  #receiveCan(ctx, task, status, check) {
    const can = { ...this.#abilities(ctx, task, status) };
    const signTo = signTargetOf(task);
    if (task.kind === "调拨" && status === "运送中") {
      const at = this.#abilities(ctx, task, "待签收");
      for (const to of [signTo, "已拒收", "退回中", FORCE_SIGN]) if (at[to]) can[to] = true;
    }
    if (check?.problems?.length && can[signTo]) {
      can[signTo] = false;
      can[FORCE_SIGN] = ctx.access.perms.has(T.forceSign);
    }
    return can;
  }

  /** 收货方式：sign 签收核验（签收、强制签收、拒收）、return 寄出方接收退回，none 没有要做的。 */
  #receiveMode(task, can) {
    if (can["已退回"]) return "return";
    const signTo = signTargetOf(task);
    return [signTo, FORCE_SIGN, "已拒收", "退回中"].some((to) => can[to]) ? "sign" : "none";
  }

  /**
   * 签收核验页（GET /tasks/:id/receive?boxId=）：小程序扫箱码后弹出、网页签收对话框用。
   * 给每台箱子的状态、本次开箱次数、离收货点多远，问题列表，以及现在能做的签收动作。
   */
  async receive(ctx) {
    this.require(ctx, BOX.task);
    const row = await this.#visibleTask(ctx);
    const task = JSON.parse(row.body);
    const check = await receiveCheck(this.db, this.boxes, task, row.id, row.status, {
      perms: ctx.access.perms,
    });
    const can = this.#receiveCan(ctx, task, row.status, check);
    ctx.ok({
      task: {
        id: row.id,
        name: task.name,
        kind: task.kind,
        status: row.status,
        steps: stepsOf({ ...task, status: row.status }),
        from: task.fromOrg || "",
        to: task.kind === "调拨" ? task.toOrg || "" : task.org || "",
        sender: task.sender || "",
        signer: task.signer || "",
        inspect: Boolean(task.inspect),
        boxes: (task.boxIds || []).length,
      },
      mode: this.#receiveMode(task, can),
      signTo: signTargetOf(task),
      boxId: String(ctx.query.boxId || ""),
      check,
      can,
    });
  }

  /**
   * 工作台的任务待办：我现在能推进的任务按下一步分组，加上开箱超限和我经手的任务。
   * 只看进行中的、最多 500 张；每组给数量和前 5 张。
   */
  async todo(ctx) {
    if (!ctx.access.perms.has(BOX.task)) return null;
    const visible = this.#visible(ctx);
    const rows = await this.db.all(
      `SELECT t.* FROM sample_task t WHERE t.status NOT IN (${ENDED_SQL})${visible.sql ? ` AND ${visible.sql}` : ""} ORDER BY created_at DESC LIMIT 500`,
      visible.params
    );
    const groups = {
      send: [],
      arrive: [],
      sign: [],
      returning: [],
      sampling: [],
      inspect: [],
      overLimit: [],
      mine: [],
      moving: [],
    };
    const me = String(ctx.user?.id || ""),
      myName = ctx.user?.nickname || "";
    for (const row of rows) {
      const task = JSON.parse(row.body);
      const can = this.#abilities(ctx, task, row.status);
      const brief = {
        id: row.id,
        name: task.name,
        kind: task.kind,
        status: row.status,
        createdAt: row.created_at,
        from: task.fromOrg || "",
        to: task.kind === "调拨" ? task.toOrg || "" : task.org || "",
        boxes: (task.boxIds || []).length,
      };
      if (can["运送中"]) groups.send.push(brief);
      if (can["待签收"] || (row.status === "运送中" && can["待采样"])) groups.arrive.push(brief);
      if (can["已签收"] || can["待检测"] || can[FORCE_SIGN]) groups.sign.push(brief);
      if (can["已退回"]) groups.returning.push(brief);
      if (can["已检测"]) groups.inspect.push(brief);
      if (
        task.kind === "采样" &&
        ["待采样", "采样中", "已封箱"].includes(row.status) &&
        Object.entries(can).some(([to, ok]) => ok && to !== "已取消")
      )
        groups.sampling.push(brief);
      if (["运送中", "在途"].includes(row.status)) groups.moving.push(brief);
      if (
        Number.isInteger(task.maxOpens) &&
        overOpenLimit(task, await openCounts(this.db, row.id)).length
      )
        groups.overLimit.push(brief);
      if (
        (me && (task.senderId === me || task.signerId === me)) ||
        (myName && String(task.people || "").includes(myName))
      )
        groups.mine.push(brief);
    }
    return Object.fromEntries(
      Object.entries(groups).map(([key, list]) => [
        key,
        { total: list.length, list: list.slice(0, 5) },
      ])
    );
  }

  /**
   * 扫箱码（小程序扫箱子上的二维码进来）。箱子在自己范围内：给状态（按权限遮挡），能建任务时 canCreate=true；
   * 不在范围内（比如调拨单的接收方）：只给名称，但和自己相关的任务照样列出、能签收。
   */
  async scan(ctx) {
    const perms = ctx.access.perms;
    const key = String(ctx.params.id || "").slice(0, 64);
    const box = (await this.boxes.findById(key)) || (await this.boxes.findByName(key));
    if (!box)
      throw Object.assign(new Error("没有这台采样箱，请确认二维码"), {
        httpStatus: 404,
        publicCode: "A0404",
      });
    const visible = canSee(ctx.access, box) && (perms.has(BOX.detail) || perms.has(BOX.list));
    let tasks = [];
    if (perms.has(BOX.task)) {
      const scope = this.#visible(ctx);
      const rows = await this.db.all(
        `SELECT t.*, m.inspected_at AS box_inspected_at, m.opens_start AS box_opens_start, m.opens_end AS box_opens_end FROM sample_task t JOIN sample_task_box m ON m.task_id=t.id WHERE m.box_id=?${scope.sql ? ` AND ${scope.sql}` : ""} ORDER BY t.created_at DESC LIMIT 10`,
        [box.id, ...scope.params]
      );
      const opensNow = Number(box.toJSON().opens ?? 0);
      tasks = rows.map((row) => {
        const task = JSON.parse(row.body);
        // 检测站已开始检测的箱子：这张单对它来说已经结束
        const active = !ENDED.includes(row.status) && !row.box_inspected_at;
        const can = active ? this.#abilities(ctx, task, row.status) : {};
        // 待检测时扫到的这台箱子：能逐台开始检测；整张单的「全部开始检测」留在任务详情里
        if (active && row.status === "待检测") {
          can["开始检测"] = Boolean(can["已检测"]);
          delete can["已检测"];
        }
        // 这张单在等这个人收货：小程序扫码后直接弹出签收核验页
        const receive = active
          ? this.#receiveMode(task, this.#receiveCan(ctx, task, row.status, null))
          : "none";
        // 本次任务开了几次箱：签收前看当前，签收后定在签收那一刻
        const opensDuring =
          row.box_opens_start == null
            ? null
            : Math.max(0, Number(row.box_opens_end ?? opensNow) - Number(row.box_opens_start));
        return {
          id: row.id,
          name: task.name,
          kind: task.kind,
          status: row.status,
          createdAt: row.created_at,
          active,
          from: task.fromOrg || "",
          to: task.kind === "调拨" ? task.toOrg || "" : task.org || "",
          sender: task.sender || "",
          signer: task.signer || "",
          boxes: (task.boxIds || []).length,
          inspect: Boolean(task.inspect),
          inspectedAt: row.box_inspected_at || "",
          opensDuring,
          maxOpens: Number.isInteger(task.maxOpens) ? task.maxOpens : null,
          receive,
          can,
        };
      });
    }
    if (!visible && !tasks.length)
      throw Object.assign(new Error("这台采样箱不在你的管理范围内"), {
        httpStatus: 403,
        publicCode: "A0301",
      });
    const json = box.toJSON();
    ctx.ok({
      box: visible
        ? maskBox(json, perms)
        : {
            id: box.id,
            name: json.name,
            life: json.life,
            masked: ["status", "location", "identity"],
          },
      visible,
      tasks,
      canCreate:
        visible &&
        (perms.has(T.createTransfer) || perms.has(T.createSample)) &&
        box.life === "未使用" &&
        !tasks.some((task) => task.active),
    });
  }

  /** 最近的任务流转，工作台动态用。 */
  async recentLogs(ctx, limit = 20) {
    if (!ctx.access.perms.has(BOX.task)) return [];
    const visible = this.#visible(ctx);
    const rows = await this.db.all(
      `SELECT l.task_id, l.status, l.action, l.actor_name, l.note, l.created_at, t.name, t.kind FROM sample_task_log l JOIN sample_task t ON t.id = l.task_id
       ${visible.sql ? `WHERE ${visible.sql}` : ""} ORDER BY l.created_at DESC LIMIT ${Math.min(50, limit)}`,
      visible.params
    );
    return rows.map((row) => ({
      type: "task",
      taskId: row.task_id,
      taskName: row.name,
      kind: row.kind,
      status: row.status,
      action: row.action,
      by: row.actor_name || "",
      note: row.note || "",
      time: row.created_at,
    }));
  }

  /**
   * 任务轨迹：任务期间（创建到结束，没结束到现在）一台或全部箱子的位置和事件，不受 31 天限制。
   * 采样箱详情「轨迹」按任务看时用，只要能看这个任务和「当前位置」，不需要「历史轨迹」。
   * boxId 必须是这个任务里的箱子。
   */
  async taskTrack(ctx) {
    this.require(ctx, BOX.task);
    this.require(ctx, BOX.location);
    const row = await this.#visibleTask(ctx);
    const task = JSON.parse(row.body);
    const all = task.boxIds || [];
    const boxId = typeof ctx.query.boxId === "string" ? ctx.query.boxId : "";
    if (boxId && !all.includes(boxId))
      throw Object.assign(new Error("这台箱子不在这个任务里"), {
        httpStatus: 404,
        publicCode: "A0404",
      });
    const logs = await this.db.all(
      "SELECT status, created_at FROM sample_task_log WHERE task_id=? ORDER BY created_at, id",
      [row.id]
    );
    const window = taskWindow(row.created_at, row.status, logs);
    await this.boxes.flush?.();
    const places = taskPlaces(task);
    const track = await taskTrack(this.db, boxId ? [boxId] : all, window, { places });
    ctx.ok({
      task: {
        id: row.id,
        name: task.name || row.name || "",
        kind: row.kind,
        status: row.status,
        createdAt: row.created_at,
      },
      window,
      places,
      tracks: track.tracks,
      events: filterEvents(track.events, ctx.access.perms),
      truncated: track.truncated,
    });
  }

  /** 任务期间所有箱子的上报记录，按时间倒序翻页。范围固定在任务窗口内，不受 31 天限制。 */
  async taskLogs(ctx) {
    this.require(ctx, BOX.task);
    if (!ctx.access.perms.has(T.log) && !ctx.access.perms.has(BOX.log)) this.require(ctx, T.log);
    const row = await this.#visibleTask(ctx);
    const task = JSON.parse(row.body);
    const logs = await this.db.all(
      "SELECT * FROM sample_task_log WHERE task_id=? ORDER BY created_at, id",
      [row.id]
    );
    const window = taskWindow(row.created_at, row.status, logs);
    const all = task.boxIds || [];
    const boxId =
      typeof ctx.query.boxId === "string" && all.includes(ctx.query.boxId) ? ctx.query.boxId : "";
    if (typeof this.boxes.listLogsMany !== "function")
      return ctx.ok({ list: [], nextCursor: null, window });
    const page = await this.boxes.listLogsMany(boxId ? [boxId] : all, {
      from: window.from,
      to: window.to,
      limit: ctx.query.limit,
      kind: ctx.query.kind,
      cursorTime: ctx.query.cursorTime,
      cursorId: ctx.query.cursorId,
    });
    ctx.ok({
      list: page.list.map((item) => {
        const json = item.toListJSON ? item.toListJSON() : item.toJSON();
        delete json.raw;
        return maskUplink(json, ctx.access.perms);
      }),
      nextCursor: page.nextCursor,
      window,
    });
  }

  /** 开箱录像重试：平台失败或后来才接入时手动再发一次。 */
  async retryVideo(ctx) {
    this.require(ctx, T.videoRetry);
    const row = await this.#visibleTask(ctx);
    if (!this.videos) return ctx.fail("录像服务不可用");
    const result = await this.videos.retry(row.id, ctx.params.videoId);
    if (!result) return ctx.fail("录像记录不存在", "A0404", 404);
    await this.log(ctx, "重试开箱录像请求", row.id);
    ctx.ok(
      { videos: await this.videos.list(row.id) },
      result.status === "失败" ? result.detail : "已重新请求"
    );
  }

  async #cameras(task) {
    const orgId = task.kind === "调拨" ? task.toOrgId : task.orgId;
    if (!orgId) return [];
    const row = await this.db
      .get("SELECT cameras FROM sys_dept WHERE id=?", [String(orgId)])
      .catch(() => null);
    return readCameras(row?.cameras).map((camera, index) => ({
      index: index + 1,
      name: camera.name,
      channel: camera.channel || "",
      status: camera.liveUrl ? "在线" : "未接入",
      liveUrl: camera.liveUrl || "",
      playbackUrl: camera.playbackUrl || "",
    }));
  }

  async #visibleTask(ctx) {
    const visible = this.#visible(ctx);
    const row = await this.db.get(
      `SELECT t.* FROM sample_task t WHERE t.id=?${visible.sql ? ` AND ${visible.sql}` : ""}`,
      [ctx.params.id, ...visible.params]
    );
    if (!row)
      throw Object.assign(new Error("任务不存在或不在你的管理范围内"), {
        httpStatus: 404,
        publicCode: "A0404",
      });
    return row;
  }

  async transition(ctx) {
    this.require(ctx, BOX.task);
    const asked = ctx.body?.status;
    const force = asked === FORCE_SIGN;
    const note = typeof ctx.body?.note === "string" ? ctx.body.note.slice(0, 1000) : "";
    const row = await this.db.get("SELECT * FROM sample_task WHERE id=?", [ctx.params.id]);
    if (!row) throw new Error("任务不存在");
    const task = JSON.parse(row.body);
    const signTo = signTargetOf(task);
    const status = force ? signTo : asked;
    const ids = (
      await this.db.all("SELECT box_id FROM sample_task_box WHERE task_id=?", [ctx.params.id])
    ).map((b) => b.box_id);
    const transfer = task.kind === "调拨" && task.toOrgId;
    // 签收、强制签收、拒收：先做签收核验，有问题时不能直接签收
    const receiving = [signTo, FORCE_SIGN, "已拒收", "退回中"].includes(asked);
    const check = receiving
      ? await receiveCheck(this.db, this.boxes, task, row.id, row.status, {
          perms: ctx.access.perms,
        })
      : null;
    const can = receiving
      ? this.#receiveCan(ctx, task, row.status, check)
      : this.#abilities(ctx, task, row.status);
    if (!can[asked]) {
      const problems = check?.problems || [];
      const message =
        status === signTo && !force && problems.length && can[FORCE_SIGN]
          ? `有异常：${problems
              .slice(0, 3)
              .map((p) => `${p.name} ${p.text}`)
              .join("；")}。只能拒收或强制签收`
          : status === signTo && can[FORCE_SIGN]
            ? `只有签收人 ${task.signer} 可以签收，你可以强制签收`
            : transfer && [signTo, "已拒收", "已检测"].includes(status)
              ? "只有接收单位的人员可以签收、拒收或开始检测"
              : "没有这项操作权限";
      throw Object.assign(new Error(message), { httpStatus: 403, publicCode: "A0301" });
    }
    if (force && !note.trim()) throw new Error("请填写强制签收的原因");
    if (status === "退回中" && !note.trim()) throw new Error("请填写拒收原因");
    // 接收方看不到寄出方的箱子，签收、到达不再按箱子范围拦
    // 带寄送的采样单同理：采样单位、寄出单位按任务上的单位放行
    const party =
      task.kind === "采样" &&
      task.trip &&
      (inScope(ctx, task.orgId) || inScope(ctx, task.fromOrgId));
    if (
      !party &&
      !(
        transfer &&
        ["待签收", "已签收", "已拒收", "待检测", "已检测", "退回中", "已退回"].includes(status) &&
        (inScope(ctx, task.toOrgId) || inScope(ctx, task.fromOrgId) || isSigner(ctx, task))
      )
    )
      await this.targets(ctx, ids);
    // 寄出、寄回这两步记的是出发地的距离；拒收并退回记离收货地址多远，接收退回记离寄出地址多远
    const at =
      { 运送中: "待寄出", 在途: "已封箱", 退回中: "待签收", 已退回: "退回中" }[status] || status;
    const target = targetOf(task, at);
    const detail =
      target && hasCoords(target)
        ? distanceSnapshot(target, await boxDistances(this.db, ids, target))
        : null;
    // 运送中直接扫码签收、拒收：先自动记一笔确认到达
    if (transfer && row.status === "运送中" && [signTo, "已拒收", "退回中"].includes(status)) {
      await this.policies.transition(ctx.params.id, "待签收", {
        actor: actorOf(ctx),
        note: "扫码收货时自动确认到达",
      });
    }
    await this.policies.transition(ctx.params.id, status, {
      actor: actorOf(ctx),
      note,
      detail,
      action: force ? FORCE_SIGN : undefined,
    });
    if (transfer && status === signTo) await this.#handOver(task, ids);
    await this.log(ctx, force ? "任务单强制签收" : `任务单推进到「${status}」`, ctx.params.id);
    ctx.ok({ saved: true });
  }

  /**
   * 检测站扫一台箱子「开始检测」（POST /tasks/:id/boxes/:boxId/inspect）。
   * 谁能做和整张单「全部开始检测」一样：接收单位（双向单是寄出单位）里有签收权限的人。
   */
  async inspect(ctx) {
    this.require(ctx, BOX.task);
    const row = await this.db.get("SELECT * FROM sample_task WHERE id=?", [ctx.params.id]);
    if (!row)
      throw Object.assign(new Error("任务不存在"), { httpStatus: 404, publicCode: "A0404" });
    const task = JSON.parse(row.body);
    if (row.status !== "待检测")
      throw new Error(
        row.status === "已检测" ? "这张单的箱子都已开始检测" : "签收以后才能开始检测"
      );
    if (!this.#abilities(ctx, task, row.status)["已检测"])
      throw Object.assign(new Error("只有检测站有签收权限的人员可以开始检测"), {
        httpStatus: 403,
        publicCode: "A0301",
      });
    const boxId = String(ctx.params.boxId || "").slice(0, 64);
    const result = await this.policies.inspectBox(row.id, boxId, { actor: actorOf(ctx) });
    await this.log(ctx, `采样箱 ${boxId} 开始检测`, row.id);
    ctx.ok(result);
  }

  /** 签收后箱子归接收单位；签收人选的是系统用户时成为保管人，否则清空保管人。 */
  async #handOver(task, ids) {
    for (const id of ids) {
      await this.boxes.updateBox(id, (box) => {
        box.org = task.toOrg;
        box.orgId = String(task.toOrgId);
        box.owner = task.signerId ? task.signer : "—";
        box.ownerId = task.signerId ? String(task.signerId) : "";
      });
    }
  }
  async log(ctx, action, id) {
    await audit(this.db, {
      orgId: String(ctx.user.dept_id || ""),
      orgName: "",
      actorId: String(ctx.user.id),
      actorName: ctx.user.nickname || ctx.user.username,
      action,
      targetType: "report-policy",
      targetId: id,
      result: "成功",
      ip: ctx.ip || "",
    });
  }
}

/** 任务要记进出的地点：调拨看寄出、收货地址，采样看计划地点（双向再加寄出地址）。没坐标的跳过。 */
function taskPlaces(task) {
  return (
    task.kind === "调拨"
      ? [
          { ...task.fromPlace, role: "寄出地址" },
          { ...task.toPlace, role: "收货地址" },
        ]
      : [
          { ...task.placeAt, role: "计划地点" },
          ...(task.trip ? [{ ...task.fromPlace, role: "寄出地址" }] : []),
        ]
  )
    .filter((p) => hasCoords(p))
    .map((p) => ({ role: p.role, lng: p.lng, lat: p.lat, radiusM: radiusOf(p) }));
}
