import { createServer } from "node:http";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { consumeCaptcha, issueCaptcha, readToken, signToken, verifyPassword } from "./auth.js";
import { migrate, openDatabase, seedOrg, testConnection } from "./db.js";
import { menuOptions, menuRoutes } from "./menus.js";
import * as org from "./org-api.js";
import { startSampleRuntime } from "./src/createSampleApp.js";
import { audit } from "./src/log/audit.js";
import { queryVisitOverview, queryVisitTrend } from "./src/log/operationAnalytics.js";
import { queryOperationLogs } from "./src/log/operationLog.js";
import { readDeployedCommit, readServingCertExpiry } from "./src/runtimeInfo.js";
import { mergeDatabaseSettings, publicDatabase, scrub } from "./src/settings/databaseConfig.js";
import { tcpPassthroughSettings } from "./src/tcpSettings.js";

const serverRoot = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(serverRoot, "..");
const lockPath = resolve(serverRoot, "install.lock");
const configPath = resolve(serverRoot, "db.config.json");
const port = Number(process.env.PORT) || 8000;

const perms = [
  "sys:user:list",
  "sys:user:create",
  "sys:user:update",
  "sys:user:delete",
  "sys:user:import",
  "sys:user:export",
  "sys:user:reset-password",
  "sys:role:list",
  "sys:role:create",
  "sys:role:update",
  "sys:role:delete",
  "sys:role:assign",
  "sys:dept:list",
  "sys:dept:create",
  "sys:dept:update",
  "sys:dept:delete",
  "sys:menu:list",
  "sys:menu:create",
  "sys:menu:update",
  "sys:menu:delete",
];

const boxPermsByRole = {
  ADMIN: [
    "device:box:detail",
    "device:box:event",
    "device:box:log",
    "device:box:task",
    "device:box:activate",
    "device:box:disable",
  ],
  ASSET: [
    "device:box:detail",
    "device:box:event",
    "device:box:log",
    "device:box:task",
    "device:box:activate",
    "device:box:disable",
  ],
  VERIFY: ["device:box:detail", "device:box:event", "device:box:task"],
  DUTY: ["device:box:detail", "device:box:event", "device:box:task"],
  LEADER: ["device:box:detail", "device:box:event", "device:box:task"],
  DISPATCH: ["device:box:detail", "device:box:event", "device:box:task"],
};

const state = { installed: false, db: null, config: null };
let sampleApi = null;
let sampleRuntime = null;

function send(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
  });
  res.end(JSON.stringify(payload));
}

function ok(res, data, msg = "一切ok") {
  send(res, 200, { code: "00000", data, msg });
}

function fail(res, msg, code = "A0001", status = 200) {
  send(res, status, { code, data: null, msg });
}

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text) return resolveBody({});
      try {
        resolveBody(JSON.parse(text));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function normalizeConfig(body) {
  const dialect = body.dialect === "mysql" ? "mysql" : "sqlite";
  return {
    dialect,
    sqlitePath: body.sqlitePath || "server/data/sample-box.db",
    host: body.host || "127.0.0.1",
    port: Number(body.port) || 3306,
    user: body.user || "",
    password: body.password || "",
    database: body.database || "",
    secret: body.secret || randomBytes(24).toString("hex"),
  };
}

async function loadInstalled() {
  if (!existsSync(lockPath) || !existsSync(configPath)) return;
  state.config = JSON.parse(readFileSync(configPath, "utf8"));
  state.db = await openDatabase(state.config, projectRoot);
  await migrate(state.db);
  state.installed = true;
}

async function currentUser(req) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const payload = readToken(token, state.config?.secret || "");
  if (!payload?.userId) return null;
  return state.db.get("SELECT * FROM sys_user WHERE id = ?", [String(payload.userId)]);
}

async function roleCodes(userId) {
  const rows = await state.db.all(
    `SELECT r.code FROM sys_role r
     INNER JOIN sys_user_role ur ON ur.role_id = r.id
     WHERE ur.user_id = ?`,
    [String(userId)]
  );
  return rows.map((row) => row.code);
}

