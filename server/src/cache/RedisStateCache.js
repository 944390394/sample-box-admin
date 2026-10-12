import { MemoryStateCache } from "./MemoryStateCache.js";
import { StateCache } from "./StateCache.js";

/**
 * 生产缓存。key 是 sample:box:{箱号}，同时往 sample:box 频道发一份最新 JSON。
 * 多台管理 API 靠这个频道把状态推给各自的 WebSocket。
 */
export class RedisStateCache extends StateCache {
  constructor(client) {
    super();
    this.client = client;
  }

  async put(box) {
    const body = JSON.stringify(box.toJSON());
    await this.client.set(RedisStateCache.key(box.id), body);
    await this.client.publish(RedisStateCache.channel, body);
  }

  async get(id) {
    const body = await this.client.get(RedisStateCache.key(id));
    return body ? JSON.parse(body) : null;
  }

  async close() {
    if (typeof this.client.quit === "function") await this.client.quit();
  }

  static key(id) {
    return `sample:box:${id}`;
  }

  static channel = "sample:box";
}

/** 配置了地址就连接 Redis；连不上直接失败，避免静默退回内存还以为有缓存。 */
export async function openStateCache(url) {
  if (!url) return new MemoryStateCache();
  const { createClient } = await import("redis");
  const client = createClient({ url });
  client.on("error", (error) => {
    console.error("Redis", error.message);
  });
  await client.connect();
  return new RedisStateCache(client);
}
