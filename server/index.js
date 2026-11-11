import { SystemLog, setSystemLog, logSystem, observeRequest } from "./src/log/systemLog.js";
import { SystemLogController } from "./src/log/SystemLogController.js";
import { once as onceEvent } from "node:events";
import { createServer } from "node:http";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  consumeCaptcha,
  issueCaptcha,
  readToken,
  signToken,
  verifyPassword,
  sessionMatches,
  sessionClaims,
} from "./auth.js";
import { AccountSecurity } from "./src/auth/AccountSecurity.js";
import { migrate, openDatabase, seedOrg, testConnection } from "./db.js";
import { menuOptions, menusFor } from "./menus.js";
import * as org from "./org-api.js";
import { resolveAccess, seedRolePerms } from "./src/auth/boxAccess.js";
import { startSampleRuntime } from "./src/createSampleApp.js";
import { audit } from "./src/log/audit.js";
import {
  queryOnlineActors,
  queryUserStats,
  queryVisitOverview,
  queryVisitTrend,
} from "./src/log/operationAnalytics.js";
import { queryOperationLogs } from "./src/log/operationLog.js";
import { readDeployedCommit, readServingCertExpiry } from "./src/runtimeInfo.js";
import { mergeDatabaseSettings, publicDatabase, scrub } from "./src/settings/databaseConfig.js";
import { tcpPassthroughSettings } from "./src/tcpSettings.js";
import { mergeMapSettings, publicMap } from "./src/settings/mapConfig.js";
import { applyBoxSettings, mergeBoxSettings, publicBox } from "./src/settings/boxConfig.js";
import { mergeLabels, publicLabels } from "./src/settings/labelConfig.js";
import { searchPlaces } from "./src/geo/placeSearch.js";
import {
  describePolicy,
  lockedMinutes,
  mergeSecuritySettings,
  passwordChangeReason,
  publicSecurity,
} from "./src/settings/securityConfig.js";
import {
  mergeSmtpSettings,
  mergeVideoSettings,
  mergeWechatSettings,
  publicSmtp,
  publicVideo,
  publicWechat,
  readSmtp,
  readVideo,
  readWechat,
} from "./src/settings/integrationConfig.js";
import { WechatMini } from "./src/integration/WechatMini.js";
import { mergeBrandingSettings, readBranding } from "./src/settings/brandingConfig.js";
import { WechatAuth } from "./src/auth/WechatAuth.js";
import { Mailer } from "./src/integration/Mailer.js";
import { VideoPlatform } from "./src/integration/VideoPlatform.js";

const serverRoot = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(serverRoot, "..");
/**
 * SAMPLE_HOME：把安装标记、数据库配置和诊断日志放到别的目录，验收机器人用它起一套和开发库、线上都无关的临时环境。
 * SAMPLE_ACCEPTANCE=1：只在设了 SAMPLE_HOME 时生效，登录不校验验证码，给验收机器人用；线上的安装目录不会设这两个变量。
 */
const homeDir = process.env.SAMPLE_HOME ? resolve(process.env.SAMPLE_HOME) : "";
const lockPath = homeDir ? resolve(homeDir, "install.lock") : resolve(serverRoot, "install.lock");
const configPath = homeDir
  ? resolve(homeDir, "db.config.json")
  : resolve(serverRoot, "db.config.json");
const acceptance = Boolean(homeDir) && process.env.SAMPLE_ACCEPTANCE === "1";
if (acceptance)
  console.warn(`[验收] 临时环境 ${homeDir}：登录不校验验证码。线上不要设 SAMPLE_ACCEPTANCE`);
const port = Number(process.env.PORT) || 8000;

const state = { installed: false, db: null, config: null };
const accountSecurity = new AccountSecurity({ policy: () => publicSecurity(state.config) });
const wechat = new WechatMini({ settings: () => readWechat(state.config) });
const wechatAuth = new WechatAuth({
  wechat,
  credentials: (ctx, username, password) => checkCredentials(ctx, username, password),
  tokens: (user) => issueTokens(user),
  onLogin: (ctx, user) => writeLogin(ctx, user.username, user, "成功"),
});
if (wechat.fakeOpenid)
  console.warn(
    `[调试] 小程序登录不走微信接口，所有 code 都当成 openid=${wechat.fakeOpenid}；线上不要设 SAMPLE_WECHAT_FAKE_OPENID`
  );
let sampleApi = null;
let sampleRuntime = null;
let systemLogs = null;
try {
  systemLogs = new SystemLog(
    process.env.SYSTEM_LOG_PATH ||
      resolve(homeDir || resolve(serverRoot, "data"), "system-logs.sqlite"),
    { release: readDeployedCommit(projectRoot) }
  );
  setSystemLog(systemLogs);
} catch (error) {
  console.error("诊断日志库启动失败", error.message);
}
const systemLogApi = systemLogs ? new SystemLogController(systemLogs) : null;
process.on("uncaughtExceptionMonitor", (error, origin) => {
  logSystem({ source: "process", kind: "fatal", message: `${origin}: ${error.message}`, error });
});
process.on("exit", () => systemLogs?.close());

function send(res, status, payload) {
  if (res.diagnostic && payload && typeof payload === "object") {
    res.diagnostic.code = payload.code;
    if (payload.code !== "00000") res.diagnostic.message = payload.msg;
  }
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

function readBody(req, maxBytes = 10 * 1024 * 1024) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("请求体超过大小限制"));
        return;
      }
      chunks.push(chunk);
    });
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
  const user = await state.db.get("SELECT * FROM sys_user WHERE id = ?", [String(payload.userId)]);
  return sessionMatches(payload, user) ? user : null;
}

async function roleCodes(userId) {
  const rows = await state.db.all(
    `SELECT r.code FROM sys_role r
     INNER JOIN sys_user_role ur ON ur.role_id = r.id
     WHERE ur.user_id = ? AND r.status = 1`,
    [String(userId)]
  );
  return rows.map((row) => row.code);
}