const routes = [
  {
    method: "GET",
    path: "/api/v1/setup/status",
    auth: false,
    handler: async (ctx) =>
      ctx.ok({ installed: state.installed, dialect: state.config?.dialect || null }),
  },
  { method: "POST", path: "/api/v1/setup/test", auth: false, handler: testSetup },
  { method: "POST", path: "/api/v1/setup/install", auth: false, handler: installSetup },
  {
    method: "GET",
    path: "/api/v1/auth/captcha",
    auth: false,
    handler: async (ctx) => ctx.ok(issueCaptcha()),
  },
  { method: "POST", path: "/api/v1/auth/login", auth: false, handler: login },
  { method: "POST", path: "/api/v1/auth/refresh-token", auth: false, handler: refresh },
  { method: "DELETE", path: "/api/v1/auth/logout", auth: true, handler: async (ctx) => ctx.ok({}) },
  { method: "GET", path: "/api/v1/users/me", auth: true, handler: me },
  { method: "GET", path: "/api/v1/users/profile", auth: true, handler: profile },
  {
    method: "GET",
    path: "/api/v1/menus/routes",
    auth: true,
    handler: async (ctx) => ctx.ok(menuRoutes),
  },
  {
    method: "GET",
    path: "/api/v1/menus/options",
    auth: true,
    handler: async (ctx) => ctx.ok(menuOptions),
  },
  { method: "GET", path: "/api/v1/depts/options", auth: true, handler: org.deptOptions },
  { method: "GET", path: "/api/v1/depts", auth: true, handler: org.listDepts },
  { method: "POST", path: "/api/v1/depts", auth: true, handler: org.createDept },
  { method: "GET", path: "/api/v1/depts/:id/form", auth: true, handler: org.deptForm },
  { method: "PUT", path: "/api/v1/depts/:id", auth: true, handler: org.updateDept },
  { method: "DELETE", path: "/api/v1/depts/:id", auth: true, handler: org.deleteDepts },
  { method: "GET", path: "/api/v1/roles/options", auth: true, handler: org.roleOptions },
  { method: "GET", path: "/api/v1/roles", auth: true, handler: org.listRoles },
  { method: "POST", path: "/api/v1/roles", auth: true, handler: org.createRole },
  { method: "GET", path: "/api/v1/roles/:id/form", auth: true, handler: org.roleForm },
  { method: "GET", path: "/api/v1/roles/:id/menu-ids", auth: true, handler: org.roleMenuIds },
  {
    method: "PUT",
    path: "/api/v1/roles/:id/menus",
    auth: true,
    handler: async (ctx) => ctx.ok(null),
  },
  {
    method: "GET",
    path: "/api/v1/roles/:id/dept-ids",
    auth: true,
    handler: async (ctx) => ctx.ok([]),
  },
  { method: "PUT", path: "/api/v1/roles/:id", auth: true, handler: org.updateRole },
  { method: "DELETE", path: "/api/v1/roles/:id", auth: true, handler: org.deleteRoles },
  { method: "GET", path: "/api/v1/users", auth: true, handler: org.listUsers },
  { method: "POST", path: "/api/v1/users", auth: true, handler: org.createUser },
  { method: "GET", path: "/api/v1/users/:id/form", auth: true, handler: org.userForm },
  {
    method: "PUT",
    path: "/api/v1/users/:id/password/reset",
    auth: true,
    handler: org.resetPassword,
  },
  { method: "PUT", path: "/api/v1/users/:id", auth: true, handler: org.updateUser },
  { method: "DELETE", path: "/api/v1/users/:id", auth: true, handler: org.deleteUsers },
  {
    method: "GET",
    path: "/api/v1/sample/boxes/:id/logs/:logId",
    auth: true,
    handler: (ctx) => useSample(ctx, (api) => api.raw(ctx)),
  },
  {
    method: "GET",
    path: "/api/v1/sample/boxes/:id/logs",
    auth: true,
    handler: (ctx) => useSample(ctx, (api) => api.logs(ctx)),
  },
  {
    method: "GET",
    path: "/api/v1/sample/boxes/:id",
    auth: true,
    handler: (ctx) => useSample(ctx, (api) => api.detail(ctx)),
  },
  {
    method: "GET",
    path: "/api/v1/sample/boxes",
    auth: true,
    handler: (ctx) => useSample(ctx, (api) => api.list(ctx)),
  },
  {
    method: "GET",
    path: "/api/v1/sample/reports",
    auth: true,
    handler: (ctx) => useSample(ctx, (api) => api.recent(ctx)),
  },
  {
    method: "GET",
    path: "/api/v1/notices/my",
    auth: true,
    handler: (ctx) => ctx.ok({ list: [], total: 0 }),
  },
  {
    method: "GET",
    path: "/api/v1/system/settings",
    auth: true,
    handler: systemSettings,
  },
  {
    method: "PUT",
    path: "/api/v1/system/settings/database",
    auth: true,
    handler: saveDatabase,
  },
  {
    method: "GET",
    path: "/api/v1/system/operation-logs",
    auth: true,
    handler: operationLogs,
  },
  {
    method: "GET",
    path: "/api/v1/logs/analytics/overview",
    auth: true,
    handler: visitOverview,
  },
  {
    method: "GET",
    path: "/api/v1/logs/analytics/trend",
    auth: true,
    handler: visitTrend,
  },
  { method: "GET", path: "/api/v1/sample/tasks", auth: true, reserved: true },
  { method: "GET", path: "/api/v1/sample/alerts", auth: true, reserved: true },
  { method: "GET", path: "/api/v1/sample/commands", auth: true, reserved: true },
];

