import { logSystem } from "../log/systemLog.js";
import net from "node:net";
import { supportsDispatch } from "../settings/ReportPolicy.js";

import { ackForBox } from "../settings/boxConfig.js";
import { JsonFramer } from "./JsonFramer.js";

/**
 * 设备 TCP 接入。只负责收包和切帧，解析与入库交给 IngestService。
 * 非法报文关掉当前连接，监听端口保持打开。
 */
export class TcpIngestServer {
  constructor({ port, host = "0.0.0.0", ingest, policies = null }) {
    this.port = port;
    this.host = host;
    this.ingest = ingest;
    this.sessions = new Map();
    this.connectionId = 0;
    this.policies = policies;
    this.server = net.createServer((socket) => this.#handle(socket));
  }

  start() {
    return new Promise((resolve, reject) => {
      const onError = (error) => reject(error);
      this.server.once("error", onError);
      this.server.listen(this.port, this.host, () => {
        this.server.off("error", onError);
        resolve(this.server.address());
      });
    });
  }

  address() {
    return this.server.address();
  }

  close() {
    return new Promise((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  pushPolicies(ids) {
    for (const id of ids) {
      const session = this.sessions.get(id);
      if (!session) continue;
      session.enqueue(async () => {
        if (this.sessions.get(id) !== session || session.socket.destroyed) return;
        const packet = await this.policies.packet(session.box, {
          scheduled: true,
          link: session.link,
        });
        if (this.sessions.get(id) !== session || session.socket.destroyed) return;
        await new Promise((resolve, reject) =>
          session.socket.write(packet.text, (error) => (error ? reject(error) : resolve()))
        );
        await this.policies.sent(id, packet.version);
      });
    }
  }

  #handle(socket) {
    let tail = Promise.resolve();
    const session = {
      socket,
      number: ++this.connectionId,
      box: null,
      link: null,
      enqueue(work) {
        tail = tail
          .then(work)
          .catch((error) => logSystem({ source: "tcp", kind: "dispatch", error }));
      },
    };
    socket.on("close", () => {
      if (this.sessions.get(session.box?.id) === session) this.sessions.delete(session.box.id);
    });
    const framer = new JsonFramer();
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      let messages;
      try {
        messages = framer.push(chunk);
      } catch (error) {
        logSystem({ source: "tcp", kind: "frame", error });
        console.error(error.message);
        socket.destroy();
        return;
      }
      for (const message of messages) {
        const started = performance.now();
        let deviceId = "";
        session.enqueue(() =>
          this.ingest
            .accept(message)
            .then(async (committed) => {
              deviceId = committed?.box?.id || "";
              if (committed?.silent) return;
              if (committed?.box && !socket.destroyed) {
                if (session.box && session.box.id !== committed.box.id) {
                  socket.destroy();
                  return;
                }
                session.box = committed.box;
                session.link = committed.netLink;
                const old = this.sessions.get(session.box.id);
                if (
                  committed.scheduled &&
                  supportsDispatch(session.box.firmware) &&
                  (!old || old.number <= session.number)
                ) {
                  this.sessions.set(session.box.id, session);
                } else if (old === session) {
                  this.sessions.delete(session.box.id);
                }
              }
              const packet = this.policies
                ? await this.policies.packet(committed?.box, {
                    scheduled: committed?.scheduled,
                    ack: committed?.ack ?? null,
                    link: committed?.netLink ?? null,
                  })
                : { text: ackForBox(committed?.box) };
              if (!socket.destroyed && socket.writable) {
                const extra = committed?.downlink || null;
                await new Promise((resolve, reject) =>
                  socket.write(packet.text + (extra?.text || ""), (error) =>
                    error ? reject(error) : resolve()
                  )
                );
                if (this.policies && committed.box)
                  await this.policies.sent(committed.box.id, packet.version);
                if (extra?.onSent) await extra.onSent();
              }
            })
            .catch((error) => {
              // 一包处理失败只记日志、不回确认，设备会重传；不断开连接，免得同一批里后面的数据跟着丢
              logSystem({
                source: "tcp",
                kind: "ingest",
                error,
                deviceId,
                duration: performance.now() - started,
              });
              console.error("上报被拒绝", error.message);
            })
        );
      }
    });
    socket.on("error", (error) => {
      logSystem({ source: "tcp", kind: "socket", error });
      socket.destroy();
    });
  }
}