const routes = [
  ...[
    ["GET", "/api/v1/system/runtime-logs", "page"],
    ["GET", "/api/v1/system/runtime-logs/:id", "detail"],
    ["POST", "/api/v1/system/runtime-logs/client", "client"],
  ].map(([method, path, action]) => ({
    method,
    path,
    auth: true,
    handler: (ctx) =>
      systemLogApi
        ? systemLogApi[action](ctx)
        : ctx.fail("诊断存储不可用，请检查服务器日志", "B0503", 503),
  })),
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
  // 小程序：静默登录、账号密码绑定、扫网页二维码绑定、自己解绑；网页个人中心：我的微信、生成绑定二维码
  {
    method: "POST",
    path: "/api/v1/auth/wechat/login",
    auth: false,
    handler: (ctx) => (state.installed ? wechatAuth.login(ctx) : ctx.fail("请先完成数据库安装")),
  },
  {
    method: "POST",
    path: "/api/v1/auth/wechat/bind",
    auth: false,
    handler: (ctx) => (state.installed ? wechatAuth.bind(ctx) : ctx.fail("请先完成数据库安装")),
  },
  {
    method: "POST",
    path: "/api/v1/auth/wechat/bind-ticket",
    auth: false,
    handler: (ctx) =>
      state.installed ? wechatAuth.bindTicket(ctx) : ctx.fail("请先完成数据库安装"),
  },
  {
    method: "POST",
    path: "/api/v1/auth/wechat/phone",
    auth: false,
    handler: (ctx) => (state.installed ? wechatAuth.phone(ctx) : ctx.fail("请先完成数据库安装")),
  },
  {
    method: "PUT",
    path: "/api/v1/auth/wechat/profile",
    auth: true,
    handler: (ctx) => wechatAuth.profile(ctx),
  },
  // 系统名称和图标：登录前就要用，不需要登录
  {
    method: "GET",
    path: "/api/v1/branding",
    auth: false,
    handler: async (ctx) => ctx.ok(readBranding(state.config)),
  },
  {
    method: "DELETE",
    path: "/api/v1/auth/wechat/bind",
    auth: true,
    handler: (ctx) => wechatAuth.unbind(ctx),
  },
  {
    method: "GET",
    path: "/api/v1/users/me/wechat",
    auth: true,
    handler: (ctx) => wechatAuth.mine(ctx),
  },
  {
    method: "POST",
    path: "/api/v1/users/me/wechat/ticket",
    auth: true,
    handler: (ctx) => wechatAuth.ticket(ctx),
  },
  { method: "DELETE", path: "/api/v1/auth/logout", auth: true, handler: async (ctx) => ctx.ok({}) },
  { method: "GET", path: "/api/v1/users/me", auth: true, handler: me },
  { method: "GET", path: "/api/v1/users/profile", auth: true, handler: profile },
  {
    method: "PUT",
    path: "/api/v1/users/password",
    auth: true,
    handler: (ctx) => accountSecurity.changePassword(ctx),
  },
  {
    method: "GET",
    path: "/api/v1/menus/routes",
    auth: true,
    handler: async (ctx) => {
      const access = await resolveAccess(ctx.db, ctx.user);
      ctx.ok(menusFor(access.perms));
    },
  },
  {
    method: "GET",
    path: "/api/v1/menus/options",
    auth: true,
    handler: async (ctx) => ctx.ok(menuOptions),
  },
  { method: "GET", path: "/api/v1/depts/options", auth: true, handler: org.deptOptions },
  {
    method: "GET",
    path: "/api/v1/depts",
    auth: true,
    perm: [
      "sys:dept:view",
      "sys:dept:create",
      "sys:dept:update",
      "sys:dept:type",
      "sys:dept:address",
      "sys:dept:camera",
      "sys:dept:leader",
      "sys:dept:delete",
      "sys:dept:limit",
    ],
    handler: org.listDepts,
  },
  {
    method: "POST",
    path: "/api/v1/depts",
    auth: true,
    perm: "sys:dept:create",
    handler: org.createDept,
  },
  {
    method: "GET",
    path: "/api/v1/depts/:id/form",
    auth: true,
    perm: [
      "sys:dept:view",
      "sys:dept:update",
      "sys:dept:type",
      "sys:dept:address",
      "sys:dept:camera",
      "sys:dept:leader",
    ],
    handler: org.deptForm,
  },
  // 基本信息、类型、地址、监控、负责人各自授权，具体改了哪样在 updateDept 里再查
  {
    method: "PUT",
    path: "/api/v1/depts/:id",
    auth: true,
    perm: [
      "sys:dept:update",
      "sys:dept:type",
      "sys:dept:address",
      "sys:dept:camera",
      "sys:dept:leader",
    ],
    handler: org.updateDept,
  },
  // 部门权限上限：只封顶不授权，下级不能超过上级
  {
    method: "GET",
    path: "/api/v1/depts/:id/limit",
    auth: true,
    perm: ["sys:dept:view", "sys:dept:limit"],
    handler: org.deptLimit,
  },
  {
    method: "PUT",
    path: "/api/v1/depts/:id/limit",
    auth: true,
    perm: "sys:dept:limit",
    handler: org.saveDeptLimit,
  },
  {
    method: "DELETE",
    path: "/api/v1/depts/:id",
    auth: true,
    perm: "sys:dept:delete",
    handler: org.deleteDepts,
  },
  { method: "GET", path: "/api/v1/roles/options", auth: true, handler: org.roleOptions },
  {
    method: "GET",
    path: "/api/v1/roles",
    auth: true,
    perm: [
      "sys:role:view",
      "sys:role:create",
      "sys:role:update",
      "sys:role:delete",
      "sys:role:grant",
      "sys:user:role",
    ],
    handler: org.listRoles,
  },
  {
    method: "GET",
    path: "/api/v1/roles/perm-catalog",
    auth: true,
    perm: [
      "sys:role:view",
      "sys:role:update",
      "sys:role:grant",
      "sys:dept:limit",
      "sys:dept:view",
      "sys:user:view",
    ],
    handler: org.permCatalog,
  },
  {
    method: "GET",
    path: "/api/v1/roles/:id/perms",
    auth: true,
    perm: ["sys:role:view", "sys:role:update", "sys:role:grant"],
    handler: org.rolePerms,
  },
  {
    method: "PUT",
    path: "/api/v1/roles/:id/perms",
    auth: true,
    perm: "sys:role:grant",
    handler: org.saveRolePerms,
  },
  {
    method: "POST",
    path: "/api/v1/roles",
    auth: true,
    perm: "sys:role:create",
    handler: org.createRole,
  },
  {
    method: "GET",
    path: "/api/v1/roles/:id/form",
    auth: true,
    perm: ["sys:role:view", "sys:role:update", "sys:role:scope", "sys:role:grant"],
    handler: org.roleForm,
  },
  {
    method: "GET",
    path: "/api/v1/roles/:id/dept-ids",
    auth: true,
    handler: async (ctx) => ctx.ok([]),
  },
  {
    method: "PUT",
    path: "/api/v1/roles/:id",
    auth: true,
    perm: ["sys:role:update", "sys:role:scope"],
    handler: org.updateRole,
  },
  {
    method: "DELETE",
    path: "/api/v1/roles/:id",
    auth: true,
    perm: "sys:role:delete",
    handler: org.deleteRoles,
  },
  {
    method: "GET",
    path: "/api/v1/users",
    auth: true,
    perm: [
      "sys:user:view",
      "sys:user:create",
      "sys:user:update",
      "sys:user:disable",
      "sys:user:enable",
      "sys:user:delete",
    ],
    handler: org.listUsers,
  },
  // 一个人的实际权限：每项从哪个角色来、有没有被部门上限挡住
  {
    method: "GET",
    path: "/api/v1/users/:id/effective-perms",
    auth: true,
    perm: "sys:user:view",
    handler: org.effectivePerms,
  },
  {
    method: "POST",
    path: "/api/v1/users",
    auth: true,
    perm: "sys:user:create",
    handler: org.createUser,
  },
  {
    method: "GET",
    path: "/api/v1/users/:id/form",
    auth: true,
    perm: ["sys:user:view", "sys:user:update", "sys:user:role"],
    handler: org.userForm,
  },
  {
    method: "POST",
    path: "/api/v1/users/:id/force-password",
    auth: true,
    perm: "sys:user:force-password",
    handler: org.forcePasswordChange,
  },
  {
    method: "POST",
    path: "/api/v1/users/:id/skip-password",
    auth: true,
    perm: "sys:user:force-password",
    handler: org.skipPasswordChange,
  },
  {
    method: "POST",
    path: "/api/v1/users/:id/unlock",
    auth: true,
    perm: "sys:user:unlock",
    handler: org.unlockUser,
  },
  {
    method: "POST",
    path: "/api/v1/users/:id/kick",
    auth: true,
    perm: "sys:user:kick",
    handler: org.kickUser,
  },
  {
    method: "DELETE",
    path: "/api/v1/users/:id/wechat",
    auth: true,
    perm: "sys:user:unbind-wechat",
    handler: org.unbindWechat,
  },
  {
    method: "PUT",
    path: "/api/v1/users/:id/password/reset",
    auth: true,
    perm: "sys:user:reset-password",
    handler: org.resetPassword,
  },
  // 资料、停用、角色分开授权，具体改了哪样在 updateUser 里再查
  {
    method: "PUT",
    path: "/api/v1/users/:id",
    auth: true,
    perm: ["sys:user:update", "sys:user:disable", "sys:user:enable", "sys:user:role"],
    handler: org.updateUser,
  },
  {
    method: "DELETE",
    path: "/api/v1/users/:id",
    auth: true,
    perm: "sys:user:delete",
    handler: org.deleteUsers,
  },
  {
    method: "GET",
    path: "/api/v1/sample/boxes/stats",
    auth: true,
    handler: (ctx) => useSample(ctx, (api) => api.stats(ctx)),
  },
  {
    method: "GET",
    path: "/api/v1/sample/boxes/export",
    auth: true,
    handler: (ctx) => useSample(ctx, (api) => api.export(ctx)),
  },
  {
    method: "GET",
    path: "/api/v1/sample/boxes/:id/report-policy",
    auth: true,
    handler: (ctx) => useSample(ctx, (api) => api.policy.read(ctx)),
  },
  {
    method: "GET",
    path: "/api/v1/sample/boxes/:id/scan",
    auth: true,
    handler: (ctx) => useSample(ctx, (api) => api.policy.scan(ctx)),
  },
  {
    method: "DELETE",
    path: "/api/v1/sample/boxes/:id",
    auth: true,
    handler: (ctx) => useSample(ctx, (api) => api.remove(ctx)),
  },
  {
    method: "GET",
    path: "/api/v1/sample/boxes/:id/export-logs",
    auth: true,
    handler: (ctx) => useSample(ctx, (api) => api.exportLogs(ctx)),
  },
  {
    method: "POST",
    path: "/api/v1/sample/boxes/:id/dump",
    auth: true,
    handler: (ctx) => useSample(ctx, (api) => api.dumpQuery(ctx)),
  },
  {
    method: "GET",
    path: "/api/v1/sample/boxes/:id/dump",
    auth: true,
    handler: (ctx) => useSample(ctx, (api) => api.dumpStatus(ctx)),
  },
  {
    method: "PUT",
    path: "/api/v1/sample/boxes/:id/dump/:req",
    auth: true,
    handler: (ctx) => useSample(ctx, (api) => api.dumpConfirm(ctx)),
  },
  {
    method: "DELETE",
    path: "/api/v1/sample/boxes/:id/dump/:req",
    auth: true,
    handler: (ctx) => useSample(ctx, (api) => api.dumpCancel(ctx)),
  },
  {
    method: "GET",
    path: "/api/v1/sample/boxes/:id/dump/:req/download",
    auth: true,
    handler: (ctx) => useSample(ctx, (api) => api.dumpDownload(ctx)),
  },
  {
    method: "PUT",
    path: "/api/v1/sample/boxes/:id/report-policy",
    auth: true,
    handler: (ctx) => useSample(ctx, (api) => api.policy.save(ctx)),
  },
  {
    method: "POST",
    path: "/api/v1/sample/report-policy/preview",
    auth: true,
    handler: (ctx) => useSample(ctx, (api) => api.policy.preview(ctx)),
  },
  {
    method: "PUT",
    path: "/api/v1/sample/report-policy/batch",
    auth: true,
    handler: (ctx) => useSample(ctx, (api) => api.policy.batch(ctx)),
  },
  {
    method: "POST",
    path: "/api/v1/sample/tasks",
    auth: true,
    handler: (ctx) => useSample(ctx, (api) => api.policy.createTask(ctx)),
  },
  {
    method: "GET",
    path: "/api/v1/sample/tasks",
    auth: true,
    handler: (ctx) => useSample(ctx, (api) => api.policy.tasks(ctx)),
  },
  {
    method: "GET",
    path: "/api/v1/sample/tasks/options",
    auth: true,
    handler: (ctx) => useSample(ctx, (api) => api.policy.taskOptions(ctx)),
  },
  {
    method: "GET",
    path: "/api/v1/sample/tasks/:id",
    auth: true,
    handler: (ctx) => useSample(ctx, (api) => api.policy.taskDetail(ctx)),
  },
  {
    method: "PUT",
    path: "/api/v1/sample/tasks/:id/status",
    auth: true,
    handler: (ctx) => useSample(ctx, (api) => api.policy.transition(ctx)),
  },
  // 检测站扫码：一台箱子开始检测，这台箱子的本次任务结束
  // 签收核验：收货方扫码后看箱子状态、开箱次数、在不在收货点附近，以及能签收、强制签收还是拒收
  {
    method: "GET",
    path: "/api/v1/sample/tasks/:id/receive",
    auth: true,
    handler: (ctx) => useSample(ctx, (api) => api.policy.receive(ctx)),
  },
  {
    method: "POST",
    path: "/api/v1/sample/tasks/:id/boxes/:boxId/inspect",
    auth: true,
    handler: (ctx) => useSample(ctx, (api) => api.policy.inspect(ctx)),
  },
  // 总览：集团看各分公司、检测站；单位看自己（按日看任务）
  {
    method: "GET",
    path: "/api/v1/sample/overview",
    auth: true,
    handler: (ctx) => useSample(ctx, (api) => api.overview.group(ctx)),
  },
  {
    method: "GET",
    path: "/api/v1/sample/overview/:orgId",
    auth: true,
    handler: (ctx) => useSample(ctx, (api) => api.overview.unit(ctx)),
  },
  {
    method: "GET",
    path: "/api/v1/sample/tasks/:id/logs",
    auth: true,
    handler: (ctx) => useSample(ctx, (api) => api.policy.taskLogs(ctx)),
  },
  {
    method: "GET",
    path: "/api/v1/sample/tasks/:id/track",
    auth: true,
    handler: (ctx) => useSample(ctx, (api) => api.policy.taskTrack(ctx)),
  },
  {
    method: "POST",
    path: "/api/v1/sample/tasks/:id/videos/:videoId/retry",
    auth: true,
    handler: (ctx) => useSample(ctx, (api) => api.policy.retryVideo(ctx)),
  },
  {
    method: "GET",
    path: "/api/v1/sample/workbench",
    auth: true,
    handler: (ctx) => useSample(ctx, (api) => api.workbench(ctx)),
  },
  {
    method: "GET",
    path: "/api/v1/sample/boxes/:id/track",
    auth: true,
    handler: (ctx) => useSample(ctx, (api) => api.track(ctx)),
  },
  {
    method: "PUT",
    path: "/api/v1/sample/boxes/:id/name",
    auth: true,
    handler: (ctx) => useSample(ctx, (api) => api.rename(ctx)),
  },
  {
    method: "GET",
    path: "/api/v1/sample/boxes/assign-options",
    auth: true,
    handler: (ctx) => useSample(ctx, (api) => api.assignOptions(ctx)),
  },
  {
    method: "POST",
    path: "/api/v1/sample/boxes/:id/activate",
    auth: true,
    handler: (ctx) => useSample(ctx, (api) => api.activate(ctx)),
  },
  {
    method: "POST",
    path: "/api/v1/sample/boxes/:id/disable",
    auth: true,
    handler: (ctx) => useSample(ctx, (api) => api.disable(ctx)),
  },
  {
    method: "POST",
    path: "/api/v1/sample/boxes/:id/restore",
    auth: true,
    handler: (ctx) => useSample(ctx, (api) => api.restore(ctx)),
  },
  {
    method: "PUT",
    path: "/api/v1/sample/boxes/:id/assign",
    auth: true,
    handler: (ctx) => useSample(ctx, (api) => api.assign(ctx)),
  },
  {
    method: "GET",
    path: "/api/v1/sample/boxes/:id/logs/:logId",
    auth: true,
    handler: (ctx) => useSample(ctx, (api) => api.raw(ctx)),
  },
  {
    method: "GET",
    path: "/api/v1/sample/boxes/:id/battery",
    auth: true,
    handler: (ctx) => useSample(ctx, (api) => api.battery(ctx)),
  },
  {
    method: "GET",
    path: "/api/v1/sample/boxes/:id/places",
    auth: true,
    handler: (ctx) => useSample(ctx, (api) => api.places(ctx)),
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
    perm: "sys:settings:db",
    handler: saveDatabase,
  },
  {
    method: "PUT",
    path: "/api/v1/system/settings/map",
    auth: true,
    perm: "sys:settings:map",
    handler: saveMap,
  },
  {
    method: "PUT",
    path: "/api/v1/system/settings/box",
    auth: true,
    // 默认上报策略、电量预留、到达半径各自授权，saveBox 里按改了哪样再查
    perm: [
      "device:box:policyDefault",
      "sys:settings:battery-reserve",
      "sys:settings:arrive-radius",
    ],
    handler: saveBox,
  },
  {
    method: "GET",
    path: "/api/v1/geo/search",
    auth: true,
    handler: searchPlacesRoute,
  },
  {
    method: "GET",
    path: "/api/v1/system/labels",
    auth: true,
    handler: (ctx) => ctx.ok(publicLabels(state.config)),
  },
  {
    method: "PUT",
    path: "/api/v1/system/settings/labels",
    auth: true,
    perm: "sys:settings:labels",
    handler: saveLabels,
  },
  // 密码规则、登录失败锁定各自授权，saveSecurity 里按改了哪样再查
  {
    method: "PUT",
    path: "/api/v1/system/settings/security",
    auth: true,
    perm: ["sys:settings:password", "sys:settings:lockout"],
    handler: saveSecurity,
  },
  {
    method: "PUT",
    path: "/api/v1/system/settings/smtp",
    auth: true,
    perm: "sys:settings:smtp",
    handler: saveSmtp,
  },
  {
    method: "POST",
    path: "/api/v1/system/settings/smtp/test",
    auth: true,
    perm: "sys:settings:smtp",
    handler: testSmtp,
  },
  {
    method: "PUT",
    path: "/api/v1/system/settings/video",
    auth: true,
    perm: "sys:settings:video",
    handler: saveVideo,
  },
  {
    method: "POST",
    path: "/api/v1/system/settings/video/test",
    auth: true,
    perm: "sys:settings:video",
    handler: testVideo,
  },
  {
    method: "PUT",
    path: "/api/v1/system/settings/wechat",
    auth: true,
    perm: "sys:settings:wechat",
    handler: saveWechat,
  },
  {
    method: "PUT",
    path: "/api/v1/system/settings/branding",
    auth: true,
    perm: "sys:settings:branding",
    handler: saveBranding,
  },
  {
    method: "GET",
    path: "/api/v1/system/settings/security-rule",
    auth: true,
    handler: (ctx) =>
      ctx.ok({
        rule: describePolicy(publicSecurity(state.config)),
        policy: publicSecurity(state.config),
      }),
  },
  {
    method: "GET",
    path: "/api/v1/system/operation-logs",
    auth: true,
    perm: "sys:oplog:read",
    handler: operationLogs,
  },
  {
    method: "GET",
    path: "/api/v1/logs/analytics/overview",
    auth: true,
    perm: "sys:oplog:read",
    handler: visitOverview,
  },
  {
    method: "GET",
    path: "/api/v1/logs/analytics/online",
    auth: true,
    perm: "sys:oplog:read",
    handler: onlineActors,
  },
  {
    method: "GET",
    path: "/api/v1/logs/analytics/users",
    auth: true,
    perm: "sys:oplog:read",
    handler: userStats,
  },
  {
    method: "GET",
    path: "/api/v1/logs/analytics/trend",
    auth: true,
    perm: "sys:oplog:read",
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
    await seedRolePerms(db);
  } catch (error) {
    if (db) await db.close();
    return ctx.fail(`安装失败：${error.message}`);
  }
  writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
  writeFileSync(lockPath, new Date().toISOString(), "utf8");
  state.config = config;
  state.db = db;
  state.installed = true;
  ctx.ok({ installed: true }, "安装完成，管理员账号 admin，初始密码 123456，首次登录需修改密码");
}

