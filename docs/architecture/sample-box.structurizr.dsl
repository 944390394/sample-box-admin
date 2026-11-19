// 智采 · 采样箱监测管理系统 — 当前状态架构模型（C4）
// 生成：2026-11-19，system-modeler + c4model；证据索引见 sample-box.evidence.md
// 仅描述现状；「调拨=批量划拨、送检单独立」等 2026-11-19 业务决策是目标态，未画入本模型。
workspace "智采 · 采样箱监测管理系统" "采样箱台账、遥测监测、采样/调拨/送检单据流转与集团总览（当前状态）" {

    model {
        admin = person "集团级用户" "系统管理员 / 资产管理员 / 核验员 / 值班员 / 领导查看（数据范围：全集团）"
        branch = person "分公司 / 机构用户" "分公司管理员 / 调度员 / 机构负责人（数据范围：本单位及下级）"
        sampler = person "现场采样员" "采样员（数据范围：本人）"

        sampleBox = softwareSystem "智采 · 采样箱监测管理系统" "采样箱资产与遥测监测、采样/调拨/送检单据、集团/分公司/检测站总览、系统管理" {
            web = container "Web 管理端" "箱子清单/详情、任务单、总览三页、实时地图、系统设置；10–30 秒 HTTP 轮询刷新" "Vue 3 + Vite + TypeScript + Element Plus（src/）"
            backend = container "Node 后端（单进程）" "HTTP API（默认 :8000）+ 设备 TCP 接入（默认 :9000）+ WebSocket 推送，同一进程" "Node.js 原生 http/net + ws，ESM（server/）" {
                httpApi = component "HTTP 路由与鉴权" "手写路由表匹配；HMAC-SHA256 令牌 + scrypt 口令 + 验证码 + session_version；RBAC 权限码与数据范围" "server/index.js:207,1622; server/auth.js"
                orgApi = component "组织 / 用户 / 角色 API" "部门树、用户、角色、权限点授予、单位权限上限" "server/org-api.js; server/src/auth/"
                sampleCtrl = component "箱子 / 上报记录 API" "箱子 CRUD、激活/禁用/划拨、轨迹、电量、上报原文导出" "server/src/http/SampleController.js"
                taskCtrl = component "单据 / 上报策略 API" "任务单建单与状态推进（nextOf 校验）、签收归属转移 #handOver、检测站开始检测、上报策略下发" "server/src/http/ReportPolicyController.js:796,1297"
                overviewCtrl = component "总览聚合 API" "集团/分公司/检测站三页单遍聚合 + 服务端分页" "server/src/http/OverviewController.js"
                tcp = component "设备 TCP 接入" "监听 :9000（SAMPLE_TCP_PORT），JSON 切帧；按箱会话串行下行" "server/src/transport/TcpIngestServer.js"
                ingest = component "上报处理服务" "设备上报唯一入口：IMEI 级串行，箱子状态 + 原始报文同事务提交，成功后进事件流" "server/src/service/IngestService.js:41-90"
                store = component "箱子 / 报文存储" "SqlBoxStore + UplinkBatch：sample_box、sample_uplink、补传事务入库 commitQueuedUplink" "server/src/store/"
                policy = component "上报策略" "box_report_policy 版本化策略；变更时经 TCP 会话主动下行推送" "server/src/settings/ReportPolicy.js; createSampleApp.js:64"
                commands = component "设备指令 / 抹除" "待抹除下行附指令、设备确认后删档重建；板子日志 dump 回收" "server/src/settings/DeviceCommands.js; IngestService.js:56-74"
                queue = component "补传队列确认" "离线补传记录查重、入库、累计确认同一事务（box_ack*）" "server/src/settings/QueueAck.js"
                cache = component "最新状态缓存" "REDIS_URL 为空时内存缓存，否则 Redis" "server/src/cache/; createSampleApp.js:42"
                hub = component "实时事件分发" "EventStream 提交后发布 → 缓存写入 + RealtimeHub 广播" "server/src/transport/RealtimeHub.js; IngestService.js:34-38"
                ws = component "WebSocket 服务" "路径 /api/v1/sample/stream，token 鉴权；Web 端 src/ 未发现消费者（疑似小程序使用，未验证）" "server/src/transport/SampleSocketServer.js:20-24" "unverified-consumer"
                syslog = component "诊断 / 操作日志" "SystemLog 独立 SQLite；操作审计、访问统计" "server/src/log/; server/index.js:105-114"
                integrations = component "外部集成适配" "WechatMini（微信登录/手机号）、Mailer（SMTP）、VideoPlatform（通用 POST 占位）、TiandituGeocoder（逆地理编码）" "server/src/integration/; server/src/geo/"
            }
            db = container "业务数据库" "sample_box / sample_uplink / sample_task(_box/_log/_video) / box_report_policy / box_ack* / box_wipe_pending / sys_*；迁移 001–049" "SQLite（node:sqlite，默认）；可切 MySQL（mysql2 连接池）" "database"
            logDb = container "诊断日志库" "system-logs.sqlite，与业务库分离" "SQLite" "database"
        }

        firmware = softwareSystem "采样箱固件" "STM32L051 遥测（电量/箱盖/开箱）+ M100MG-C2 DTU Lua 脚本：周期 TCP JSON 上报、离线补传、低功耗休眠" "embedded"
        mini = softwareSystem "微信小程序" "移动端采样/扫码/签收客户端；仓库外（WeChatProjects/miniprogram-1），走同一套 HTTP API 与微信登录" "external,medium-confidence"
        tianditu = softwareSystem "天地图开放平台" "网页地图 JS API + 服务端逆地理编码" "external"
        wechatApi = softwareSystem "微信开放接口" "jscode2session / 获取手机号 / stable_token" "external"
        smtp = softwareSystem "SMTP 邮件服务" "系统邮件发送（系统设置可配）" "external"
        video = softwareSystem "视频平台（未定）" "开箱录像请求：通用 POST + Bearer 适配器占位，未接入时记「平台未接入」" "external,placeholder"
        redis = softwareSystem "Redis（可选）" "设置 REDIS_URL 时用作最新状态缓存；默认不部署，用进程内存缓存" "external,optional"

        admin -> web "HTTPS 操作（RBAC 权限码 + 集团数据范围）"
        branch -> web "HTTPS 操作（本单位及下级数据范围）"
        sampler -> web "HTTPS 工作台 / 箱子查看（本人数据范围）"
        admin -> mini "移动端操作（推断，小程序在仓库外）" "HTTPS" "inferred"
        sampler -> mini "扫码采样 / 签收（推断）" "HTTPS" "inferred"

        web -> httpApi "HTTP /api/v1/*（Bearer HMAC 令牌；10–30s 轮询）" "JSON/HTTP"
        web -> tianditu "地图瓦片与标注" "JS API"
        mini -> httpApi "HTTP /api/v1/*（含 /auth/wechat/login）" "JSON/HTTP" "medium-confidence"

        firmware -> tcp "TCP :9000 JSON 上行：遥测 / 位置 / 开箱 / 补传" "TCP"
        tcp -> firmware "下行：上报策略 / 补传确认 / 抹除指令" "TCP"

        httpApi -> orgApi "路由分发"
        httpApi -> sampleCtrl "路由分发"
        httpApi -> taskCtrl "路由分发"
        httpApi -> overviewCtrl "路由分发"
        httpApi -> syslog "请求观测 / 审计"
        tcp -> ingest "切帧后的报文"
        ingest -> store "箱子状态 + 原始报文同事务提交"
        ingest -> queue "补传查重 / 累计确认（同事务）"
        ingest -> commands "抹除判定 / dump 回收"
        ingest -> cache "写最新状态"
        ingest -> hub "提交成功后发布事件"
        hub -> ws "广播箱子最新状态"
        policy -> tcp "策略变更主动下行"
        taskCtrl -> store "单据状态推进 / 签收归属转移"
        sampleCtrl -> store "箱子查询 / 变更"
        overviewCtrl -> db "单遍聚合查询"
        store -> db "读写"
        syslog -> logDb "写入"
        integrations -> wechatApi "登录凭证 / 手机号 / token" "HTTPS"
        integrations -> smtp "发信" "SMTP"
        integrations -> tianditu "逆地理编码" "HTTPS"
        integrations -> video "POST box.opened（未接入，占位）" "HTTPS" "placeholder"
        cache -> redis "REDIS_URL 设置时" "RESP" "optional"
        ws -> mini "实时推送（消费者未验证）" "WebSocket" "inferred"
    }

    views {
        systemContext sampleBox "SystemContext" "系统上下文：角色、客户端、设备与外部依赖" {
            include *
            autolayout
        }
        container sampleBox "Containers" "容器视图：前端、单进程后端、双 SQLite 库与外部系统" {
            include *
            autolayout
        }
        component backend "UplinkPath" "设备上行链路组件：TCP 接入 → 事务入库 → 缓存 / 推送 → 下行策略" {
            include firmware tcp ingest store queue commands policy cache hub ws
            autolayout
        }
        styles {
            element "database" {
                shape cylinder
            }
            element "external" {
                background #8a8f98
                color #ffffff
            }
            element "embedded" {
                background #2f6f4f
                color #ffffff
            }
            element "placeholder" {
                background #c9ccd1
                color #333333
                border dashed
            }
            element "optional" {
                border dashed
            }
            element "medium-confidence" {
                border dashed
            }
            element "unverified-consumer" {
                border dashed
            }
            relationship "placeholder" {
                style dashed
            }
            relationship "optional" {
                style dashed
            }
            relationship "inferred" {
                style dashed
            }
            relationship "medium-confidence" {
                style dashed
            }
        }
    }
}
