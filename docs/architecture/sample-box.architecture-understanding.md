# 智采 · 采样箱监测管理系统 — 当前状态架构理解

- 生成日期：2026-11-19；口径更新：2026-11-20（组织简化 B1–B4a 落地后重写 §1/§6 等业务口径；工作流 `system-modeler` + `c4model`、`graphviz`）
- 范围：**当前状态**（master 工作区代码 + 已核实的运行时事实）。2026-11-19 拍板的「调拨=批量划拨提交即生效」与 2026-11-20 组织简化（三界面/无机构层/唯一检测站/采样＋送检合并一张单）均**已实现**（服务端 B1a/b/c、网页 B2、小程序 B3、夹具/文档 B4a；单测 290 绿）。
- 读者：开发者 / 论文与汇报场景 / 新加入的协作者。
- 配套文件：
  - C4 图源：[sample-box.structurizr.dsl](./sample-box.structurizr.dsl)（上下文 / 容器 / 上行链路组件三个视图，用 Qoder 的 Structurizr DSL 查看器打开；**图源未随组织简化重绘，单据域以本文 §6 与 task-lifecycle.dot 为准**）
  - 单据生命周期图源：[task-lifecycle.dot](./task-lifecycle.dot)（Graphviz DOT 查看器打开；合并流口径见 §6）
  - 证据索引：[sample-box.evidence.md](./sample-box.evidence.md)（每条结论 → 文件:行号 → 置信度；行号随 B1–B4 漂移，引用前复核）

## 1. 这个系统在业务上做什么

对「智能采样箱」这种物联网资产做全生命周期管理：箱子（硬件）周期上报电量、箱盖开合、位置（GPS/基站）、开箱事件；平台据此维护箱子台账与在线状态，并承载两类新建业务单据——**合并采样单 TK-**（分公司自采：待采样→采样中→已封箱→在途→待签收→待检测→已检测，采样＋送检一张单，接收方固定唯一检测站；分支 已取消/已拒收/退回中→已退回）与**划拨单 AL-**（单位间转移箱子归属，提交即生效、整单禁撤守卫，只有 已划拨/已撤销 两态）。旧 kind 调拨/送检只读保留（历史进度条仍渲染、在途旧单仍能收尾，不再新建；056 已把存量送检映射进合并口径）。

组织是**三界面**（录音①）：总部只查看、分公司自采、总公司下**唯一检测站**独立接收。**无采样机构层**（录音②）：部门类型只有「公司」「检测站」；分公司（公司类型）就是采样单位。检测站全局唯一且属总公司子树（配置 `box.stationDeptId`＋服务端 `resolveStation` 回退认定）。摄像头在分公司采样现场，检测站不设（录音⑥）。集团→分公司→检测站各自看到自己范围内的箱子、单据与总览（检测站四数＋今日：在途/累计已到站/累计已开箱/当前未开箱＋今日已开箱）。

角色与数据范围（`shared/org.js`，安装时种子化进 `sys_role`）：

| 层级 | 角色（code） | 数据范围 |
| --- | --- | --- |
| 集团 | 系统管理员 ADMIN、资产管理员 ASSET、核验员 VERIFY、值班员 DUTY、领导查看 LEADER | 全集团（dataScope 1） |
| 单位 | 分公司管理员 BRANCH_ADMIN、调度员 DISPATCH（分公司内部调度岗，P1） | 本单位及下级（dataScope 2） |
| 个人 | 现场采样员 SAMPLER | 本人（dataScope 4） |
| 辅助 | 视角切换 HOME_SWITCH | 首页视角切换能力 |

组织简化（P3）：**AGENCY_LEAD（机构负责人，种子 id14）废弃**——存量持有者由迁移 056 改绑 BRANCH_ADMIN，sys_role 14 停用不物理删；DEFAULT_ROLE_PERMS/ROLE_TEMPLATES 不再含该项。BRANCH_ADMIN/DISPATCH 默认码补 `task:create:sample`（分公司自采建单是主路径，B4a；存量库 056 幂等补码）。

权限是**权限码级 RBAC**：服务端 `menusFor(perms)` 按权限码出菜单（`server/menus.js`），前端按钮级用 `usePerm()` 查 `userInfo.perms`（`src/composables/usePerm.ts`）。单位还有权限上限（迁移 044 `sys_dept_perm`）。角色页菜单预览 `menuPreviewFor` 镜像前端 local-menus（组织简化后只剩调拨单组；送检单退役，B4a）。

