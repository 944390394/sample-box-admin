/**
 * 从 TCP 字节流里切出完整 JSON 对象。
 * DTU 有时一包一个对象，有时粘在一起，也可能拆成两次 data 事件。
 */
export class JsonFramer {
  constructor(limit = 65536) {
    this.buffer = "";
    this.limit = limit;
  }

  push(chunk) {
    this.buffer += chunk;
    if (this.buffer.length > this.limit) {
      this.buffer = "";
      throw new Error("上报超过 64KB");
    }
    const messages = [];
    while (this.buffer.length) {
      const start = this.buffer.indexOf("{");
      if (start < 0) {
        this.buffer = "";
        break;
      }
      if (start > 0) this.buffer = this.buffer.slice(start);
      const end = this.#endOfObject(this.buffer);
      if (end < 0) break;
      messages.push(this.buffer.slice(0, end));
      this.buffer = this.buffer.slice(end).trimStart();
    }
    return messages;
  }

  #endOfObject(text) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === "{") depth += 1;
      else if (char === "}") {
        depth -= 1;
        if (depth === 0) return index + 1;
      }
    }
    return -1;
  }
}
