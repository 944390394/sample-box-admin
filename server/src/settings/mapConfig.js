import { badRequest } from "../domain/AppError.js";
/**
 * 天地图浏览器端密钥。tk、sk 都要下发给大屏，瓦片请求才能通过。
 * 保存时安全密钥留空表示不改原来的值。
 */

export function publicMap(config) {
  const map = config?.tianditu && typeof config.tianditu === "object" ? config.tianditu : {};
  const tk = String(map.tk || "");
  const sk = String(map.sk || "");
  // hasKey/hasSecret 只是布尔标识，不含密钥本体：没有改密钥权限的人也能知道配没配过
  return { tk, sk, hasKey: tk.length > 0, hasSecret: sk.length > 0 };
}

export function mergeMapSettings(current, input) {
  const base = current && typeof current === "object" ? current : {};
  const previous = base.tianditu && typeof base.tianditu === "object" ? base.tianditu : {};
  const tk = String(input?.tk || "").trim();
  const typed = String(input?.sk || "").trim();
  const sk = typed || String(previous.sk || "");
  if (tk.length > 128 || sk.length > 128) throw badRequest("密钥过长");
  return { ...base, tianditu: { tk, sk } };
}