async function login(ctx) {
  if (!state.installed) return ctx.fail("请先完成数据库安装");
  const body = ctx.body || {};
  if (!acceptance && !consumeCaptcha(body.captchaId, body.captchaCode)) {
    await writeLogin(ctx, body.username, null, "失败");
    return ctx.fail("验证码错误");
  }
  const checked = await checkCredentials(ctx, body.username, body.password);
  if (checked.fail) return ctx.fail(...checked.fail);
  await writeLogin(ctx, body.username, checked.user, "成功");
  ctx.ok(issueTokens(checked.user));
}

/**
 * 账号密码校验，带登录失败锁定。网页登录（先过验证码）和小程序绑定共用。
 * 成功返回 { user }，失败返回 { fail: [提示, 错误码, 状态码] }，失败已记登录日志。
 */
async function checkCredentials(ctx, username, password) {
  if (typeof username !== "string" || !username || username.length > 64)
    return { fail: ["用户名或密码错误"] };
  const user = await state.db.get("SELECT * FROM sys_user WHERE username = ?", [username]);
  const policy = publicSecurity(state.config);
  const locked = user ? lockedMinutes(user) : 0;
  if (locked) {
    await writeLogin(ctx, username, user, "失败");
    return { fail: [`账号已锁定，请 ${locked} 分钟后再试，或联系管理员解锁`, "A0233", 403] };
  }
  if (
    !user ||
    Number(user.status) !== 1 ||
    !verifyPassword(typeof password === "string" ? password : "", user.password_hash)
  ) {
    await writeLogin(ctx, username, user, "失败");
    if (user && Number(user.status) === 1) {
      // 连续输错到阈值就锁定，计数清零
      const failed = Number(user.failed_count || 0) + 1;
      if (failed >= policy.lockThreshold) {
        const until = new Date(Date.now() + policy.lockMinutes * 60000).toISOString();
        await state.db.run("UPDATE sys_user SET failed_count = 0, locked_until = ? WHERE id = ?", [
          until,
          user.id,
        ]);
        return {
          fail: [
            `密码连续输错 ${policy.lockThreshold} 次，账号已锁定 ${policy.lockMinutes} 分钟`,
            "A0233",
            403,
          ],
        };
      }
      await state.db.run("UPDATE sys_user SET failed_count = ? WHERE id = ?", [failed, user.id]);
      const left = policy.lockThreshold - failed;
      if (left <= 2) return { fail: [`用户名或密码错误，再错 ${left} 次将锁定账号`] };
    }
    return { fail: ["用户名或密码错误"] };
  }
  if (Number(user.failed_count || 0) || user.locked_until) {
    await state.db.run("UPDATE sys_user SET failed_count = 0, locked_until = '' WHERE id = ?", [
      user.id,
    ]);
  }
  return { user };
}

