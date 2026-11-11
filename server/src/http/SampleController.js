import {
  BOX,
  canSee,
  EVENT_KINDS,
  EVENT_PERMS,
  eventKindsFor,
  FLAGS,
  flagAllowed,
  flagMatch,
  maskBox,
  maskUplink,
  usableMv,
} from "../auth/boxAccess.js";
import { bucketBattery } from "../domain/BatterySeries.js";
import { foldBoxEvents } from "../domain/feed.js";
import { formatTimestamp } from "../domain/Clock.js";
import { audit } from "../log/audit.js";
import { resolveTimeRange } from "../log/timeRange.js";
import { currentBoxSettings, firmwareSupportsRemote } from "../settings/boxConfig.js";
import { readBoxName } from "../domain/boxName.js";
import { taskTrack } from "../settings/taskTrack.js";

const LIVES = ["在途", "未使用", "停用", "待激活"];
const EXPORT_MAX = 50000;
const EXPORT_LOG_MAX = 100000;
const BATTERY_MAX_MS = 31 * 24 * 3600 * 1000;

/**
 * 采样箱查询。箱子列表只读当前状态表。
 * 上报列表不取原文，点开一条再按主键解压。
 * ctx.access 是当前登录人的权限和数据范围；没有时（测试、内部调用）不做限制。
 */
export class SampleController {
  constructor(boxes, policies = null) {
    this.policies = policies;
    this.boxes = boxes;
  }

  async list(ctx) {
    if (!allowed(ctx, BOX.list)) return;
    const query = ctx.query || {};
    if (query.flag && !flagAllowed(query.flag, ctx.access?.perms))
      return ctx.fail("没有查看这项状态的权限", "A0301", 403);
    const paged =
      query.page != null ||
      query.q != null ||
      query.life != null ||
      query.flag != null ||
      query.orgId != null;
    if (!paged || typeof this.boxes.page !== "function") {
      const rows = (await this.boxes.list()).filter((box) => canSee(ctx.access, box));
      if (this.policies)
        await Promise.all(
          rows.map(async (box) => {
            box.reportPolicy = await this.policies.get(box);
          })
        );
      await this.#markWipe(rows);
      if (!paged) return ctx.ok(rows.map((box) => view(ctx, box)));
      return ctx.ok(pageInMemory(ctx, rows, readFilter(ctx), limits()));
    }
    const filter = readFilter(ctx);
    const result = await this.boxes.page({
      ...filter,
      scope: ctx.access?.scope || null,
      limits: limits(),
      matchImei: canMatchImei(ctx),
    });
    if (this.policies)
      await Promise.all(
        result.list.map(async (box) => {
          box.reportPolicy = await this.policies.get(box);
        })
      );
    await this.#markWipe(result.list);
    ctx.ok({
      list: result.list.map((box) => view(ctx, box)),
      total: result.total,
      page: filter.page,
      pageSize: filter.pageSize,
      counts: result.counts,
      flags: visibleFlags(result.flags, ctx.access?.perms),
    });
  }

  async stats(ctx) {
    if (!allowed(ctx, BOX.list)) return;
    if (typeof this.boxes.stats === "function") {
      const stats = await this.boxes.stats({ scope: ctx.access?.scope || null, limits: limits() });
      return ctx.ok({ ...stats, flags: visibleFlags(stats.flags, ctx.access?.perms) });
    }
    const rows = (await this.boxes.list()).filter((box) => canSee(ctx.access, box));
    const { counts, flags } = pageInMemory(ctx, rows, { page: 1, pageSize: 1 }, limits());
    ctx.ok({ total: rows.length, counts, flags: visibleFlags(flags, ctx.access?.perms) });
  }

  async detail(ctx) {
    const box = await this.#visible(ctx, BOX.detail);
    if (!box) return;
    if (this.policies) box.reportPolicy = await this.policies.get(box);
    await this.#markWipe([box]);
    ctx.ok(view(ctx, box));
  }

