import net from "node:net";
import tls from "node:tls";

/**
 * 最小的 SMTP 客户端：SSL / STARTTLS / 明文，AUTH LOGIN，发纯文本 UTF-8 邮件。
 * 只给系统通知用（找回密码、告警），不做附件和群发。
 * verify 只连到登录成功为止，不发信。
 */
export class Mailer {
  constructor(readConfig, { timeoutMs = 15000 } = {}) {
    this.readConfig = readConfig;
    this.timeoutMs = timeoutMs;
  }

  async verify(override) {
    const config = override || this.readConfig();
    const session = await this.#open(config);
    try {
      await session.quit();
    } finally {
      session.close();
    }
  }

  async send({ to, subject, text }, override) {
    const config = override || this.readConfig();
    if (!config.enabled && !override) throw new Error("邮件服务未启用");
    if (!/^[^\s@<>]+@[^\s@<>]+$/.test(String(to || ""))) throw new Error("收件地址格式不正确");
    const from = config.fromAddress || config.user;
    if (!from) throw new Error("请填写发件地址");
    const session = await this.#open(config);
    try {
      await session.command(`MAIL FROM:<${from}>`, 250);
      await session.command(`RCPT TO:<${to}>`, [250, 251]);
      await session.command("DATA", 354);
      const body = Buffer.from(String(text || ""), "utf8")
        .toString("base64")
        .replace(/.{1,76}/g, "$&\r\n");
      const message = [
        `From: ${encodeWord(config.fromName || "")} <${from}>`,
        `To: <${to}>`,
        `Subject: ${encodeWord(String(subject || ""))}`,
        `Date: ${new Date().toUTCString()}`,
        "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=UTF-8",
        "Content-Transfer-Encoding: base64",
        "",
        body,
      ].join("\r\n");
      await session.command(`${message}\r\n.`, 250);
      await session.quit();
    } finally {
      session.close();
    }
  }

  async #open(config) {
    if (!config.host) throw new Error("请填写 SMTP 服务器");
    let socket = await connect(config, this.timeoutMs);
    const session = new Session(socket, this.timeoutMs);
    await session.expect(220);
    const hello = await session.command("EHLO sample-box-admin", 250);
    if (config.secure === "starttls") {
      if (!/STARTTLS/i.test(hello)) throw new Error("服务器不支持 STARTTLS");
      await session.command("STARTTLS", 220);
      socket = await new Promise((resolve, reject) => {
        const upgraded = tls.connect({ socket, servername: config.host }, () => resolve(upgraded));
        upgraded.once("error", reject);
      });
      session.attach(socket);
      // STARTTLS 之后要重新打招呼；这次的回应用不到
      await session.command("EHLO sample-box-admin", 250);
    }
    if (config.user) {
      await session.command("AUTH LOGIN", 334);
      await session.command(Buffer.from(config.user).toString("base64"), 334);
      await session.command(
        Buffer.from(config.password || "").toString("base64"),
        235,
        "账号或密码不正确"
      );
    }
    return session;
  }
}

function connect(config, timeoutMs) {
  return new Promise((resolve, reject) => {
    const options = { host: config.host, port: Number(config.port) || 465 };
    const socket =
      config.secure === "ssl"
        ? tls.connect({ ...options, servername: config.host })
        : net.connect(options);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("连接 SMTP 服务器超时"));
    }, timeoutMs);
    socket.once(config.secure === "ssl" ? "secureConnect" : "connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`连接 SMTP 服务器失败：${error.message}`));
    });
  });
}

/** 按行读应答：「250-」是续行，「250 」是最后一行。 */
class Session {
  constructor(socket, timeoutMs) {
    this.timeoutMs = timeoutMs;
    this.buffer = "";
    this.waiters = [];
    this.attach(socket);
  }

  attach(socket) {
    this.socket?.removeAllListeners("data");
    this.socket = socket;
    this.buffer = "";
    socket.on("data", (chunk) => {
      this.buffer += chunk.toString("utf8");
      this.#drain();
    });
    socket.on("error", (error) => this.#fail(error));
    socket.on("close", () => this.#fail(new Error("SMTP 连接已断开")));
  }

  #drain() {
    while (this.waiters.length) {
      const lines = this.buffer.split("\r\n");
      const end = lines.findIndex((line) => /^\d{3} /.test(line) || /^\d{3}$/.test(line));
      if (end < 0) return;
      const reply = lines.slice(0, end + 1).join("\n");
      this.buffer = lines.slice(end + 1).join("\r\n");
      this.waiters.shift().resolve(reply);
    }
  }

  #fail(error) {
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  read() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("SMTP 服务器应答超时")), this.timeoutMs);
      this.waiters.push({
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.#drain();
    });
  }

  async expect(codes, message) {
    const reply = await this.read();
    const code = Number(reply.slice(0, 3));
    const wanted = Array.isArray(codes) ? codes : [codes];
    if (!wanted.includes(code))
      throw new Error(message || `SMTP 服务器拒绝：${reply.split("\n").at(-1)}`);
    return reply;
  }

  async command(line, codes, message) {
    this.socket.write(`${line}\r\n`);
    return this.expect(codes, message);
  }

  async quit() {
    try {
      await this.command("QUIT", 221);
    } catch {
      /* 登录成功后 QUIT 失败不算错 */
    }
  }

  close() {
    this.socket.destroy();
  }
}

function encodeWord(text) {
  return /^[\x20-\x7e]*$/.test(text)
    ? text
    : `=?UTF-8?B?${Buffer.from(text, "utf8").toString("base64")}?=`;
}