function issueTokens(user) {
  const accessToken = signToken(sessionClaims(user), state.config.secret, 7200);
  const refreshToken = signToken(
    { ...sessionClaims(user), typ: "refresh" },
    state.config.secret,
    7 * 24 * 3600
  );
  return { accessToken, refreshToken, tokenType: "Bearer", expiresIn: 7200 };
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
  if (!payload?.userId || payload.typ !== "refresh") return ctx.fail("刷新令牌无效", "A0231", 401);
  const user = await state.db.get("SELECT * FROM sys_user WHERE id = ?", [String(payload.userId)]);
  if (!sessionMatches(payload, user, "refresh"))
    return ctx.fail("登录已失效，请重新登录", "A0231", 401);
  const accessToken = signToken(sessionClaims(user), state.config.secret, 7200);
  const refreshToken = signToken(
    { ...sessionClaims(user), typ: "refresh" },
    state.config.secret,
    7 * 24 * 3600
  );
  ctx.ok({ accessToken, refreshToken, tokenType: "Bearer", expiresIn: 7200 });
}

/** 系统管理的按钮权限只给系统管理员；采样箱和视角权限按角色页保存的授权算。 */
async function me(ctx) {
  const roles = await roleCodes(ctx.user.id);
  const access = await resolveAccess(state.db, ctx.user);
  const policy = publicSecurity(state.config);
  ctx.ok({
    userId: ctx.user.id,
    username: ctx.user.username,
    nickname: ctx.user.nickname,
    avatar: ctx.user.avatar || "",
    roles,
    perms: [...legacyPerms(access.perms), ...access.perms],
    dataScope: access.scope.all ? "all" : "scoped",
    passwordChange: passwordChangeReason(ctx.user, policy),
    passwordRule: describePolicy(policy),
    wechatBound: Boolean(
      await state.db.get("SELECT openid FROM sys_user_wechat WHERE user_id = ?", [
        String(ctx.user.id),
      ])
    ),
  });
}