  /** 正在等设备抹除的箱子带上 wipe，页面显示「抹除中」。每次都写，避免共享对象残留旧状态。 */
  async #markWipe(rows) {
    const states = this.commands
      ? await this.commands.wipeStates(rows.map((box) => box.imei))
      : new Map();
    for (const box of rows) box.wipe = states.get(box.imei) ?? null;
  }

  /** 首页最近动态来自箱子当前状态，不扫上报流水。 */
  async recent(ctx) {
    if (!allowed(ctx, BOX.list)) return;
    const limit = Math.min(100, Math.max(1, Number(ctx.query.limit) || 50));
    const rows =
      typeof this.boxes.latest === "function"
        ? await this.boxes.latest({ scope: ctx.access?.scope || null, limit })
        : (await this.boxes.list())
            .filter((box) => box.last && canSee(ctx.access, box))
            .slice(0, limit);
    const feed = rows.map((box) =>
      maskUplink(
        {
          box: box.id,
          time: box.last,
          text: "最近上报",
          by: "设备",
          kind: "",
          lbsLng: box.lbsLng,
          lbsLat: box.lbsLat,
          gpsLng: box.gpsLng,
          gpsLat: box.gpsLat,
        },
        ctx.access?.perms
      )
    );
    ctx.ok(feed);
  }

  /**
   * 工作台：按权限给指标、箱子待办、任务待办、我保管的箱子和最近动态，一次取齐。
   * 页面 30 秒刷新一次，或收到实时推送时刷新，不再拉全部箱子。
   */
  async workbench(ctx) {
    const access = ctx.access;
    const has = (perm) => !access?.perms || access.perms.has(perm);
    const scope = access?.scope || null;
    const lim = limits();
    // cards：勾了哪几张卡片（逐张授权）。卡片还要有看里面内容的权限才给数据
    const card = (name) => has(`monitor:card:${name}`);
    const result = {
      cards: access?.perms ? [...access.perms].filter((p) => p.startsWith("monitor:card:")) : null,
      stats: null,
      boxTodo: {},
      taskTodo: null,
      myBoxes: null,
      feed: [],
    };
    const brief = (box) => {
      const json = view(ctx, box);
      return {
        id: json.id,
        name: json.name,
        org: json.org,
        owner: json.owner,
        life: json.life,
        last: json.last,
        alert: json.alert,
        batteryUsable: json.batteryUsable ?? null,
        lid: json.lid ?? null,
        address: json.gpsAddress || json.lbsAddress || "",
      };
    };
    const pick = async (filter) => {
      if (typeof this.boxes.page !== "function") return { total: 0, list: [] };
      const page = await this.boxes.page({ ...filter, page: 1, pageSize: 5, scope, limits: lim });
      return { total: page.total, list: page.list.map(brief) };
    };
    if (has(BOX.list)) {
      if (typeof this.boxes.stats === "function") {
        const stats = await this.boxes.stats({ scope, limits: lim });
        result.stats = { ...stats, flags: visibleFlags(stats.flags, access?.perms) };
      }
      if (card("pending") && has(BOX.activate))
        result.boxTodo.pending = await pick({ life: "待激活" });
      if (card("alert")) result.boxTodo.alert = await pick({ flag: "alert" });
      if (card("offline")) result.boxTodo.offline = await pick({ flag: "offline", life: "在途" });
      if (card("low") && has(BOX.power)) result.boxTodo.low = await pick({ flag: "low" });
      if (card("lid") && has(BOX.lid)) result.boxTodo.lid = await pick({ flag: "lid" });
      if (card("myBoxes") && ctx.user?.id && typeof this.boxes.page === "function") {
        const mine = await this.boxes.page({
          page: 1,
          pageSize: 10,
          scope: { all: false, orgIds: [], ownerIds: [String(ctx.user.id)] },
          limits: lim,
        });
        result.myBoxes = { total: mine.total, list: mine.list.map(brief) };
      }
    }
    if (this.policy) {
      const todo = await this.policy.todo(ctx);
      if (todo) {
        // 每组对应一张卡片，没勾的卡片不给数据；moving 是指标卡「运送中的任务」
        const CARD_OF = {
          send: "send",
          arrive: "arrive",
          sign: "sign",
          returning: "return",
          sampling: "sampling",
          inspect: "inspect",
          overLimit: "overLimit",
          mine: "myTasks",
        };
        for (const [group, name] of Object.entries(CARD_OF)) if (!card(name)) delete todo[group];
        result.taskTodo = todo;
      }
      if (card("feed")) result.feed.push(...(await this.policy.recentLogs(ctx, 15)));
    }
    // 开关箱、上电各要各的记录权限
    const kinds = eventKindsFor(access?.perms).filter((kind) =>
      ["pad", "shut", "boot"].includes(kind)
    );
    if (card("feed") && kinds.length && this.boxes.executor) {
      // 最近三天，按数据范围过滤；同一台箱子连续的同类事件合成一条（见 foldBoxEvents）
      const since = formatTimestamp(new Date(Date.now() - 3 * 86400000));
      const scoped = scope && !scope.all ? scopeSqlFor(scope) : null;
      const rows = await this.boxes.executor.all(
        `SELECT u.box_id, u.received_at, u.kind, b.name FROM sample_uplink u JOIN sample_box b ON b.id = u.box_id
         WHERE u.kind IN (${kinds.map(() => "?").join(",")}) AND u.received_at >= ?${scoped ? ` AND ${scoped.sql}` : ""}
         ORDER BY u.received_at DESC LIMIT 500`,
        [...kinds, since, ...(scoped ? scoped.params : [])]
      );
      result.feed.push(...foldBoxEvents(rows).slice(0, 20));
    }
    ctx.ok(result);
  }

  async battery(ctx) {
    const box = await this.#visible(ctx, BOX.battery);
    if (!box) return;
    const from = String(ctx.query?.from || "");
    const to = String(ctx.query?.to || "");
    if (
      !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(from) ||
      !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(to)
    ) {
      return ctx.fail("时间范围不正确");
    }
    if (Date.parse(to.replace(" ", "T")) - Date.parse(from.replace(" ", "T")) > BATTERY_MAX_MS) {
      return ctx.fail("电量曲线最多查 31 天");
    }
    if (typeof this.boxes.listBattery !== "function") return ctx.ok([]);
    const rows = await this.boxes.listBattery(box.id, from, to);
    const periodSec =
      box.reportPolicy?.effective?.reportPeriodSec ??
      box.policyPeriodSec ??
      currentBoxSettings().reportPeriodSec;
    ctx.ok(bucketBattery(rows, 360, { model: box.batteryModel, periodSec }));
  }

  async places(ctx) {
    const box = await this.#visible(ctx, BOX.location);
    if (!box) return;
    if (typeof this.boxes.listPlaces !== "function") return ctx.ok({ lbs: [], gps: [] });
    ctx.ok(await this.boxes.listPlaces(box.id));
  }

  /**
   * 一段时间内的位置点：GPS 连线、基站点单列，和任务详情同一套算法。最长 31 天。
   * 轨迹要「历史轨迹」，开关箱、上电、充电记录各要各的权限，一样都没有才拒绝（小程序箱子页只拿事件）。
   * allow 告诉页面这次给了哪些，没给事件时不要显示「开箱 0 次」。
   */
  async track(ctx) {
    const withTrack = allowedTo(ctx, BOX.track);
    const kinds = eventKindsFor(ctx.access?.perms);
    const withEvents = kinds.length > 0;
    const box = await this.#visible(
      ctx,
      withTrack || !withEvents ? BOX.track : EVENT_PERMS[kinds[0]]
    );
    if (!box) return;
    const range = resolveTimeRange(ctx.query || {});
    if (range.error) return ctx.fail(range.error);
    const allow = { track: withTrack, events: withEvents };
    const db = this.boxes.executor;
    if (!db)
      return ctx.ok({ tracks: [], events: [], window: { from: range.from, to: range.to }, allow });
    await this.boxes.flush?.();
    const result = await taskTrack(db, [box.id], {
      from: range.from,
      to: range.to,
      live: !ctx.query?.to,
    });
    ctx.ok({
      ...result,
      tracks: withTrack ? result.tracks : [],
      events: withEvents ? filterEvents(result.events, ctx.access?.perms) : [],
      allow,
    });
  }

  /** 改名称。名称不能和别的箱子重复。 */
  async rename(ctx) {
    const box = await this.#visible(ctx, BOX.rename);
    if (!box) return;
    const name = readBoxName(ctx.body?.name);
    if (!name) return ctx.fail("名称要 1–32 个字");
    if (await this.#nameTaken(name, box.id)) return ctx.fail("已有同名的采样箱");
    const next = await this.boxes.updateBox(box.id, (current) => {
      current.name = name;
    });
    await record(ctx, "采样箱改名", box.id);
    ctx.ok(view(ctx, next), "已保存");
  }

  async #nameTaken(name, exceptId) {
    const found =
      typeof this.boxes.findByName === "function" ? await this.boxes.findByName(name) : null;
    return Boolean(found && found.id !== exceptId);
  }

  /** 只查开关箱、上电、充电时，有对应的记录权限就够；要看全部报文得有「查看上报记录」。 */
  async logs(ctx) {
    const kinds = String(ctx.query?.kind || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    const perms = ctx.access?.perms;
    const onlyEvents =
      kinds.length > 0 &&
      kinds.every((kind) => EVENT_KINDS.includes(kind) && (!perms || perms.has(EVENT_PERMS[kind])));
    const perm = onlyEvents && perms && !perms.has(BOX.log) ? EVENT_PERMS[kinds[0]] : BOX.log;
    const box = await this.#visible(ctx, perm);
    if (!box) return;
    const range = resolveTimeRange(ctx.query || {});
    if (range.error) return ctx.fail(range.error);
    const page = await this.boxes.listLogs(box.id, {
      from: range.from,
      to: range.to,
      limit: ctx.query?.limit,
      cursorTime: ctx.query?.cursorTime,
      cursorId: ctx.query?.cursorId,
      kind: ctx.query?.kind,
    });
    const rows = Array.isArray(page) ? page : page.list;
    ctx.ok({
      list: rows.map((row) => maskUplink(withoutRaw(row), perms)),
      nextCursor: Array.isArray(page) ? null : page.nextCursor || null,
    });
  }

  async raw(ctx) {
    const box = await this.#visible(ctx, BOX.raw);
    if (!box) return;
    if (typeof this.boxes.readRaw !== "function") return ctx.fail("上报不存在", "A0404", 404);
    const text = await this.boxes.readRaw(box.id, ctx.params.logId, ctx.query?.receivedAt);
    if (text == null) return ctx.fail("上报不存在", "A0404", 404);
    ctx.ok({ raw: text });
  }

  /** 导出当前筛选结果。列按权限裁剪，最多五万台。 */
  async export(ctx) {
    if (!allowed(ctx, BOX.export)) return;
    if (typeof this.boxes.exportBoxes !== "function" || typeof ctx.download !== "function") {
      return ctx.fail("当前存储不支持导出");
    }
    const perms = ctx.access?.perms;
    const has = (perm) => !perms || perms.has(perm);
    const columns = [
      ["名称", (box) => box.name],
      ["IMEI", (box) => box.id],
      ["状态", (box) => box.life],
      ["所属单位", (box) => box.org],
      ["保管人", (box) => (box.owner === "—" ? "" : box.owner)],
      ["最后上报", (box) => box.last],
      ["异常", (box) => box.alert],
    ];
    if (has(BOX.power))
      columns.push(["可用电量%", (box) => box.batteryUsable ?? ""], ["电压", (box) => box.battery]);
    if (has(BOX.lid))
      columns.push(["箱盖", (box) => (box.lid == null ? "" : box.lid ? "开" : "关")]);
    if (has(BOX.signal)) columns.push(["信号CSQ", (box) => box.csq]);
    if (has(BOX.location)) {
      columns.push(
        ["位置", (box) => box.gpsAddress || box.lbsAddress || ""],
        ["经度", (box) => box.gpsLng ?? box.lbsLng ?? ""],
        ["纬度", (box) => box.gpsLat ?? box.lbsLat ?? ""]
      );
    }
    if (has(BOX.iccid)) columns.push(["ICCID", (box) => box.iccid]);
    if (has(BOX.imsi)) columns.push(["IMSI", (box) => box.imsi]);
    if (has(BOX.firmware)) columns.push(["固件", (box) => box.firmware]);
    const filter = readFilter(ctx);
    const rows = this.boxes.exportBoxes({
      ...filter,
      scope: ctx.access?.scope || null,
      limits: limits(),
      matchImei: canMatchImei(ctx),
      max: EXPORT_MAX,
    });
    async function* lines() {
      yield `\uFEFF${columns.map(([title]) => csvCell(title)).join(",")}\r\n`;
      for await (const box of rows) {
        const json = box.toJSON();
        yield `${columns.map(([, read]) => csvCell(read(json))).join(",")}\r\n`;
      }
    }
    await record(ctx, "导出采样箱", "");
    await ctx.download(`采样箱-${formatTimestamp(new Date()).slice(0, 10)}.csv`, lines());
  }

  /** 激活时可以顺便起名；不填保留建档时的默认名称（采样箱_00000001）。 */
  async activate(ctx) {
    const wanted = ctx.body?.name;
    const name = wanted == null || wanted === "" ? null : readBoxName(wanted);
    if (wanted != null && wanted !== "" && !name) return ctx.fail("名称要 1–32 个字");
    if (name && (await this.#nameTaken(name, ctx.params.id))) return ctx.fail("已有同名的采样箱");
    await this.#changeLife(ctx, BOX.activate, "激活采样箱", (box) => {
      if (box.life !== "待激活") return "只有待激活的箱子可以激活";
      // 名称没变不算改名；改了要另有「修改采样箱名称」
      if (name && name !== box.name && !allowedTo(ctx, BOX.rename))
        return "激活时改名要有「修改采样箱名称」权限";
      box.life = "未使用";
      box.activateStep = "已确认";
      if (name) box.name = name;
      return null;
    });
  }

  async remove(ctx) {
    const box = await this.#visible(ctx, BOX.delete);
    if (!box) return;
    const authorize = (current) => canSee(ctx.access, current);
    const wanted = ctx.body?.wipe ?? ctx.query?.wipe;
    const asked = ["quick", "full"].includes(wanted) ? wanted : "";
    if (asked && !allowedTo(ctx, BOX.wipe))
      return ctx.fail("没有「远程抹除设备」权限", "A0301", 403);
    const wipe = asked && this.commands && firmwareSupportsRemote(box.firmware) ? asked : "";
    const options = { wipe, by: ctx.user?.id };
    const result = this.removeBox
      ? await this.removeBox(box, authorize, options)
      : await this.boxes.deleteBox(box.id, authorize, options);
    if (result.error)
      return ctx.fail(result.error, result.status === 404 ? "A0404" : "A0409", result.status);
    await record(
      ctx,
      wipe ? `请求抹除设备（${wipe === "full" ? "完整" : "快速"}）` : "删除采样箱档案",
      box.id
    );
    const note = wipe
      ? "已登记抹除请求，档案先保留并显示「抹除中」；设备下次上报时抹除并重启，确认后档案才会删除并重新建档为待激活"
      : asked
        ? "档案已删除；该设备固件不支持远程抹除，本机数据仍保留，下次上报将重新建档为待激活"
        : "档案已删除，下次上报将重新建档为待激活";
    ctx.ok(
      {
        deleted: Boolean(result.deleted),
        wiping: Boolean(result.wiping),
        id: box.id,
        wipe: wipe || null,
      },
      note
    );
  }

  /** 导出单箱上报流水：服务器库里的数据，不占设备流量。最长 31 天。 */
  async exportLogs(ctx) {
    const box = await this.#visible(ctx, BOX.logExport);
    if (!box) return;
    if (typeof ctx.download !== "function") return ctx.fail("当前存储不支持导出");
    const range = resolveTimeRange(ctx.query || {});
    if (range.error) return ctx.fail(range.error);
    const perms = ctx.access?.perms;
    const boxes = this.boxes;
    const kind = ctx.query?.kind;
    async function* lines() {
      yield `\uFEFF${["时间", "设备时间", "类型", "摘要", "经度", "纬度"].join(",")}\r\n`;
      let cursor = {};
      for (let sent = 0; sent < EXPORT_LOG_MAX;) {
        const page = await boxes.listLogs(box.id, {
          from: range.from,
          to: range.to,
          limit: 100,
          kind,
          cursorTime: cursor.time,
          cursorId: cursor.id,
        });
        const rows = Array.isArray(page) ? page : page.list;
        for (const row of rows) {
          const item = maskUplink(withoutRaw(row), perms);
          yield `${[item.time, item.deviceTime, item.kind, item.text, item.gpsLng ?? item.lbsLng ?? "", item.gpsLat ?? item.lbsLat ?? ""].map(csvCell).join(",")}\r\n`;
          sent += 1;
        }
        if (Array.isArray(page) || !page.nextCursor) break;
        cursor = page.nextCursor;
      }
    }
    await record(ctx, "导出单箱上报日志", box.id);
    await ctx.download(
      `${box.name || box.id}-上报日志-${formatTimestamp(new Date()).slice(0, 10)}.csv`,
      lines()
    );
  }

  /** 板子本机日志：先查条数，再确认范围回传。需要设备在线、网络良好，并消耗设备流量。 */
  async dumpQuery(ctx) {
    const box = await this.#visible(ctx, BOX.dump);
    if (!box || !this.#dumpReady(ctx, box)) return;
    const row = await this.commands.createDump(box, ctx.user?.id);
    await record(ctx, "查询设备本机日志条数", box.id);
    ctx.ok(await this.commands.view(row), "指令已排队，设备下次上报时会收到");
  }

  async dumpConfirm(ctx) {
    const box = await this.#visible(ctx, BOX.dump);
    if (!box || !this.#dumpReady(ctx, box)) return;
    const row = await this.commands.confirmDump(box, ctx.params.req, {
      fromSec: ctx.body?.fromSec,
      max: ctx.body?.max,
    });
    if (!row) return ctx.fail("请求不存在或还没有查到条数", "A0409", 409);
    await record(ctx, "开始回传设备本机日志", box.id);
    ctx.ok(await this.commands.view(row), "已排队，设备下次上报时开始回传");
  }

  async dumpStatus(ctx) {
    const box = await this.#visible(ctx, BOX.dump);
    if (!box || !this.#dumpReady(ctx, box)) return;
    const row = ctx.params.req
      ? await this.commands.dumpById(box.id, ctx.params.req)
      : await this.commands.latestDump(box.id);
    ctx.ok(await this.commands.view(row));
  }

  async dumpCancel(ctx) {
    const box = await this.#visible(ctx, BOX.dump);
    if (!box || !this.#dumpReady(ctx, box)) return;
    ctx.ok(await this.commands.view(await this.commands.cancelDump(box, ctx.params.req)));
  }

  async dumpDownload(ctx) {
    const box = await this.#visible(ctx, BOX.dump);
    if (!box || !this.#dumpReady(ctx, box)) return;
    const row = await this.commands.dumpById(box.id, ctx.params.req);
    if (!row) return ctx.fail("请求不存在", "A0404", 404);
    const items = await this.commands.records(row.id);
    async function* lines() {
      yield `\uFEFF${["时间", "类型", "开箱次数"].join(",")}\r\n`;
      for (const item of items)
        yield `${[formatTimestamp(new Date(item.sec * 1000)), item.kind, item.opens].map(csvCell).join(",")}\r\n`;
    }
    await record(ctx, "导出设备本机日志", box.id);
    await ctx.download(
      `${box.id}-设备本机日志-${formatTimestamp(new Date()).slice(0, 10)}.csv`,
      lines()
    );
  }

  #dumpReady(ctx, box) {
    if (!this.commands) {
      ctx.fail("当前存储不支持读取设备日志");
      return false;
    }
    if (!firmwareSupportsRemote(box.firmware)) {
      ctx.fail("该设备固件不支持读取本机日志，需要 1.0.6 及以上", "A0409", 409);
      return false;
    }
    return true;
  }

  async disable(ctx) {
    await this.#changeLife(ctx, BOX.disable, "停用采样箱", (box) => {
      if (box.life !== "未使用") return "只有未使用的箱子可以停用";
      box.life = "停用";
      return null;
    });
  }

  async restore(ctx) {
    await this.#changeLife(ctx, BOX.enable, "恢复采样箱", (box) => {
      if (box.life !== "停用") return "只有停用的箱子可以恢复";
      box.life = "未使用";
      return null;
    });
  }

  /** 改所属单位和保管人。目标单位、目标人员都必须在操作人自己的数据范围里。 */
  async assign(ctx) {
    const body0 = ctx.body || {};
    // 所属单位、保管人各自授权：改哪样查哪样
    if (body0.orgId != null && !allowed(ctx, BOX.assignOrg)) return;
    if (body0.ownerId != null && !allowed(ctx, BOX.assignOwner)) return;
    const box = await this.#visible(ctx, body0.orgId != null ? BOX.assignOrg : BOX.assignOwner);
    if (!box) return;
    if (!ctx.db) return ctx.fail("当前存储不支持分配");
    const body = ctx.body || {};
    const scope = ctx.access?.scope;
    let org = null;
    if (body.orgId != null) {
      const row = await ctx.db.get("SELECT id, name FROM sys_dept WHERE id = ?", [
        String(body.orgId),
      ]);
      if (!row) return ctx.fail("单位不存在");
      if (scope && !scope.all && !scope.orgIds.includes(String(row.id))) {
        return ctx.fail("只能分配到自己范围内的单位");
      }
      org = { id: String(row.id), name: row.name };
    }
    let owner = null;
    if (body.ownerId != null) {
      if (body.ownerId === "") {
        owner = { id: "", name: "—" };
      } else {
        const row = await ctx.db.get(
          "SELECT id, nickname, dept_id, status FROM sys_user WHERE id = ?",
          [String(body.ownerId)]
        );
        if (!row || Number(row.status) !== 1) return ctx.fail("保管人不存在或已停用");
        const inScope =
          !scope ||
          scope.all ||
          scope.orgIds.includes(String(row.dept_id)) ||
          scope.ownerIds.includes(String(row.id));
        if (!inScope) return ctx.fail("只能交给自己范围内的人员");
        owner = { id: String(row.id), name: row.nickname };
      }
    }
    if (!org && !owner) return ctx.fail("请选择单位或保管人");
    const next = await this.boxes.updateBox(box.id, (current) => {
      if (org) {
        current.org = org.name;
        current.orgId = org.id;
      }
      if (owner) {
        current.owner = owner.name;
        current.ownerId = owner.id;
      }
    });
    await record(ctx, "分配采样箱", box.id);
    ctx.ok(view(ctx, next), "已保存");
  }

  /** 分配弹窗的候选单位和人员。人员按单位取，十万台规模下人员也不一次拉全。 */
  async assignOptions(ctx) {
    if (!allowedTo(ctx, BOX.assignOrg) && !allowed(ctx, BOX.assignOwner)) return;
    if (!ctx.db) return ctx.ok({ orgs: [], users: [] });
    const scope = ctx.access?.scope;
    const depts = await ctx.db.all(
      "SELECT id, parent_id, name, sort FROM sys_dept WHERE status = 1"
    );
    const byId = new Map(depts.map((row) => [String(row.id), row]));
    const pathOf = (id) => {
      const names = [];
      let cursor = byId.get(String(id));
      while (cursor) {
        names.unshift(cursor.name);
        cursor = byId.get(String(cursor.parent_id));
      }
      return names.join(" / ");
    };
    const visible = (id) => !scope || scope.all || scope.orgIds.includes(String(id));
    const orgs = depts
      .filter((row) => visible(row.id))
      .map((row) => ({ id: String(row.id), name: row.name, path: pathOf(row.id) }))
      .sort((left, right) => left.path.localeCompare(right.path, "zh-CN"));
    const orgId = String(ctx.query?.orgId || "");
    const keyword = String(ctx.query?.q || "").trim();
    let users = [];
    if (orgId && visible(orgId)) {
      const ids = [
        orgId,
        ...depts
          .filter((row) => visible(row.id) && pathOf(row.id).startsWith(`${pathOf(orgId)} / `))
          .map((row) => String(row.id)),
      ];
      const rows = await ctx.db.all(
        `SELECT id, nickname, username, dept_id FROM sys_user
         WHERE status = 1 AND dept_id IN (${ids.map(() => "?").join(", ")})
         ORDER BY nickname LIMIT 200`,
        ids
      );
      users = rows
        .filter(
          (row) => !keyword || row.nickname.includes(keyword) || row.username.includes(keyword)
        )
        .map((row) => ({ id: String(row.id), name: row.nickname, dept: pathOf(row.dept_id) }));
    }
    ctx.ok({ orgs, users });
  }

  async #changeLife(ctx, perm, action, change) {
    const box = await this.#visible(ctx, perm);
    if (!box) return;
    let reason = null;
    const next = await this.boxes.updateBox(box.id, (current) => {
      reason = change(current);
      return reason ? false : undefined;
    });
    if (reason) {
      await record(ctx, action, box.id, "失败");
      return ctx.fail(reason);
    }
    await record(ctx, action, box.id);
    ctx.ok(view(ctx, next), "已保存");
  }

  /** 按编号（IMEI）找；找不到再按名称找，兼容 BOX-004 这类旧链接。 */
  async #visible(ctx, perm) {
    if (!allowed(ctx, perm)) return null;
    let box = await this.boxes.findById(ctx.params.id);
    if (!box && typeof this.boxes.findByName === "function")
      box = await this.boxes.findByName(String(ctx.params.id || ""));
    if (!box || !canSee(ctx.access, box)) {
      ctx.fail("采样箱不存在", "A0404", 404);
      return null;
    }
    return box;
  }
}

