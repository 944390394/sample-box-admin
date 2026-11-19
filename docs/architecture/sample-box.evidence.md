# 架构证据索引（2026-11-19，master 工作区）

置信度：high=代码/配置直接证据；medium=多方部分证据或运行时记录；low/unknown=推断，待验证。
所有路径相对仓库根 `E:\Dev\Projects\sample-box-admin`。

## 节点证据

| 节点 | 证据 | 置信度 |
| --- | --- | --- |
| Web 管理端（Vue3+Vite+Element Plus） | `package.json`（vue3-element-admin 模板基座）；`src/views/sample/{boxes,tasks,overview,screen,home,alerts,assign,assistant,commands,serial}`；`.env.development:4` 标题「智采 · 采样箱」 | high |
| Node 后端单进程（HTTP :8000） | `server/index.js:81`（PORT 默认 8000）、`:207` 路由表、`:1622` matchRoute、`:1661` 分发 | high |
| 设备 TCP 接入 :9000 | `server/src/createSampleApp.js:59-63`（SAMPLE_TCP_PORT 默认 9000）；`server/src/transport/TcpIngestServer.js:8-27` | high |
| WebSocket 服务 | `server/src/transport/SampleSocketServer.js:20`（path=/api/v1/sample/stream）、`:22-24`（token 鉴权） | high |
| WS 消费者=小程序 | Web `src/` 全文 grep 无 WebSocket 客户端；`src/main.ts:29` 注明模板 SSE 已停用；小程序在仓库外（项目记忆） | low（inferred） |
| 业务数据库 SQLite/MySQL 双支持 | `server/db.js:17-51`（mysql2）、`:53-60`（node:sqlite，默认 server/data/sample-box.db）；`createSampleApp.js:89-99`（MysqlPool 或安装向导连接） | high |
| 迁移机制 001–049 | `server/db.js:72-89`；`server/migrations/` 目录（001_org … 049_timer_event_kinds） | high |
| 诊断日志独立库 | `server/index.js:105-114`（system-logs.sqlite，SYSTEM_LOG_PATH 可覆盖） | high |
| 状态缓存（内存/Redis 可选） | `createSampleApp.js:42`（REDIS_URL 为空走内存）；`server/src/cache/{MemoryStateCache,RedisStateCache,StateCache}.js` | high |
| 采样箱固件 | `firmware/stm32l051-led/`（C，board.h 自述 STM32L051）；`firmware/dtu/sampling-task.lua`（DTU Lua，含离线补传/低功耗测试 test-sampling.lua） | high |
| 微信小程序客户端 | `server/index.js:241-291`（/auth/wechat/login、bind、phone、profile 路由）；`server/src/auth/WechatAuth.js`；小程序路径见项目记忆（运行时记录） | medium |
| 天地图依赖 | `index.html:6-7`（preconnect api.tianditu.gov.cn）；`src/components/TiandituMap/`；`server/src/geo/TiandituGeocoder.js`（createSampleApp.js:57 注入 tk/sk） | high |
| 微信开放接口依赖 | `server/src/integration/WechatMini.js:33,57,84`（jscode2session / getuserphonenumber / stable_token） | high |
| SMTP 依赖 | `server/src/integration/Mailer.js`；`server/index.js:886-899`（settings/smtp + test） | high |
| 视频平台占位 | `server/src/integration/VideoPlatform.js:1-30`（「平台还没定…未启用记平台未接入」） | high（占位事实）；对接=unknown |
| 生产部署形态 | 运行时记录（项目记忆 samplebox-local-env-and-mp-automation.md：sample.baiyuhub.top、systemd、1Panel、node v22）；`issue-token.tmp.mjs:4-6`（/opt/sample-box-admin + db.config.json + sqlite） | medium（runtime） |
| deploy.mjs 为模板遗留 | `deploy.mjs:16-19`（www.youlai.tech / /mnt/nginx/html/vue，模板默认值）；实际部署走 .alignment/deploy-*.sh（运行时记录） | medium |