/** 模板页面还在用的按钮权限码，由新的权限码推出来。 */
function legacyPerms(granted) {
  const out = [];
  const map = {
    // 增删改已经是独立的权限码（迁移 043），这里只剩列表和分配的旧别名
    "sys:user:view": ["sys:user:list"],
    "sys:role:view": ["sys:role:list"],
    "sys:role:grant": ["sys:role:assign"],
    "sys:dept:view": ["sys:dept:list"],
  };
  for (const [code, aliases] of Object.entries(map)) if (granted.has(code)) out.push(...aliases);
  return out;
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
    email: ctx.user.email || "",
    deptName: dept?.name || "",
    passwordChangedAt: ctx.user.password_changed_at || "",
    roleNames: roles.map((item) => item.name).join(","),
    createTime: ctx.user.create_time,
  });
}

async function useSample(ctx, run) {
  if (!sampleApi) return ctx.fail("请先完成数据库安装");
  ctx.access = await resolveAccess(state.db, ctx.user);
  return run(sampleApi);
}

async function systemSettings(ctx) {
  const access = await resolveAccess(state.db, ctx.user);
  const has = (code) => access.perms.has(code);
  const certExpiresAt = await readServingCertExpiry();
  const view = has("sys:settings:view");
  const can = {
    map: has("sys:settings:map"),
    labels: has("sys:settings:labels"),
    branding: has("sys:settings:branding"),
    db: has("sys:settings:db"),
    password: has("sys:settings:password"),
    lockout: has("sys:settings:lockout"),
    smtp: has("sys:settings:smtp"),
    video: has("sys:settings:video"),
    wechat: has("sys:settings:wechat"),
    box: has("device:box:policyDefault"),
    batteryReserve: has("sys:settings:battery-reserve"),
    arriveRadius: has("sys:settings:arrive-radius"),
  };
  const anySetting = view || Object.values(can).some(Boolean);
  const map = publicMap(state.config);
  ctx.ok({
    // 接入口、版本、证书只给能进系统设置的人
    ...(anySetting
      ? tcpPassthroughSettings(sampleRuntime?.tcpAddress?.port, process.env, {
          version: readDeployedCommit(projectRoot),
          certExpiresAt,
        })
      : {}),
    database: view || can.db ? publicDatabase(state.config) : null,
    // 天地图 tk 是浏览器端密钥，看地图的人都要用；sk 是服务端密钥，只给能改地图密钥的人
    map: { tk: map.tk, sk: can.map ? map.sk : "" },
    box: publicBox(state.config),
    labels: publicLabels(state.config),
    security: view || can.password || can.lockout ? publicSecurity(state.config) : null,
    smtp: view || can.smtp ? publicSmtp(state.config) : null,
    video: view || can.video ? publicVideo(state.config) : null,
    wechat: view || can.wechat ? publicWechat(state.config) : null,
    branding: readBranding(state.config),
    can,
  });
}

