/**
 * 天地图浏览器端密钥。tk、sk 都要下发给大屏，瓦片请求才能通过。
 * 保存时安全密钥留空表示不改原来的值。
 */

export function publicMap(config) {
  const map = config?.tianditu && typeof config.tianditu === "object" ? config.tianditu : {};
  return {
    tk: String(map.tk || ""),
    sk: String(map.sk || ""),
  };
}

export function mergeMapSettings(current, input) {
  const base = current && typeof current === "object" ? current : {};
  const previous = base.tianditu && typeof base.tianditu === "object" ? base.tianditu : {};
  const tk = String(input?.tk || "").trim();
  const typed = String(input?.sk || "").trim();
  const sk = typed || String(previous.sk || "");
  if (tk.length > 128 || sk.length > 128) throw new Error("密钥过长");
  return { ...base, tianditu: { tk, sk } };
}
