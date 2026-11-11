import { WebSocketServer } from "ws";

import { BOX, EVENT_KINDS, EVENT_PERMS, canSee, maskBox, maskUplink } from "../auth/boxAccess.js";

/**
 * 管理端实时通道。连接时要带登录令牌，通过后把后续箱子状态推下去。
 * 路径固定为 /api/v1/sample/stream。
 * 给了 access 时按登录人的数据范围和权限过滤：范围外的箱子不推，无权字段拿掉。权限改了要重连才生效。
 */
export class SampleSocketServer {
  constructor({ httpServer, hub, authorize, access = null }) {
    this.httpServer = httpServer;
    this.hub = hub;
    this.authorize = authorize;
    this.access = access;
    this.wss = null;
  }

  start() {
    this.wss = new WebSocketServer({ server: this.httpServer, path: "/api/v1/sample/stream" });
    this.wss.on("connection", (socket, request) => {
      const token = new URL(request.url || "/", "http://localhost").searchParams.get("token") || "";
      if (!this.access) {
        if (!this.authorize(token)) {
          socket.close(4401, "登录已过期");
          return;
        }
        this.#follow(socket, null);
        return;
      }
      let closed = false;
      socket.on("close", () => {
        closed = true;
      });
      Promise.resolve(this.access(token))
        .then((access) => {
          if (closed) return;
          if (!access) {
            socket.close(4401, "登录已过期");
            return;
          }
          if (!access.perms.has(BOX.list) && !access.perms.has(BOX.detail)) {
            socket.close(4403, "没有采样箱权限");
            return;
          }
          this.#follow(socket, access);
        })
        .catch(() => {
          if (!closed) socket.close(1011, "校验失败");
        });
    });
  }

  #follow(socket, access) {
    socket.userId = access?.userId;
    const unsubscribe = this.hub.subscribe((box, record) => {
      if (socket.readyState !== socket.OPEN) return;
      if (access && !canSee(access, box)) return;
      const perms = access?.perms;
      const message = { type: "box", box: maskBox(box.toJSON(), perms) };
      const uplink = uplinkList(record);
      // 全部报文要「查看上报记录」；开关箱、上电、充电各要各的记录权限
      const readable =
        !perms ||
        perms.has(BOX.log) ||
        (EVENT_KINDS.includes(uplink?.kind) && perms.has(EVENT_PERMS[uplink.kind]));
      if (uplink && readable) {
        message.uplink = maskUplink(uplink, perms);
      }
      socket.send(JSON.stringify(message));
    });
    socket.on("close", unsubscribe);
  }

  close() {
    return new Promise((resolve) => {
      if (!this.wss) return resolve();
      this.wss.close(() => resolve());
    });
  }

  /** 修改凭据后立即停止该账户已连接的实时数据流。 */
  disconnectUser(id) {
    for (const socket of this.wss?.clients || []) {
      if (String(socket.userId) === String(id)) socket.terminate();
    }
  }
}

/** 实时通道只追加列表字段。原文等点开后再按主键解压。 */
function uplinkList(record) {
  if (!record || typeof record.toListJSON !== "function") return null;
  const uplink = record.toListJSON();
  if (!uplink || typeof uplink !== "object") return null;
  delete uplink.raw;
  return uplink;
}