function saveConfig(next) {
  state.config = next;
  writeFileSync(configPath, JSON.stringify(next, null, 2), { encoding: "utf8", mode: 0o600 });
  chmodSync(configPath, 0o600);
}

async function auditSetting(ctx, action, targetType, result = "成功") {
  await audit(state.db, {
    orgId: String(ctx.user.dept_id || ""),
    orgName: "",
    actorId: String(ctx.user.id),
    actorName: ctx.user.nickname || ctx.user.username,
    action,
    targetType,
    targetId: "",
    result,
    ip: ctx.ip || "",
  });
}

async function saveSecurity(ctx) {
  let next;
  try {
    next = mergeSecuritySettings(state.config, ctx.body || {});
  } catch (error) {
    return ctx.fail(error instanceof Error ? error.message : "安全设置不正确");
  }
  // 密码规则、登录失败锁定各自授权：改了哪一块就查哪一项
  const before = publicSecurity(state.config);
  const after = next.security;
  const same = (keys) =>
    keys.every((key) => JSON.stringify(before[key]) === JSON.stringify(after[key]));
  if (
    !same(["minLength", "classes", "expireDays"]) &&
    !ctx.access?.perms?.has("sys:settings:password")
  )
    return ctx.fail("没有「修改密码规则」权限");
  if (!same(["lockThreshold", "lockMinutes"]) && !ctx.access?.perms?.has("sys:settings:lockout"))
    return ctx.fail("没有「修改登录失败锁定」权限");
  saveConfig(next);
  await auditSetting(ctx, "修改密码策略", "security");
  ctx.ok(publicSecurity(state.config), "已保存");
}