function allowed(ctx, perm) {
  const perms = ctx.access?.perms;
  if (!perms || perms.has(perm)) return true;
  ctx.fail("没有这项权限", "A0301", 403);
  return false;
}

/** 工作台事件查询的范围条件，列名带上 b. 前缀。 */
function scopeSqlFor(scope) {
  const parts = [],
    params = [];
  if (scope.orgIds.length) {
    parts.push(`b.org_id IN (${scope.orgIds.map(() => "?").join(", ")})`);
    params.push(...scope.orgIds);
  }
  if (scope.ownerIds.length) {
    parts.push(`b.owner_id IN (${scope.ownerIds.map(() => "?").join(", ")})`);
    params.push(...scope.ownerIds);
  }
  return parts.length ? { sql: `(${parts.join(" OR ")})`, params } : { sql: "1 = 0", params: [] };
}

function allowedTo(ctx, perm) {
  const perms = ctx.access?.perms;
  return !perms || perms.has(perm);
}

function view(ctx, box) {
  return maskBox(box.toJSON(), ctx.access?.perms);
}

/** IMEI 就是箱子编号，谁都能按 IMEI 搜。 */
function canMatchImei() {
  return true;
}

/** 低电量、开着盖、可调配的计数要对应的字段权限，没有就不给这几个数。 */
function visibleFlags(flags, perms) {
  if (!flags || !perms) return flags;
  return Object.fromEntries(Object.entries(flags).filter(([name]) => flagAllowed(name, perms)));
}

