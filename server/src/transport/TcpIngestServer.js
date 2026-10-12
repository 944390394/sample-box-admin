import net from "node:net";

import { JsonFramer } from "./JsonFramer.js";

/**
 * 设备 TCP 接入。只负责收包和切帧，解析与入库交给 IngestService。
 * 非法报文关掉当前连接，监听端口保持打开。
 */
export class TcpIngestServer {
  constructor({ port, host = "0.0.0.0", ingest }) {
    this.port = port;
    this.host = host;
    this.ingest = ingest;
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

  #handle(socket) {
    const framer = new JsonFramer();
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      let messages;
      try {
        messages = framer.push(chunk);
      } catch (error) {
        console.error(error.message);
        socket.destroy();
        return;
      }
      for (const message of messages) {
        this.ingest.accept(message).catch((error) => {
          console.error("上报被拒绝", error.message);
          socket.destroy();
        });
      }
    });
    socket.on("error", () => {
      socket.destroy();
    });
  }
}
