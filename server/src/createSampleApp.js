import { openStateCache } from "./cache/RedisStateCache.js";
import { Clock } from "./domain/Clock.js";
import { UplinkParser } from "./domain/UplinkParser.js";
import { SampleController } from "./http/SampleController.js";
import { IngestService } from "./service/IngestService.js";
import { MysqlPool } from "./store/MysqlPool.js";
import { SqlBoxStore } from "./store/SqlBoxStore.js";
import { RealtimeHub } from "./transport/RealtimeHub.js";
import { SampleSocketServer } from "./transport/SampleSocketServer.js";
import { TcpIngestServer } from "./transport/TcpIngestServer.js";

/**
 * 采样后端的组装根。
 * 设备从 TCP 进来，管理端从 HTTP 查询，打开页面的人从 WebSocket 收最新状态。
 * REDIS_URL 为空时用内存缓存；MySQL 使用连接池，SQLite 沿用安装向导那条连接。
 */
export async function startSampleRuntime({ httpServer, db, config, authorize }) {
  const executor = await openExecutor(db, config);
  const boxes = new SqlBoxStore(executor);
  const cache = await openStateCache(process.env.REDIS_URL || "");
  const hub = new RealtimeHub();
  const ingest = new IngestService({
    boxes,
    cache,
    hub,
    clock: new Clock(),
    parser: new UplinkParser(),
  });
  const tcp = new TcpIngestServer({
    port: Number(process.env.SAMPLE_TCP_PORT) || 9000,
    ingest,
  });
  const sockets = new SampleSocketServer({ httpServer, hub, authorize });
  sockets.start();
  await tcp.start();
  return {
    controller: new SampleController(boxes),
    tcpAddress: tcp.address(),
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