/** 轨迹里的事件按类别过滤：开关箱、上电、充电各要各的记录权限；失联、到达这类推出来的事件有任一记录权限就给。 */
export function filterEvents(events, perms) {
  if (!perms) return events;
  return (events || []).filter((event) =>
    EVENT_PERMS[event.kind] ? perms.has(EVENT_PERMS[event.kind]) : eventKindsFor(perms).length > 0
  );
}

function readFilter(ctx) {
  const query = ctx.query || {};
  return {
    life: LIVES.includes(query.life) ? query.life : "",
    flag: FLAGS.includes(query.flag) ? query.flag : "",
    page: Math.max(1, Number(query.page) || 1),
    pageSize: Math.min(100, Math.max(1, Number(query.pageSize) || 20)),
    q: String(query.q || "")
      .trim()
      .slice(0, 32),
    orgId: typeof query.orgId === "string" ? query.orgId.slice(0, 32) : "",
  };
}

/** 在线按三个上报周期算，和详情页一致；电量阈值换成电压，库里能直接比较。 */
export function limits() {
  const settings = currentBoxSettings();
  const period = Number(settings.reportPeriodSec) || 60;
  const reserve = Number(settings.batteryReserve) || 0;
  return {
    // 取整到 5 秒，统计缓存的 key 才能在几秒内复用
    onlineSince: formatTimestamp(new Date(Math.floor(Date.now() / 5000) * 5000 - period * 3000)),
    lowMv: usableMv(20, reserve),
    readyMv: usableMv(50, reserve),
  };
}

