/**
 * 系统设置「只写不回显」密钥字段的已配置标识（hasKey/hasSecret/hasPassword/hasToken/hasAppSecret/hasDbPassword）。
 * 口径：有值→true、空→false；标识只是布尔，公开对象里不出现秘密明文。
 * 老的 passwordSet/tokenSet/appSecretSet 保留兼容，新 has* 键与它们同值。
 * publicSecurity（密码策略数值）与 readBranding（名称/标语/图标）没有只写字段，不加标识——形状守卫钉死。
 * GET /system/settings 的接线按本库惯例做源码断言（同 operation-log-export.test.js）：
 * map 载荷带 hasKey/hasSecret，sk 本体仍只给有 sys:settings:map 的人。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import { mergeMapSettings, publicMap } from "../src/settings/mapConfig.js";
import {
  mergeSmtpSettings,
  mergeVideoSettings,
  mergeWechatSettings,
  publicSmtp,
  publicVideo,
  publicWechat,
} from "../src/settings/integrationConfig.js";
import { mergeDatabaseSettings, publicDatabase } from "../src/settings/databaseConfig.js";
import { publicSecurity } from "../src/settings/securityConfig.js";
import { readBranding } from "../src/settings/brandingConfig.js";

const TK = "tk-accept-0123456789abcdef";
const SK = "sk-accept-fedcba9876543210";
const SMTP_PASS = "smtp-pass-accept";
const VIDEO_TOKEN = "video-token-accept";
const APP_SECRET = "0123456789abcdef0123456789abcdef";
const DB_PASS = "db-pass-accept";

test("地图密钥标识：有值→true、空→false；tk 可清空、sk 留空不改", () => {
  const empty = publicMap({});
  assert.equal(empty.hasKey, false);
  assert.equal(empty.hasSecret, false);
  assert.equal(publicMap(null).hasKey, false);
  assert.equal(publicMap({ tianditu: { tk: "", sk: "" } }).hasSecret, false);

  const saved = mergeMapSettings({}, { tk: TK, sk: SK });
  const visible = publicMap(saved);
  assert.equal(visible.hasKey, true);
  assert.equal(visible.hasSecret, true);
  // tk/sk 本体下发是既有契约（大屏瓦片要用），标识不改变它
  assert.equal(visible.tk, TK);
  assert.equal(visible.sk, SK);

  // 只配 tk：hasKey=true、hasSecret=false
  const tkOnly = publicMap(mergeMapSettings({}, { tk: TK }));
  assert.equal(tkOnly.hasKey, true);
  assert.equal(tkOnly.hasSecret, false);

  // 留空保存：sk 不改（标识保持 true），tk 清空（标识翻 false）
  const kept = mergeMapSettings(saved, { tk: "", sk: "" });
  assert.equal(kept.tianditu.sk, SK);
  const after = publicMap(kept);
  assert.equal(after.hasKey, false);
  assert.equal(after.hasSecret, true);
});

test("SMTP 密码标识：hasPassword 与 passwordSet 同值，公开对象不含密码明文", () => {
  const saved = mergeSmtpSettings(
    {},
    { enabled: true, host: "smtp.example.com", port: 465, password: SMTP_PASS }
  );
  const visible = publicSmtp(saved);
  assert.equal(visible.hasPassword, true);
  assert.equal(visible.passwordSet, true);
  assert.equal(Object.hasOwn(visible, "password"), false);
  assert.equal(JSON.stringify(visible).includes(SMTP_PASS), false);

  const empty = publicSmtp({});
  assert.equal(empty.hasPassword, false);
  assert.equal(empty.passwordSet, false);
  // 留空不改：密码还在，标识仍 true
  const kept = mergeSmtpSettings(saved, { host: "smtp.example.com", port: 465, password: "" });
  assert.equal(publicSmtp(kept).hasPassword, true);
});

test("视频平台令牌标识：hasToken 与 tokenSet 同值，公开对象不含令牌明文", () => {
  const saved = mergeVideoSettings(
    {},
    { enabled: true, url: "https://video.example/api", token: VIDEO_TOKEN, timeoutMs: 8000 }
  );
  const visible = publicVideo(saved);
  assert.equal(visible.hasToken, true);
  assert.equal(visible.tokenSet, true);
  assert.equal(Object.hasOwn(visible, "token"), false);
  assert.equal(JSON.stringify(visible).includes(VIDEO_TOKEN), false);

  const empty = publicVideo({});
  assert.equal(empty.hasToken, false);
  assert.equal(empty.tokenSet, false);
  const kept = mergeVideoSettings(saved, {
    enabled: true,
    url: "https://video.example/api",
    token: "",
    timeoutMs: 8000,
  });
  assert.equal(publicVideo(kept).hasToken, true);
});

test("微信 AppSecret 标识：hasAppSecret 与 appSecretSet 同值，公开对象不含秘密明文", () => {
  const saved = mergeWechatSettings({}, { appId: "wx76dc414b9199c3bf", appSecret: APP_SECRET });
  const visible = publicWechat(saved);
  assert.equal(visible.hasAppSecret, true);
  assert.equal(visible.appSecretSet, true);
  assert.equal(Object.hasOwn(visible, "appSecret"), false);
  assert.equal(JSON.stringify(visible).includes(APP_SECRET), false);

  const empty = publicWechat({});
  assert.equal(empty.hasAppSecret, false);
  assert.equal(empty.appSecretSet, false);
  const kept = mergeWechatSettings(saved, { appId: "wx76dc414b9199c3bf", appSecret: "" });
  assert.equal(publicWechat(kept).hasAppSecret, true);
});

test("数据库密码标识：hasDbPassword 与 passwordSet 同值，公开对象不含密码明文", () => {
  const saved = mergeDatabaseSettings(
    { dialect: "sqlite" },
    { host: "db.internal", port: 3306, database: "sample_box", user: "box", password: DB_PASS }
  );
  const visible = publicDatabase(saved);
  assert.equal(visible.hasDbPassword, true);
  assert.equal(visible.passwordSet, true);
  assert.equal(Object.hasOwn(visible, "password"), false);
  assert.equal(JSON.stringify(visible).includes(DB_PASS), false);

  const sqlite = publicDatabase({ dialect: "sqlite" });
  assert.equal(sqlite.hasDbPassword, false);
  assert.equal(sqlite.passwordSet, false);
  // MySQL 没填密码（历史配置）：标识 false
  const noPass = publicDatabase({
    dialect: "mysql",
    host: "db.internal",
    database: "sample_box",
    password: "",
  });
  assert.equal(noPass.hasDbPassword, false);
});

test("GET /system/settings 接线：map 载荷带标识，sk 本体仍按权限给；无权限者响应不含 sk 明文", async () => {
  const routes = await readFile(new URL("../index.js", import.meta.url), "utf8");
  const block = routes.match(/async function systemSettings\(ctx\) \{[\s\S]*?\n\}/);
  assert.ok(block, "systemSettings 处理函数要在");
  assert.match(block[0], /hasKey: map\.hasKey/);
  assert.match(block[0], /hasSecret: map\.hasSecret/);
  assert.match(block[0], /sk: can\.map \? map\.sk : ""/);

  // 按源码同款接线复刻载荷：有 map 权限拿到 sk 本体；没有的人只拿标识，JSON 里不含 sk 明文
  const map = publicMap(mergeMapSettings({}, { tk: TK, sk: SK }));
  const payload = (canMap) => ({
    tk: map.tk,
    sk: canMap ? map.sk : "",
    hasKey: map.hasKey,
    hasSecret: map.hasSecret,
  });
  const viewer = payload(false);
  assert.equal(viewer.sk, "");
  assert.equal(viewer.hasSecret, true);
  assert.equal(JSON.stringify(viewer).includes(SK), false);
  const editor = payload(true);
  assert.equal(editor.sk, SK);
  assert.equal(editor.hasSecret, true);
});

test("形状守卫：密码策略与品牌公开对象没有只写秘密字段，无需标识", () => {
  const security = publicSecurity({
    security: { minLength: 10, classes: ["letter", "digit", "symbol"], expireDays: 90 },
  });
  assert.deepEqual(Object.keys(security).sort(), [
    "classes",
    "expireDays",
    "lockMinutes",
    "lockThreshold",
    "minLength",
  ]);
  const branding = readBranding({ branding: { title: "智采", slogan: "", logo: "" } });
  assert.deepEqual(Object.keys(branding).sort(), ["logo", "slogan", "title"]);
});
