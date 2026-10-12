import { WebSocketServer } from "ws";

/**
 * 管理端实时通道。连接时要带登录令牌，通过后把后续箱子状态推下去。
 * 路径固定为 /api/v1/sample/stream。
 */
export class SampleSocketServer {
  constructor({ httpServer, hub, authorize }) {
    this.httpServer = httpServer;
    this.hub = hub;
    this.authorize = authorize;
    this.wss = null;
  }

  start() {
    this.wss = new WebSocketServer({ server: this.httpServer, path: "/api/v1/sample/stream" });
    this.wss.on("connection", (socket, request) => {
      const token = new URL(request.url || "/", "http://localhost").searchParams.get("token") || "";
      if (!this.authorize(token)) {
        socket.close(4401, "登录已过期");
        return;
      }
      const unsubscribe = this.hub.subscribe((box) => {
        if (socket.readyState === socket.OPEN) {
          socket.send(JSON.stringify({ type: "box", box: box.toJSON() }));
        }
      });
      socket.on("close", unsubscribe);
    });
  }

  close() {
    return new Promise((resolve) => {
      if (!this.wss) return resolve();
      this.wss.close(() => resolve());
    });
  }
}