async function testSetup(ctx) {
  const config = normalizeConfig(ctx.body || {});
  if (config.dialect === "mysql" && !config.database) return ctx.fail("请填写数据库名");
  try {
    await testConnection(config, projectRoot);
  } catch (error) {
    return ctx.fail(`连接失败：${error.message}`);
  }
  ctx.ok({ ok: true }, "连接成功");
}

async function installSetup(ctx) {
  if (state.installed) return ctx.fail("已经安装，不能重复建表");
  const config = normalizeConfig(ctx.body || {});
  if (config.dialect === "mysql" && !config.database) return ctx.fail("请填写数据库名");
  let db;
  try {
    db = await openDatabase(config, projectRoot);
    await migrate(db);
    await seedOrg(db);
  } catch (error) {
    if (db) await db.close();
    return ctx.fail(`安装失败：${error.message}`);
  }
  writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
  writeFileSync(lockPath, new Date().toISOString(), "utf8");
  state.config = config;
  state.db = db;
  state.installed = true;
  ctx.ok({ installed: true }, "安装完成，管理员账号 admin，密码 123456");
}

async function login(ctx) {
  if (!state.installed) return ctx.fail("请先完成数据库安装");
  const body = ctx.body || {};
  if (!consumeCaptcha(body.captchaId, body.captchaCode)) {
    await writeLogin(ctx, body.username, null, "失败");
    return ctx.fail("验证码错误");
  }
  const user = await state.db.get("SELECT * FROM sys_user WHERE username = ?", [body.username]);
  if (
    !user ||
    Number(user.status) !== 1 ||
    !verifyPassword(body.password || "", user.password_hash)
  ) {
    await writeLogin(ctx, body.username, user, "失败");
    return ctx.fail("用户名或密码错误");
  }
  const accessToken = signToken(
    { userId: user.id, username: user.username },
    state.config.secret,
    7200
  );
  const refreshToken = signToken(
    { userId: user.id, username: user.username, typ: "refresh" },
    state.config.secret,
    7 * 24 * 3600
  );
  await writeLogin(ctx, body.username, user, "成功");
  ctx.ok({ accessToken, refreshToken, tokenType: "Bearer", expiresIn: 7200 });
}

async function writeLogin(ctx, username, user, result) {
  try {
    let orgName = "";
    if (user?.dept_id) {
      const dept = await state.db.get("SELECT name FROM sys_dept WHERE id = ?", [
        String(user.dept_id),
      ]);
      orgName = dept?.name || "";
    }
    await audit(state.db, {
      orgId: String(user?.dept_id || ""),
      orgName,
      actorId: String(user?.id || ""),
      actorName: user?.nickname || String(username || ""),
      action: "登录",
      targetType: "user",
      targetId: String(user?.id || ""),
      result,
      ip: ctx.ip || "",
    });
  } catch (error) {
    console.error("操作日志写入失败", error instanceof Error ? error.message : "未知错误");
  }
}

async function refresh(ctx) {
  if (!state.installed) return ctx.fail("请先完成数据库安装");
  const payload = readToken(ctx.query.refreshToken, state.config.secret);
  if (!payload || payload.typ !== "refresh") return ctx.fail("刷新令牌无效", "A0231");
  const accessToken = signToken(
    { userId: payload.userId, username: payload.username },
    state.config.secret,
    7200
  );
  const refreshToken = signToken(
    { userId: payload.userId, username: payload.username, typ: "refresh" },
    state.config.secret,
    7 * 24 * 3600
  );
  ctx.ok({ accessToken, refreshToken, tokenType: "Bearer", expiresIn: 7200 });
}

