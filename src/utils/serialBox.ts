/**
 * 采样箱 USB 串口（板上 CH340，9600 8N1）的本地读取。协议见 docs/offline-queue.md「USB 串口本地读取」：
 * 发一行命令（help / info / queue / dump / last），板子回以 # 开头的行，字段 key=value 用空格分隔；
 * 不带 # 的是板子镜像出来的上报行。用浏览器的 Web Serial，只有电脑上的 Chrome / Edge、https 或 localhost 能用。
 */

interface SerialPortLike {
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
}
interface SerialLike {
  requestPort(): Promise<SerialPortLike>;
}

export function serialSupported() {
  return typeof navigator !== "undefined" && "serial" in navigator && window.isSecureContext;
}

export type ReplyKind = "info" | "queue" | "rec" | "end" | "last" | "help" | "err" | "uplink";

export interface Reply {
  kind: ReplyKind;
  fields: Record<string, string>;
  /** rec / last 的上报原文；uplink 是整行。 */
  text: string;
  raw: string;
}

/** 「k=v k=v」拆成对象。 */
export function spaceFields(text: string) {
  const out: Record<string, string> = {};
  for (const part of text.trim().split(/\s+/)) {
    const at = part.indexOf("=");
    if (at > 0) out[part.slice(0, at)] = part.slice(at + 1);
  }
  return out;
}

/** 上报原文「why=timer,opens=2,bat=3900,…」拆成对象。 */
export function uplinkFields(text: string) {
  const out: Record<string, string> = {};
  for (const part of text.trim().split(",")) {
    const at = part.indexOf("=");
    if (at > 0) out[part.slice(0, at)] = part.slice(at + 1);
  }
  return out;
}

/** 一行回复分类解析。#rec i= q= bf= 后面整段是原文（原文里有逗号没有空格）。 */
export function parseReply(line: string): Reply {
  const raw = line.trim();
  const match = /^#(\w+)\s*(.*)$/.exec(raw);
  if (!match) return { kind: "uplink", fields: uplinkFields(raw), text: raw, raw };
  const kind = match[1] as ReplyKind;
  const rest = match[2];
  if (kind === "rec") {
    const head = /^((?:\w+=\S*\s+){3})(.*)$/.exec(`${rest} `);
    const fields = spaceFields(head ? head[1] : rest);
    return { kind, fields, text: head ? head[2].trim() : "", raw };
  }
  if (kind === "last") return { kind, fields: {}, text: rest.trim(), raw };
  if (["info", "queue", "end", "help", "err"].includes(kind))
    return { kind, fields: spaceFields(rest), text: rest, raw };
  return { kind: "uplink", fields: {}, text: raw, raw };
}

/** 一个串口连接：按行回调，可以发命令。 */
export class BoxSerial {
  private port: SerialPortLike | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private closing = false;
  private loop: Promise<void> | null = null;

  private onLine: (line: string) => void;
  private onClose: (reason: string) => void;

  constructor(onLine: (line: string) => void, onClose: (reason: string) => void) {
    this.onLine = onLine;
    this.onClose = onClose;
  }

  get connected() {
    return this.port != null;
  }

  /** 弹出浏览器的串口选择框，选好后按 9600 打开并开始读。用户取消时抛错。 */
  async connect() {
    const serial = (navigator as unknown as { serial: SerialLike }).serial;
    const port = await serial.requestPort();
    await port.open({ baudRate: 9600 });
    this.port = port;
    this.closing = false;
    this.loop = this.readLoop(port);
  }

  private async readLoop(port: SerialPortLike) {
    const decoder = new TextDecoder();
    let buffer = "";
    let reason = "";
    try {
      while (port.readable && !this.closing) {
        this.reader = port.readable.getReader();
        try {
          for (;;) {
            const { value, done } = await this.reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let at = buffer.search(/[\r\n]/);
            while (at >= 0) {
              const line = buffer.slice(0, at);
              buffer = buffer.slice(at + 1);
              if (line.trim()) this.onLine(line);
              at = buffer.search(/[\r\n]/);
            }
            // 防止对端一直不发换行把内存撑大
            if (buffer.length > 4096) buffer = buffer.slice(-1024);
          }
        } finally {
          this.reader.releaseLock();
          this.reader = null;
        }
      }
    } catch (error) {
      reason = error instanceof Error ? error.message : "串口读取出错";
    }
    if (!this.closing) {
      // 线被拔掉、设备断开
      await port.close().catch(() => {});
      this.port = null;
      this.onClose(reason || "设备已断开");
    }
  }

  async send(command: string) {
    if (!this.port?.writable) throw new Error("还没连接");
    const writer = this.port.writable.getWriter();
    try {
      await writer.write(new TextEncoder().encode(`${command}\r\n`));
    } finally {
      writer.releaseLock();
    }
  }

  async disconnect() {
    const port = this.port;
    if (!port) return;
    this.closing = true;
    await this.reader?.cancel().catch(() => {});
    // 等读循环释放锁，串口才能关
    await this.loop?.catch(() => {});
    this.loop = null;
    await port.close().catch(() => {});
    this.port = null;
    this.onClose("");
  }
}