## 2. 系统边界与容器（C4 L1/L2）

一个仓库、一台服务器、**一个 Node 进程**承载三个入口：

| 容器 | 技术 | 职责 | 关键证据 |
| --- | --- | --- | --- |
| Web 管理端 | Vue3 + Vite + TS + Element Plus（`src/`） | 箱子清单/详情、任务单、总览三页、实时地图、系统设置；**10–30s HTTP 轮询**刷新 | `src/views/sample/boxes/index.vue:593`（10s）、`screen/index.vue:298`（30s） |
| Node 后端 | 原生 `node:http` + `net` + `ws`，无 Web 框架（`server/`） | HTTP API :8000、设备 TCP :9000、WebSocket `/api/v1/sample/stream` 同进程 | `server/index.js:81`、`createSampleApp.js:59-66` |
| 业务数据库 | SQLite（`node:sqlite`，默认 `server/data/sample-box.db`）；配置可切 MySQL（mysql2 池） | 全部业务表 + 迁移 001–049 | `server/db.js:17-60` |
| 诊断日志库 | 独立 SQLite `system-logs.sqlite` | 系统/操作日志，与业务库分离 | `server/index.js:105-114` |

仓库内还有**设备固件**（`firmware/stm32l051-led` C 代码 + `firmware/dtu/sampling-task.lua` DTU 脚本），它是独立部署单元（烧录在硬件上），通过 TCP 与后端通信。

外部依赖：天地图（网页地图 + 服务端逆地理编码）、微信开放接口（小程序登录/手机号）、SMTP（可配）、**视频平台（未选型，通用 POST 适配器占位**，`VideoPlatform.js`；组织简化后摄像头/录像只在**分公司采样现场**，检测站不设）、Redis（可选，`REDIS_URL` 为空用进程内存缓存，`createSampleApp.js:42`）。

**微信小程序**是第二个客户端，代码在仓库外（`C:/Users/94439/WeChatProjects/miniprogram-1`），走同一套 `/api/v1/*` 与 `/auth/wechat/login`（服务端路由与 `WechatAuth` 是直接证据；小程序侧行为属运行时/记忆证据，中置信度）。

## 3. 后端内部结构（C4 L3，见 DSL UplinkPath 视图）

组装根 `server/src/createSampleApp.js`（注释自述：设备从 TCP 进、管理端从 HTTP 查、页面从 WebSocket 收）。分层清晰：

- **HTTP 层**：`index.js` 手写路由表（约 130 条，`index.js:207` 起）+ `matchRoute` 正则匹配（:1622）；业务控制器 `SampleController`（箱子）、`ReportPolicyController`（单据+策略，1471 行，含状态推进与 `#handOver` 归属转移 :1297）、`OverviewController`（总览聚合）；组织/用户/角色在 `org-api.js`。
- **鉴权**：自研 HMAC-SHA256 双令牌（access/refresh）+ `session_version` 失效机制 + scrypt 口令 + SVG 验证码（`server/auth.js`）。不是 JWT 库，是等价的紧凑签名格式。
- **设备接入**：`TcpIngestServer`（切帧、按箱会话串行下行）→ `IngestService`（**上报唯一入口**：IMEI 级串行锁 `ImeiGate`，箱子状态+原始报文**同事务**提交，成功后才进事件流；补传查重/确认也强制事务，`IngestService.js:75-88`）→ `SqlBoxStore`/`UplinkBatch` 落库 → `EventStream` 分发到状态缓存与 `RealtimeHub` → `SampleSocketServer` 推送。
- **下行通道**：上报策略版本化（`box_report_policy`），变更时经在线 TCP 会话主动推送（`createSampleApp.js:64` → `TcpIngestServer.pushPolicies`）；抹除指令附带在下行、设备确认后才删档（`IngestService.js:53-74`）。
- **单据状态机**：`shared/taskFlow.js` 是**前后端共用的唯一事实源**（步骤、终态、可推进状态 `nextOf`），服务端转发引用，页面进度条同源——这是本仓库最值得保持的架构约定。
- **可观测性**：`SystemLog` 独立库 + 操作审计 + 访问统计；`runtimeGuards.js` 拒绝调试后门上生产。
- **测试**：`server/test/` 60+ 个 `node --test` 文件（290 测试全绿，组织简化 B4a 基线），覆盖上行解析、TCP 接入、补传、合并任务流转、权限、迁移升级、总览四数等（`pnpm test:server`）；另有 `tools/acceptance/` 分角色 UI 验收机器人与 `tools/acceptance-setup.mjs` 隔离夹具（8010/9010）。

