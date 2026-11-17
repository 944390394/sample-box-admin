import { ReportPolicy } from "./settings/ReportPolicy.js";
import { DeviceCommands } from "./settings/DeviceCommands.js";
import { QueueAck } from "./settings/QueueAck.js";
import { ReportPolicyController } from "./http/ReportPolicyController.js";
import { OverviewController } from "./http/OverviewController.js";
import { openStateCache } from "./cache/RedisStateCache.js";
import { Clock } from "./domain/Clock.js";
import { UplinkParser } from "./domain/UplinkParser.js";
import { TiandituGeocoder } from "./geo/TiandituGeocoder.js";
import { SampleController } from "./http/SampleController.js";
import { IngestService } from "./service/IngestService.js";
import { MysqlPool } from "./store/MysqlPool.js";
import { SqlBoxStore } from "./store/SqlBoxStore.js";
import { RealtimeHub } from "./transport/RealtimeHub.js";
import { SampleSocketServer } from "./transport/SampleSocketServer.js";
import { applyBoxSettings } from "./settings/boxConfig.js";
import { TcpIngestServer } from "./transport/TcpIngestServer.js";
import { TaskVideoService } from "./settings/TaskVideoService.js";
import { VideoPlatform } from "./integration/VideoPlatform.js";
import { readVideo } from "./settings/integrationConfig.js";

/**
 * 采样后端的组装根。
 * 设备从 TCP 进来，管理端从 HTTP 查询，打开页面的人从 WebSocket 收最新状态。
 * REDIS_URL 为空时用内存缓存；MySQL 使用连接池，SQLite 沿用安装向导那条连接。
 */
export async function startSampleRuntime({
  httpServer,
  db,
  config,
  authorize,
  access = null,
  getConfig = () => config,
}) {
  applyBoxSettings(config);
  const executor = await openExecutor(db, config);
  const boxes = new SqlBoxStore(executor);
  const policies = new ReportPolicy(executor);
  await policies.initializeAssignments();
  const commands = new DeviceCommands(executor);
  const queue = new QueueAck(executor);
  const cache = await openStateCache(process.env.REDIS_URL || "");
  const hub = new RealtimeHub();
  const map = config?.tianditu && typeof config.tianditu === "object" ? config.tianditu : {};
  // 视频平台配置在系统设置里随时可改，每次请求都读最新的
  const videos = new TaskVideoService(executor, new VideoPlatform(() => readVideo(getConfig())));
  const ingest = new IngestService({
    videos,
    boxes,
    policies,
    commands,
    queue,
    cache,
    hub,
    clock: new Clock(),
    parser: new UplinkParser(),
    geocoder: map.tk ? new TiandituGeocoder(String(map.tk), fetch, String(map.sk || "")) : null,
  });
  const tcp = new TcpIngestServer({
    port: Number(process.env.SAMPLE_TCP_PORT) || 9000,
    ingest,
    policies,
  });
  policies.onPolicyChanged = (ids) => tcp.pushPolicies(ids);
  const sockets = new SampleSocketServer({ httpServer, hub, authorize, access });
  sockets.start();
  await tcp.start();
  const controller = new SampleController(boxes, policies);
  controller.removeBox = (box, authorize, options) => ingest.deleteBox(box, authorize, options);
  controller.commands = commands;
  controller.policy = new ReportPolicyController(boxes, policies);
  controller.policy.videos = videos;
  controller.overview = new OverviewController(boxes, policies.db);
  controller.videos = videos;
  return {
    controller,
    tcpAddress: tcp.address(),
    disconnectUser: (id) => sockets.disconnectUser(id),
    async close() {
      await tcp.close();
      await sockets.close();
      await cache.close();
      if (typeof boxes.flush === "function") await boxes.flush();
      await executor.close();
    },
  };
}

async function openExecutor(db, config) {
  if (config?.dialect === "mysql") return MysqlPool.connect(config);
  return {
    dialect: db.dialect,
    all: (sql, params) => db.all(sql, params),
    get: (sql, params) => db.get(sql, params),
    run: (sql, params) => db.run(sql, params),
    transaction: (fn) => db.transaction(fn),
    async close() {},
  };
}
