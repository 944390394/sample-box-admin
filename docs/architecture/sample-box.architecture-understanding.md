# 智采 · 采样箱监测管理系统 — 当前状态架构理解

- 生成日期：2026-11-19；工作流：`system-modeler`（场景）+ `c4model`、`graphviz`（图源格式）
- 范围：**当前状态**（master 工作区代码 + 已核实的运行时事实）。2026-11-19 拍板的「调拨=批量划拨提交即生效、送检单独立 9 状态」是**目标态，尚未实现**，本文只在 §6 末尾标注，不混入现状模型。
- 读者：开发者 / 论文与汇报场景 / 新加入的协作者。
- 配套文件：
  - C4 图源：[sample-box.structurizr.dsl](./sample-box.structurizr.dsl)（上下文 / 容器 / 上行链路组件三个视图，用 Qoder 的 Structurizr DSL 查看器打开）
  - 单据生命周期图源：[task-lifecycle.dot](./task-lifecycle.dot)（Graphviz DOT 查看器打开）
  - 证据索引：[sample-box.evidence.md](./sample-box.evidence.md)（每条结论 → 文件:行号 → 置信度）

## 1. 这个系统在业务上做什么

对「智能采样箱」这种物联网资产做全生命周期管理：箱子（硬件）周期上报电量、箱盖开合、位置（GPS/基站）、开箱事件；平台据此维护箱子台账与在线状态，并承载三类业务单据——**采样单**（寄箱→采样→封箱→回程核验）、**调拨单**（单位间转移箱子归属，现状走物流式签收）、**送检测站**（签收后逐台开始检测）。集团→分公司→检测站/采样机构三级组织各自看到自己范围内的箱子、单据与总览。

角色与数据范围（`shared/org.js:61-72`，安装时种子化进 `sys_role`）：

| 层级 | 角色（code） | 数据范围 |
| --- | --- | --- |
| 集团 | 系统管理员 ADMIN、资产管理员 ASSET、核验员 VERIFY、值班员 DUTY、领导查看 LEADER | 全集团（dataScope 1） |
| 单位 | 分公司管理员 BRANCH_ADMIN、调度员 DISPATCH、机构负责人 AGENCY_LEAD | 本单位及下级（dataScope 2） |
| 个人 | 现场采样员 SAMPLER | 本人（dataScope 4） |
| 辅助 | 视角切换 HOME_SWITCH | 首页视角切换能力 |

权限是**权限码级 RBAC**：服务端 `menusFor(perms)` 按权限码出菜单（`server/menus.js:236`），前端按钮级用 `usePerm()` 查 `userInfo.perms`（`src/composables/usePerm.ts`）。单位还有权限上限（迁移 044 `sys_dept_perm`）。

## 2. 系统边界与容器（C4 L1/L2）

一个仓库、一台服务器、**一个 Node 进程**承载三个入口：

| 容器 | 技术 | 职责 | 关键证据 |
| --- | --- | --- | --- |
| Web 管理端 | Vue3 + Vite + TS + Element Plus（`src/`） | 箱子清单/详情、任务单、总览三页、实时地图、系统设置；**10–30s HTTP 轮询**刷新 | `src/views/sample/boxes/index.vue:593`（10s）、`screen/index.vue:298`（30s） |
| Node 后端 | 原生 `node:http` + `net` + `ws`，无 Web 框架（`server/`） | HTTP API :8000、设备 TCP :9000、WebSocket `/api/v1/sample/stream` 同进程 | `server/index.js:81`、`createSampleApp.js:59-66` |
| 业务数据库 | SQLite（`node:sqlite`，默认 `server/data/sample-box.db`）；配置可切 MySQL（mysql2 池） | 全部业务表 + 迁移 001–049 | `server/db.js:17-60` |
| 诊断日志库 | 独立 SQLite `system-logs.sqlite` | 系统/操作日志，与业务库分离 | `server/index.js:105-114` |

仓库内还有**设备固件**（`firmware/stm32l051-led` C 代码 + `firmware/dtu/sampling-task.lua` DTU 脚本），它是独立部署单元（烧录在硬件上），通过 TCP 与后端通信。

外部依赖：天地图（网页地图 + 服务端逆地理编码）、微信开放接口（小程序登录/手机号）、SMTP（可配）、**视频平台（未选型，通用 POST 适配器占位**，`VideoPlatform.js:1-30`）、Redis（可选，`REDIS_URL` 为空用进程内存缓存，`createSampleApp.js:42`）。

**微信小程序**是第二个客户端，代码在仓库外（`C:/Users/94439/WeChatProjects/miniprogram-1`），走同一套 `/api/v1/*` 与 `/auth/wechat/login`（服务端路由与 `WechatAuth` 是直接证据；小程序侧行为属运行时/记忆证据，中置信度）。

## 3. 后端内部结构（C4 L3，见 DSL UplinkPath 视图）

组装根 `server/src/createSampleApp.js`（注释自述：设备从 TCP 进、管理端从 HTTP 查、页面从 WebSocket 收）。分层清晰：