## 4. 数据与状态（证据支撑的核心表）

业务：`sample_box`（箱子台账，life 状态跟随任务，迁移 031/037）、`sample_uplink`（原始报文流水）、`sample_task` / `sample_task_box` / `sample_task_log` / `sample_task_video`、`box_report_policy`、`box_ack` / `box_ack_gap` / `box_ack_lost`（补传确认）、`box_wipe_pending`（待抹除）、`box_dump_request/record`（板子日志）。
组织：`sys_user / sys_role / sys_dept / sys_user_role / sys_role_perm / sys_dept_perm / sys_user_wechat / sys_operation_log`。
迁移机制：`schema_migrations` 版本表 + 顺序执行 `server/migrations/001–056`（`db.js`），幂等可重跑。056_org_simplify：类型归一（采样机构→公司/唯一检测站）＋角色合并（AGENCY_LEAD→BRANCH_ADMIN、14 停用）＋BRANCH_ADMIN/DISPATCH 补 task:create:sample＋P7 存量送检/旧采样映射落库＋备份表 `_bak_org_simplify_*`。

## 5. 部署形态（运行时观察，非仓库 IaC）

- **生产**（2026-11-19 实测记录）：`sample.baiyuhub.top`，1Panel/nginx 托管前端静态产物（同源，`.env.production` `VITE_APP_BASE_API=''`），后端 systemd 单元 `sample-box-admin`（node v22，`/opt/sample-box-admin`），PORT=8000 / SAMPLE_TCP_PORT=9000，SQLite。部署走 `.alignment/deploy-*.sh` 门禁脚本（备份、md5 核对、迁移 dry-run、健康探针、失败回滚）。
- **本地开发**：前端 3000（vite proxy `/dev-api` → `localhost:8000`，`vite.config.ts:44-52`），后端 8000/9000；演示实例 8002 独立库。
- 根目录 `deploy.mjs`（rsync 到 www.youlai.tech）是 **vue3-element-admin 模板遗留**，不是本项目的实际部署通道。
- `mock/` 仅在 `VITE_MOCK_DEV_SERVER=true` 时启用，当前 `.env.development:14` 为 false——前端连真实后端。

## 6. 单据生命周期（见 task-lifecycle.dot；图源待随合并流重绘，以下文字为准）

现状（`shared/taskFlow.js` 直接证据，组织简化 B1a/P6 后）：

- **合并采样单 TK-**（新建一律走这里）：主路径 7 步 待采样→采样中→已封箱→在途→待签收→待检测→已检测（终态 OK）。
  分公司自采（采样单位＝寄出分公司），封箱后直寄唯一检测站；签收后逐台扫码「开始检测」，全部开始检测后整单已检测。
  分支：已取消（待签收前）、已拒收（签收时）、退回中→已退回（待检测/已检测可退，回原寄出分公司 fromOrg，D3）。
  接收方服务端强制 `toOrgId=stationDeptId`（P10，总部/分公司不可作接收方）；trip 单向/双向作废（新建忽略）。
- **划拨单 AL-**：提交即生效（归属在建单同一事务转移），只有 已划拨/已撤销 两态，无物流步骤，只能走撤销端点；
  整单禁撤守卫（已进入任务/划拨后已开箱/已完成检测三类原因）；目标限 type=公司（P8，总部可作目标＝收回未分配）。
- **只读保留的旧 kind**：送检 IN-（9 状态）、调拨（direct/物流式）、旧采样（带 trip）——历史进度条仍渲染、在途旧单仍能收尾，不再新建。
  056 已把存量送检映射进合并口径（待寄出→已封箱、运送中→在途、其余同名；旧采样 待核验→待检测、已签收/已完成→已检测），
  保留原 id/IN- 前缀作历史事实；映射前原 kind/status/body 整表备份进 `_bak_org_simplify_task`。
- 终态：已检测/已划拨（正常 OK），已取消/已拒收/已退回/已撤销（作废 VOID）；旧单 已完成/已签收 只读保留。
- 签收方为检测站的单（`is_inspect`/body.inspect）：签收后先到「待检测」，逐台开始检测；开箱超限样品作废（强制签收后也不能检测）。

决策与契约出处：`reports/plan-org-simplify.md`（P1–P13）、`org-b1a-report.md`（合并状态机）、`org-b1b-report.md` §3（四数/resolveStation）、`org-b1c-report.md` §4（P7 映射表/幂等论证）。

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
