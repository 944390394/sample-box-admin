/**
 * 采样机构的监控通道（1–8 路）。现在还没有真正接视频平台，先把通道登记下来，
 * 任务详情按通道数排好宫格；以后接平台只需填直播地址或由 VideoPlatform.liveUrl 给出。
 * 存在 sys_dept.cameras（JSON 数组）。
 */
export const CAMERA_MAX = 8;

const url = (value) => {
  const text = String(value || "").trim();
  if (!text) return "";
  if (!/^https?:\/\/\S+$/.test(text) || text.length > 500)
    throw new Error("监控地址要以 http:// 或 https:// 开头");
  return text;
};

/** 读库里的 JSON，坏数据当成没有通道。 */
export function readCameras(value) {
  if (!value) return [];
  try {
    const list = JSON.parse(value);
    return Array.isArray(list)
      ? list.slice(0, CAMERA_MAX).filter((item) => item && typeof item.name === "string")
      : [];
  } catch {
    return [];
  }
}

/** 校验表单提交的通道：名称必填，最多 8 路；平台通道号、直播地址、回放地址模板都选填。 */
export function validateCameras(input) {
  if (input == null) return [];
  if (!Array.isArray(input)) throw new Error("监控通道格式不正确");
  if (input.length > CAMERA_MAX) throw new Error(`监控通道最多 ${CAMERA_MAX} 路`);
  return input.map((item, index) => {
    const name = String(item?.name || "").trim();
    if (!name || name.length > 20) throw new Error(`第 ${index + 1} 路监控要填名称（20 字以内）`);
    const channel = String(item?.channel || "").trim();
    if (channel.length > 64) throw new Error(`第 ${index + 1} 路的平台通道号太长`);
    return { name, channel, liveUrl: url(item?.liveUrl), playbackUrl: url(item?.playbackUrl) };
  });
}