- **HTTP 层**：`index.js` 手写路由表（约 130 条，`index.js:207` 起）+ `matchRoute` 正则匹配（:1622）；业务控制器 `SampleController`（箱子）、`ReportPolicyController`（单据+策略，1471 行，含状态推进与 `#handOver` 归属转移 :1297）、`OverviewController`（总览聚合）；组织/用户/角色在 `org-api.js`。
- **鉴权**：自研 HMAC-SHA256 双令牌（access/refresh）+ `session_version` 失效机制 + scrypt 口令 + SVG 验证码（`server/auth.js`）。不是 JWT 库，是等价的紧凑签名格式。
- **设备接入**：`TcpIngestServer`（切帧、按箱会话串行下行）→ `IngestService`（**上报唯一入口**：IMEI 级串行锁 `ImeiGate`，箱子状态+原始报文**同事务**提交，成功后才进事件流；补传查重/确认也强制事务，`IngestService.js:75-88`）→ `SqlBoxStore`/`UplinkBatch` 落库 → `EventStream` 分发到状态缓存与 `RealtimeHub` → `SampleSocketServer` 推送。
- **下行通道**：上报策略版本化（`box_report_policy`），变更时经在线 TCP 会话主动推送（`createSampleApp.js:64` → `TcpIngestServer.pushPolicies`）；抹除指令附带在下行、设备确认后才删档（`IngestService.js:53-74`）。
- **单据状态机**：`shared/taskFlow.js` 是**前后端共用的唯一事实源**（步骤、终态、可推进状态 `nextOf`），服务端转发引用，页面进度条同源——这是本仓库最值得保持的架构约定。
- **可观测性**：`SystemLog` 独立库 + 操作审计 + 访问统计；`runtimeGuards.js` 拒绝调试后门上生产。
- **测试**：`server/test/` 45 个 `node --test` 文件，覆盖上行解析、TCP 接入、补传、任务流转、权限、迁移升级等（`pnpm test:server`）；另有 `tools/acceptance/` 分角色 UI 验收机器人。

## 4. 数据与状态（证据支撑的核心表）

业务：`sample_box`（箱子台账，life 状态跟随任务，迁移 031/037）、`sample_uplink`（原始报文流水）、`sample_task` / `sample_task_box` / `sample_task_log` / `sample_task_video`、`box_report_policy`、`box_ack` / `box_ack_gap` / `box_ack_lost`（补传确认）、`box_wipe_pending`（待抹除）、`box_dump_request/record`（板子日志）。
组织：`sys_user / sys_role / sys_dept / sys_user_role / sys_role_perm / sys_dept_perm / sys_user_wechat / sys_operation_log`。
迁移机制：`schema_migrations` 版本表 + 顺序执行 `server/migrations/001–049`（`db.js:72-89`），幂等可重跑。

## 5. 部署形态（运行时观察，非仓库 IaC）

- **生产**（2026-11-19 实测记录）：`sample.baiyuhub.top`，1Panel/nginx 托管前端静态产物（同源，`.env.production` `VITE_APP_BASE_API=''`），后端 systemd 单元 `sample-box-admin`（node v22，`/opt/sample-box-admin`），PORT=8000 / SAMPLE_TCP_PORT=9000，SQLite。部署走 `.alignment/deploy-*.sh` 门禁脚本（备份、md5 核对、迁移 dry-run、健康探针、失败回滚）。
- **本地开发**：前端 3000（vite proxy `/dev-api` → `localhost:8000`，`vite.config.ts:44-52`），后端 8000/9000；演示实例 8002 独立库。
- 根目录 `deploy.mjs`（rsync 到 www.youlai.tech）是 **vue3-element-admin 模板遗留**，不是本项目的实际部署通道。
- `mock/` 仅在 `VITE_MOCK_DEV_SERVER=true` 时启用，当前 `.env.development:14` 为 false——前端连真实后端。

## 6. 单据生命周期（见 task-lifecycle.dot）

现状（`shared/taskFlow.js` 直接证据）：采样单单向 6 步 / 双向 8 步；调拨单 direct 免物流「建单→待签收→已签收（签收时 `#handOver` 转移归属）」，拒收可走「退回中→已退回」；签收方为检测站时签收后进入「待检测→已检测」（逐台开始检测）。终态：已完成/已签收/已检测（正常），已取消/已拒收/已退回（作废）；采样单待核验拒收=样品作废（开箱超限场景）。

**目标态提示（未实现，勿当现状）**：2026-11-19 用户已拍板调拨改为「批量划拨、提交即生效、整单禁撤」、送检独立成 9 状态送检单（IN-）、划拨单 AL- 仅两态。这是服务端流程级变更（归属转移要从签收挪到建单提交），详见项目记忆 `samplebox-task-domain-ia-decisions.md`。

## 7. 未知与待验证（模型中已用虚线/标注降级）

| # | 未知项 | 现状证据 | 验证步骤 |
| --- | --- | --- | --- |
| 1 | WebSocket `/api/v1/sample/stream` 的实际消费者 | 服务端完整实现；Web `src/` 全文无 WebSocket 客户端，页面全靠轮询 | 在小程序仓库 grep `sample/stream`；或生产 `journalctl` 看 WS 连接来源 |
| 2 | 生产是否启用 Redis | 代码支持可选；生产 env 未核实 | 查生产 systemd 单元的 `REDIS_URL` |
| 3 | 视频平台对接 | 适配器占位、状态「平台未接入」 | 选型后仅改 `VideoPlatform.js` |
| 4 | 告警/指令中心页面 | `views/sample/alerts`、`commands` 页面存在，但 API `reserved:true` 返回「接口已预留，表尚未创建」（`index.js:972-973,1726`） | 属半成品功能，勿在汇报中当已交付能力 |
| 5 | 小程序端内部结构 | 仓库外，未纳入本模型 | 需要时单独建模 |

## 8. 阅读顺序建议

1. 本文 §1–§2 建立业务与边界概念 → 2. DSL 的 SystemContext / Containers 视图 → 3. §3 + UplinkPath 组件视图理解设备链路 → 4. task-lifecycle.dot 理解单据域 → 5. 改动前查 evidence.md 对应文件的行号。
