import { gunzipSync, gzipSync } from "node:zlib";

/** 上报原文入库前压成 gzip。列表不读这一列，点开一条再解压。 */
export function compressRaw(text) {
  return gzipSync(Buffer.from(String(text ?? ""), "utf8"));
}

export function decompressRaw(value) {
  if (value == null || value === "") return "";
  const bytes = Buffer.isBuffer(value)
    ? value
    : value instanceof Uint8Array
      ? Buffer.from(value)
      : Buffer.from(String(value), "utf8");
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    return gunzipSync(bytes).toString("utf8");
  }
  return bytes.toString("utf8");
}
