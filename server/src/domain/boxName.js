/** 激活时没填名称就用顺序号起名：采样箱_00000001。编号是 IMEI，这个序号只用来起名。 */
export function defaultBoxName(no) {
  return `采样箱_${String(no).padStart(8, "0")}`;
}

/** 名称：去掉首尾空白，1–32 个字符。 */
export function readBoxName(value) {
  if (typeof value !== "string") return null;
  const name = value.trim();
  if (!name || name.length > 32) return null;
  return name;
}