## 关系/行为证据

| 关系 | 证据 | 置信度 |
| --- | --- | --- |
| 前端 → 后端 HTTP（开发代理） | `vite.config.ts:44-52`（/dev-api → VITE_APP_API_URL）；`.env.development:6,9`；`src/utils/request.ts:38`（baseURL） | high |
| 生产同源 | `.env.production:2`（VITE_APP_BASE_API=''） | high |
| 前端轮询而非 WS | `src/views/sample/boxes/index.vue:593`（10s）、`screen/index.vue:298`（30s）、`home/index.vue:501`（30s） | high |
| 鉴权：HMAC 双令牌 + session_version + scrypt + 验证码 | `server/auth.js:5-18`（scrypt）、`:20-43`（signToken/readToken）、`:46-59`（sessionMatches）、`:61-75`（captcha） | high |
| RBAC 权限码 + 数据范围 | `shared/org.js:61-72`（10 角色 + dataScope）；`server/menus.js:236`（menusFor(perms)）；`src/composables/usePerm.ts`；`server/src/auth/{boxAccess,permCatalog}.js`；迁移 029/039/043/044/045 | high |
| 上报唯一入口 + IMEI 串行 + 事务提交 | `server/src/service/IngestService.js:5-9`（自述）、`:41-90`（gate.run、commitQueuedUplink 强制事务） | high |
| 提交后事件流 → 缓存 + 推送 | `IngestService.js:34-38`（events.subscribe → cache.put / hub.publish） | high |
| 策略变更主动下行 | `createSampleApp.js:64`（onPolicyChanged → tcp.pushPolicies）；`TcpIngestServer.js:44-61` | high |
| 抹除：下行附指令、确认后删档 | `IngestService.js:53-74`（wipeLine / removeWiped / finishWipe）；迁移 018_box_wipe | high |
| 单据状态机前后端同源 | `shared/taskFlow.js:1-92`（自述唯一一份；server/src/settings/taskFlow.js 转发）；`ReportPolicyController.js:50`（import nextOf/signTargetOf/stepsOf）、`:796`（nextOf 校验） | high |
| 调拨签收转移归属（现状） | `ReportPolicyController.js:1297-1308`（#handOver + handOverSkipped 日志） | high |
| 检测站分支：待检测→已检测 | `shared/taskFlow.js:14-16,39-40,62-65`；`server/index.js:688`（/tasks/:id/boxes/:boxId/inspect）；迁移 041/042 | high |
| 采样拒收=样品作废 | `shared/taskFlow.js:73-75`（注释：待核验拒收即样品作废，比如开箱超限） | high |
| 核心表清单 | `server/migrations/*.js` grep CREATE TABLE：sample_box(_seq)、sample_uplink、sample_task(_box/_log/_video)、box_report_policy、box_ack(_gap/_lost)、box_report_delivery、box_dump_request/record、box_wipe_pending、box_active_task、sys_* | high |
| 告警/指令 API 预留 | `server/index.js:972-973`（reserved:true）、`:1726`（「接口已预留，表尚未创建」） | high |
| mock 关闭 | `vite.config.ts:58`（条件启用）；`.env.development:14`（false） | high |
| 测试资产 | `server/test/`（45 个 *.test.js，node --test）；`package.json` test:server / accept；`tools/acceptance/checks.mjs`（分角色 UI 验收） | high |

## 明确排除 / 降级项

- `.claude/worktrees/` 下同名文件是历史工作树副本，**不作为证据**（检索时曾混入，已剔除）。
- 「调拨=批量划拨提交即生效 / 送检单 9 状态 / 离线 1h 宽限」＝2026-11-19 用户决策（项目记忆），**目标态**，代码仍为旧流程（#handOver 在签收时转移归属为直接反证）。
- 生产 Redis 是否启用、WS 实际消费者、视频平台选型：unknown，见理解文档 §7 验证步骤。