async function saveSmtp(ctx) {
  let next;
  try {
    next = mergeSmtpSettings(state.config, ctx.body || {});
  } catch (error) {
    return ctx.fail(error instanceof Error ? error.message : "邮件设置不正确");
  }
  saveConfig(next);
  await auditSetting(ctx, "修改邮件服务", "smtp");
  ctx.ok(publicSmtp(state.config), "已保存");
}

/** 测试邮件服务：带收件人就发一封测试信，不带只验证能登录。用表单里的值试，不必先保存。 */
async function testSmtp(ctx) {
  const body = ctx.body || {};
  let config;
  try {
    config = readSmtp(mergeSmtpSettings(state.config, { ...body, enabled: true }));
  } catch (error) {
    return ctx.fail(error instanceof Error ? error.message : "邮件设置不正确");
  }
  const mailer = new Mailer(() => config);
  try {
    if (body.to) {
      await mailer.send(
        {
          to: String(body.to),
          subject: "智采 · 采样箱 测试邮件",
          text: "这是一封测试邮件，收到说明邮件服务配置正确。",
        },
        config
      );
      return ctx.ok({ sent: true }, "测试邮件已发出");
    }
    await mailer.verify(config);
    ctx.ok({ sent: false }, "连接和登录成功");
  } catch (error) {
    ctx.fail(error instanceof Error ? error.message : "邮件服务测试失败");
  }
}

async function saveVideo(ctx) {
  let next;
  try {
    next = mergeVideoSettings(state.config, ctx.body || {});
  } catch (error) {
    return ctx.fail(error instanceof Error ? error.message : "视频平台设置不正确");
  }
  saveConfig(next);
  await auditSetting(ctx, "修改视频平台", "video");
  ctx.ok(publicVideo(state.config), "已保存");
}

async function saveWechat(ctx) {
  let next;
  try {
    next = mergeWechatSettings(state.config, ctx.body || {});
  } catch (error) {
    return ctx.fail(error instanceof Error ? error.message : "小程序设置不正确");
  }
  saveConfig(next);
  await auditSetting(ctx, "修改微信小程序设置", "wechat");
  ctx.ok(publicWechat(state.config), "已保存");
}

async function saveBranding(ctx) {
  let next;
  try {
    next = mergeBrandingSettings(state.config, ctx.body || {});
  } catch (error) {
    return ctx.fail(error instanceof Error ? error.message : "名称或图标不正确");
  }
  saveConfig(next);
  await auditSetting(ctx, "修改系统名称和图标", "branding");
  ctx.ok(readBranding(state.config), "已保存");
}

async function testVideo(ctx) {
  let config;
  try {
    config = readVideo(mergeVideoSettings(state.config, { ...(ctx.body || {}), enabled: true }));
  } catch (error) {
    return ctx.fail(error instanceof Error ? error.message : "视频平台设置不正确");
  }
  const result = await new VideoPlatform(() => config).test(config);
  if (result.status === "失败") return ctx.fail(result.detail);
  ctx.ok(result, result.detail);
}

async function saveMap(ctx) {
  let next;
  try {
    next = mergeMapSettings(state.config, ctx.body || {});
  } catch (error) {
    return ctx.fail(error instanceof Error ? error.message : "地图密钥不正确");
  }
  state.config = next;
  writeFileSync(configPath, JSON.stringify(next, null, 2), { encoding: "utf8", mode: 0o600 });
  chmodSync(configPath, 0o600);
  await audit(state.db, {
    orgId: String(ctx.user.dept_id || ""),
    orgName: "",
    actorId: String(ctx.user.id),
    actorName: ctx.user.nickname || ctx.user.username,
    action: "修改天地图密钥",
    targetType: "map",
    targetId: "",
    result: "成功",
    ip: ctx.ip || "",
  });
  ctx.ok(publicMap(state.config), "已保存");
}

async function saveBox(ctx) {
  let next;
  try {
    next = mergeBoxSettings(state.config, ctx.body || {});
  } catch (error) {
    return ctx.fail(error instanceof Error ? error.message : "采样箱设置不正确");
  }
  // 默认上报策略、电量预留、到达半径各自授权：改了哪一块就查哪一项
  const before = publicBox(state.config);
  const after = next.box;
  const perms = ctx.access?.perms;
  if (
    (before.reportPeriodSec !== after.reportPeriodSec ||
      Boolean(before.reportOnlyWhenCharging) !== after.reportOnlyWhenCharging) &&
    !perms?.has("device:box:policyDefault")
  )
    return ctx.fail("没有「修改默认上报策略」权限");
  if (
    Number(before.batteryReserve) !== after.batteryReserve &&
    !perms?.has("sys:settings:battery-reserve")
  )
    return ctx.fail("没有「修改电量预留比例」权限");
  if (
    Number(before.arriveRadiusM) !== after.arriveRadiusM &&
    !perms?.has("sys:settings:arrive-radius")
  )
    return ctx.fail("没有「修改到达判定半径」权限");
  state.config = next;
  writeFileSync(configPath, JSON.stringify(next, null, 2), { encoding: "utf8", mode: 0o600 });
  chmodSync(configPath, 0o600);
  applyBoxSettings(state.config);
  await audit(state.db, {
    orgId: String(ctx.user.dept_id || ""),
    orgName: "",
    actorId: String(ctx.user.id),
    actorName: ctx.user.nickname || ctx.user.username,
    action: "修改采样箱设置",
    targetType: "box",
    targetId: "",
    result: "成功",
    ip: ctx.ip || "",
  });
  ctx.ok(publicBox(state.config), "已保存");
}

/** 地图选点的地名搜索：按全国、省、市逐级缩小，密钥只留在服务器。 */
async function searchPlacesRoute(ctx) {
  try {
    ctx.ok(
      await searchPlaces({
        tk: publicMap(state.config).tk,
        keyword: ctx.query?.q,
        region: ctx.query?.region,
        page: ctx.query?.page,
      })
    );
  } catch (error) {
    ctx.fail(error instanceof Error ? error.message : "地名搜索失败");
  }
}