function pageInMemory(ctx, rows, filter, lim) {
  const counts = { 在途: 0, 未使用: 0, 停用: 0, 待激活: 0 };
  const flags = { alert: 0, offline: 0, low: 0, lid: 0, ready: 0 };
  const text = filter.q?.toLowerCase() || "";
  const imei = canMatchImei(ctx);
  const matched = rows.filter(
    (box) =>
      !text ||
      box.id.toLowerCase().includes(text) ||
      String(box.name || "")
        .toLowerCase()
        .includes(text)
  );
  void imei;
  for (const box of matched) {
    if (Object.prototype.hasOwnProperty.call(counts, box.life)) counts[box.life] += 1;
    for (const name of FLAGS) if (flagMatch(box, name, lim)) flags[name] += 1;
  }
  const picked = matched.filter(
    (box) =>
      (!filter.life || box.life === filter.life) &&
      (!filter.flag || flagMatch(box, filter.flag, lim)) &&
      (!filter.orgId || String(box.orgId || "") === filter.orgId)
  );
  const start = (filter.page - 1) * filter.pageSize;
  return {
    list: picked.slice(start, start + filter.pageSize).map((box) => view(ctx, box)),
    total: picked.length,
    page: filter.page,
    pageSize: filter.pageSize,
    counts,
    flags,
  };
}

function csvCell(value) {
  const text = value == null ? "" : String(value);
  const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

async function record(ctx, action, targetId, result = "成功") {
  if (!ctx.db || !ctx.user) return;
  try {
    await audit(ctx.db, {
      orgId: String(ctx.user.dept_id || ""),
      orgName: "",
      actorId: String(ctx.user.id),
      actorName: ctx.user.nickname || ctx.user.username,
      action,
      targetType: "box",
      targetId,
      result,
      ip: ctx.ip || "",
    });
  } catch (error) {
    console.error("操作日志写入失败", error instanceof Error ? error.message : "未知错误");
  }
}

function withoutRaw(row) {
  const json = typeof row.toListJSON === "function" ? row.toListJSON() : row.toJSON();
  if (!json || typeof json !== "object") return json;
  const copy = { ...json };
  delete copy.raw;
  return copy;
}