async function me(ctx) {
  const roles = await roleCodes(ctx.user.id);
  const boxPerms = [...new Set(roles.flatMap((code) => boxPermsByRole[code] || []))];
  const switchPerm = roles.includes("HOME_SWITCH") ? ["monitor:home:switch"] : [];
  ctx.ok({
    userId: ctx.user.id,
    username: ctx.user.username,
    nickname: ctx.user.nickname,
    avatar: ctx.user.avatar || "",
    roles,
    perms: [...perms, ...boxPerms, ...switchPerm],
  });
}

async function profile(ctx) {
  const dept = await state.db.get("SELECT name FROM sys_dept WHERE id = ?", [ctx.user.dept_id]);
  const roles = await state.db.all(
    `SELECT r.name FROM sys_role r
     INNER JOIN sys_user_role ur ON ur.role_id = r.id
     WHERE ur.user_id = ?`,
    [ctx.user.id]
  );
  ctx.ok({
    id: ctx.user.id,
    username: ctx.user.username,
    nickname: ctx.user.nickname,
    avatar: ctx.user.avatar || "",
    gender: ctx.user.gender,
    mobile: ctx.user.mobile || "",
    email: ctx.user.email,
    deptName: dept?.name || "",
    roleNames: roles.map((item) => item.name).join(","),
    createTime: ctx.user.create_time,
  });
}

function useSample(ctx, run) {
  if (!sampleApi) return ctx.fail("请先完成数据库安装");
  return run(sampleApi);
}

async function systemSettings(ctx) {
  const certExpiresAt = await readServingCertExpiry();
  ctx.ok({
    ...tcpPassthroughSettings(sampleRuntime?.tcpAddress?.port, process.env, {
      version: readDeployedCommit(projectRoot),
      certExpiresAt,
    }),
    database: publicDatabase(state.config),
  });
}

async function saveDatabase(ctx) {
  const roles = await roleCodes(ctx.user.id);
  if (!roles.includes("ADMIN")) {
    await audit(state.db, {
      orgId: String(ctx.user.dept_id || ""),
      orgName: "",
      actorId: String(ctx.user.id),
      actorName: ctx.user.nickname || ctx.user.username,
      action: "修改数据库",
      targetType: "database",
      targetId: "",
      result: "失败",
      ip: ctx.ip || "",
    });
    return ctx.fail("只有系统管理员可以修改数据库");
  }
  let next;
  try {
    next = mergeDatabaseSettings(state.config, ctx.body || {});
  } catch (error) {
    return ctx.fail(error instanceof Error ? error.message : "数据库配置不正确");
  }
  const secret = next.password || "";
  if (next.dialect === "mysql") {
    try {
      await testConnection(next, projectRoot);
    } catch (error) {
      const message = scrub(error instanceof Error ? error.message : "连接失败", secret);
      console.error("数据库连接失败", message);
      return ctx.fail(`连接失败：${message}`);
    }
  }
  try {
    await switchDatabase(next);
  } catch (error) {
    const message = scrub(error instanceof Error ? error.message : "保存失败", secret);
    console.error("数据库配置未生效", message);
    return ctx.fail(`保存失败：${message}`);
  }
  await audit(state.db, {
    orgId: String(ctx.user.dept_id || ""),
    orgName: "",
    actorId: String(ctx.user.id),
    actorName: ctx.user.nickname || ctx.user.username,
    action: "修改数据库",
    targetType: "database",
    targetId: next.dialect,
    result: "成功",
    ip: ctx.ip || "",
  });
  ctx.ok(publicDatabase(state.config), "已保存");
}