async function saveLabels(ctx) {
  let next;
  try {
    next = mergeLabels(state.config, ctx.body || {});
  } catch (error) {
    return ctx.fail(error instanceof Error ? error.message : "显示名称不正确");
  }
  state.config = next;
  writeFileSync(configPath, JSON.stringify(next, null, 2), { encoding: "utf8", mode: 0o600 });
  chmodSync(configPath, 0o600);
  await audit(state.db, {
    orgId: String(ctx.user.dept_id || ""),
    orgName: "",
    actorId: String(ctx.user.id),
    actorName: ctx.user.nickname || ctx.user.username,
    action: "修改显示名称",
    targetType: "labels",
    targetId: "",
    result: "成功",
    ip: ctx.ip || "",
  });
  ctx.ok(publicLabels(state.config), "已保存");
}

async function saveDatabase(ctx) {
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
    await seedRolePerms(db);
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
      getConfig: () => state.config,
      db: state.db,
      config: state.config,
      authorize: authorizeSocket,
      access: socketAccess,
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

async function onlineActors(ctx) {
  ctx.ok(await queryOnlineActors(state.db, ctx.user));
}

async function userStats(ctx) {
  ctx.ok(await queryUserStats(state.db, ctx.user));
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

async function socketAccess(token) {
  if (!authorizeSocket(token)) return null;
  const payload = readToken(token, state.config?.secret || "");
  const user = await state.db.get("SELECT * FROM sys_user WHERE id = ?", [String(payload.userId)]);
  if (!sessionMatches(payload, user)) return null;
  return resolveAccess(state.db, user);
}

async function streamDownload(res, filename, chunks) {
  res.writeHead(200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Expose-Headers": "Content-Disposition",
  });
  for await (const chunk of chunks) {
    if (!res.write(chunk)) await onceEvent(res, "drain");
  }
  res.end();
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

/** 须改密时仍可调用的接口。 */
const PASSWORD_GATE_OPEN = new Set([
  "/api/v1/users/password",
  "/api/v1/auth/logout",
  "/api/v1/auth/wechat/bind",
  "/api/v1/users/me",
  "/api/v1/users/profile",
  "/api/v1/menus/routes",
  "/api/v1/system/labels",
  "/api/v1/system/runtime-logs/client",
]);

const httpServer = createServer(async (req, res) => {
  const diagnostic = observeRequest(req, res);
  try {
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
        body = await readBody(
          req,
          url.pathname === "/api/v1/system/runtime-logs/client" ? 32768 : undefined
        );
      } catch (error) {
        fail(
          res,
          error.message === "请求体超过大小限制" ? error.message : "请求体不是 JSON",
          "A0400",
          400
        );
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
      invalidateSessions: (id) => sampleRuntime?.disconnectUser(id),
      ok: (data, msg) => ok(res, data, msg),
      fail: (msg, code, status) => fail(res, msg, code, status),
      download: (filename, chunks) => streamDownload(res, filename, chunks),
    };
    try {
      if (matched.route.path.startsWith("/api/v1/sample/boxes/:id") && ctx.params.id) {
        diagnostic.deviceId = ctx.params.id;
      }
      if (matched.route.auth) {
        if (!state.installed) return ctx.fail("请先完成数据库安装");
        ctx.user = await currentUser(req);
        diagnostic.actorId = ctx.user?.id;
        if (!ctx.user) return ctx.fail("登录已过期，请重新登录", "A0230", 401);
      }
      if (matched.route.auth) {
        ctx.security = publicSecurity(state.config);
        // 须改密的账号只能改密、退出、读自己的资料
        if (
          passwordChangeReason(ctx.user, ctx.security) &&
          !PASSWORD_GATE_OPEN.has(matched.route.path)
        ) {
          return ctx.fail("请先修改密码", "A0240", 403);
        }
      }
      if (matched.route.perm) {
        ctx.access = await resolveAccess(state.db, ctx.user);
        const wanted = Array.isArray(matched.route.perm)
          ? matched.route.perm
          : [matched.route.perm];
        if (!wanted.some((code) => ctx.access.perms.has(code)))
          return ctx.fail("没有这项操作权限", "A0301", 403);
      }
      if (matched.route.reserved) return ctx.ok(null, "接口已预留，表尚未创建");
      await matched.route.handler(ctx);
    } catch (error) {
      diagnostic.error = error;
      if (res.headersSent) {
        res.destroy(error);
        return;
      }
      fail(res, error.message || "系统出错", error.publicCode || "B0001", error.httpStatus || 500);
    }
  } catch (error) {
    diagnostic.error = error;
    if (!res.headersSent) fail(res, "请求处理异常", "B0001", 500);
    else res.destroy(error);
  }
});
httpServer.on("error", (error) => {
  logSystem({ source: "process", kind: "startup", error });
  console.error(error);
});

loadInstalled()
  .then(async () => {
    if (state.installed) {
      try {
        const runtime = await startSampleRuntime({
          httpServer,
          getConfig: () => state.config,
          db: state.db,
          config: state.config,
          authorize: authorizeSocket,
          access: socketAccess,
        });
        sampleRuntime = runtime;
        sampleApi = runtime.controller;
        console.log(
          `采样接入 TCP ${runtime.tcpAddress.address}:${runtime.tcpAddress.port}，实时通道 /api/v1/sample/stream`
        );
      } catch (error) {
        logSystem({ source: "tcp", kind: "startup", message: "采样接入未启动", error });
        console.error("采样接入未启动", error);
      }
    }
    httpServer.listen(port, "0.0.0.0", () => {
      const mode = state.installed
        ? `已连接 ${state.config.dialect}`
        : "尚未安装，打开 /setup 填写数据库";
      logSystem({
        source: "process",
        level: "info",
        kind: "startup",
        message: `服务启动，${mode}`,
      });
      console.log(`采样箱服务 http://localhost:${port}  ${mode}`);
    });
  })
  .catch((error) => {
    logSystem({ source: "database", kind: "startup", message: "业务数据库初始化失败", error });
    console.error(error);
    process.exit(1);
  });