async function switchDatabase(nextConfig) {
  const db = await openDatabase(nextConfig, projectRoot);
  try {
    await migrate(db);
    await seedOrg(db);
  } catch (error) {
    await db.close();
    throw error;
  }
  const previousDb = state.db;
  const previousRuntime = sampleRuntime;
  state.db = db;
  state.config = nextConfig;
  if (previousRuntime) {
    try {
      await previousRuntime.close();
    } catch (error) {
      console.error("关闭原接入失败", error instanceof Error ? error.message : "未知错误");
    }
    sampleRuntime = null;
    sampleApi = null;
  }
  if (previousDb && previousDb !== db) {
    try {
      await previousDb.close();
    } catch (error) {
      console.error("关闭原数据库失败", error instanceof Error ? error.message : "未知错误");
    }
  }
  try {
    const runtime = await startSampleRuntime({
      httpServer,
      db: state.db,
      config: state.config,
      authorize: authorizeSocket,
    });
    sampleRuntime = runtime;
    sampleApi = runtime.controller;
  } catch (error) {
    console.error("采样接入未启动", error instanceof Error ? error.message : "未知错误");
  }
  writeFileSync(configPath, JSON.stringify(nextConfig, null, 2), { encoding: "utf8", mode: 0o600 });
  chmodSync(configPath, 0o600);
  if (!existsSync(lockPath)) writeFileSync(lockPath, new Date().toISOString(), "utf8");
  console.log(`数据库已切换为 ${nextConfig.dialect}`);
}

async function operationLogs(ctx) {
  const page = await queryOperationLogs(state.db, ctx.user, ctx.query);
  if (page.error) return ctx.fail(page.error);
  ctx.ok({ list: page.list, nextCursor: page.nextCursor });
}

async function visitOverview(ctx) {
  ctx.ok(await queryVisitOverview(state.db, ctx.user));
}

async function visitTrend(ctx) {
  const trend = await queryVisitTrend(state.db, ctx.user, ctx.query);
  if (trend.error) return ctx.fail(trend.error);
  ctx.ok(trend);
}

function clientIp(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "")
    .split(",")[0]
    .trim();
  return (forwarded || req.socket?.remoteAddress || "").slice(0, 64);
}

function authorizeSocket(token) {
  const payload = readToken(token, state.config?.secret || "");
  return Boolean(payload?.userId && payload.typ !== "refresh");
}

function matchRoute(method, pathname) {
  for (const route of routes) {
    if (route.method !== method) continue;
    const names = [];
    const pattern = route.path.replace(/:([^/]+)/g, (_, name) => {
      names.push(name);
      return "([^/]+)";
    });
    const found = pathname.match(new RegExp(`^${pattern}$`));
    if (!found) continue;
    const params = {};
    names.forEach((name, index) => {
      params[name] = decodeURIComponent(found[index + 1]);
    });
    return { route, params };
  }
  return null;
}

const httpServer = createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    send(res, 204, "");
    return;
  }
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const matched = matchRoute(req.method || "GET", url.pathname);
  if (!matched) {
    fail(res, "接口不存在", "A0404", 404);
    return;
  }
  const query = Object.fromEntries(url.searchParams.entries());
  const createTime = url.searchParams.getAll("createTime");
  if (createTime.length) query.createTime = createTime;
  let body = {};
  if (req.method === "POST" || req.method === "PUT") {
    try {
      body = await readBody(req);
    } catch {
      fail(res, "请求体不是 JSON");
      return;
    }
  }
  const ctx = {
    db: state.db,
    query,
    body,
    params: matched.params,
    ip: clientIp(req),
    user: null,
    ok: (data, msg) => ok(res, data, msg),
    fail: (msg, code, status) => fail(res, msg, code, status),
  };
  try {
    if (matched.route.auth) {
      if (!state.installed) return ctx.fail("请先完成数据库安装");
      ctx.user = await currentUser(req);
      if (!ctx.user) return ctx.fail("登录已过期，请重新登录", "A0230");
    }
    if (matched.route.reserved) return ctx.ok(null, "接口已预留，表尚未创建");
    await matched.route.handler(ctx);
  } catch (error) {
    fail(res, error.message || "系统出错");
  }
});

loadInstalled()
  .then(async () => {
    if (state.installed) {
      try {
        const runtime = await startSampleRuntime({
          httpServer,
          db: state.db,
          config: state.config,
          authorize: authorizeSocket,
        });
        sampleRuntime = runtime;
        sampleApi = runtime.controller;
        console.log(
          `采样接入 TCP ${runtime.tcpAddress.address}:${runtime.tcpAddress.port}，实时通道 /api/v1/sample/stream`
        );
      } catch (error) {
        console.error("采样接入未启动", error);
      }
    }
    httpServer.listen(port, "0.0.0.0", () => {
      const mode = state.installed
        ? `已连接 ${state.config.dialect}`
        : "尚未安装，打开 /setup 填写数据库";
      console.log(`采样箱服务 http://localhost:${port}  ${mode}`);
    });
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
