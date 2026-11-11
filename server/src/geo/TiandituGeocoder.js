/**
 * 与已配置的天地图JavaScript应用一致，通过官方SDK服务通道查询地址。
 * 不能把浏览器应用密钥直接套到另一个鉴权入口，更不能自行猜测签名算法。
 */

export function roundKey(lng, lat) {
  return `${Number(lng).toFixed(4)},${Number(lat).toFixed(4)}`;
}

export function parseGeocoderResponse(text) {
  // 官方SDK返回固定变量赋值；只解析JSON，不执行远端脚本。
  const assignment = /^\s*var\s+tdt_loadResult\s*=\s*([\s\S]*?)\s*;?\s*$/.exec(text);
  try {
    return JSON.parse(assignment ? assignment[1] : text);
  } catch {
    throw new Error("天地图地址服务返回格式异常");
  }
}

export async function reverseAddress(tk, lng, lat, fetchImpl = fetch, sk = "") {
  if (!tk || lng == null || lat == null) return "";
  if (
    !Number.isFinite(Number(lng)) ||
    !Number.isFinite(Number(lat)) ||
    Math.abs(Number(lng)) > 180 ||
    Math.abs(Number(lat)) > 90
  )
    throw new Error("地址坐标不正确");
  const params = {
    postStr: JSON.stringify({ lon: Number(lng), lat: Number(lat), ver: 1 }),
    type: "geocode",
    tk,
  };
  if (sk) params.sk = sk;
  const query = Object.keys(params)
    .map((key) => `${key}=${encodeURIComponent(params[key])}`)
    .join("&");
  const target = `https://api.tianditu.gov.cn/geocoder?${query}`;
  const url = `https://api.tianditu.gov.cn/apiserver/ajaxproxy?proxyReqUrl=${encodeURIComponent(encodeURIComponent(target))}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`天地图地址服务请求失败（HTTP ${response.status}）`);
    const body = parseGeocoderResponse(await response.text());
    if (String(body?.status) !== "0")
      throw new Error("天地图地址服务校验失败或暂时不可用，请检查地图配置");
    return String(body?.result?.formatted_address || "").trim();
  } catch (error) {
    // 不把包含凭证URL的底层fetch异常带进日志。
    if (error instanceof Error && error.message.startsWith("天地图")) throw error;
    // eslint-disable-next-line preserve-caught-error -- 故意不带 cause：底层错误里有带密钥的地址
    throw new Error(
      controller.signal.aborted ? "天地图地址服务响应超时" : "天地图地址服务连接失败"
    );
  } finally {
    clearTimeout(timer);
  }
}

export class TiandituGeocoder {
  constructor(tk, fetchImpl = fetch, sk = "") {
    this.tk = tk;
    this.sk = sk;
    this.fetch = fetchImpl;
    this.cache = new Map();
    this.pending = new Map();
    this.retryAt = new Map();
  }

  async lookup(lng, lat) {
    if (!this.tk || lng == null || lat == null) return "";
    const key = roundKey(lng, lat);
    if (this.cache.has(key)) return this.cache.get(key);
    if (this.pending.has(key)) return this.pending.get(key);
    if ((this.retryAt.get(key) || 0) > Date.now()) return "";
    const task = (async () => {
      try {
        const text = await reverseAddress(this.tk, lng, lat, this.fetch, this.sk);
        if (text) {
          if (this.cache.size >= 5000) this.cache.delete(this.cache.keys().next().value);
          this.cache.set(key, text);
          this.retryAt.delete(key);
        } else {
          if (this.retryAt.size >= 5000) this.retryAt.delete(this.retryAt.keys().next().value);
          this.retryAt.set(key, Date.now() + 60000);
        }
        return text;
      } catch (error) {
        if (this.retryAt.size >= 5000) this.retryAt.delete(this.retryAt.keys().next().value);
        this.retryAt.set(key, Date.now() + 60000);
        throw error;
      } finally {
        this.pending.delete(key);
      }
    })();
    this.pending.set(key, task);
    return task;
  }

  async fill(box) {
    let changed = false;
    const lbs = await this.lookup(box.lbsLng, box.lbsLat);
    if (lbs && lbs !== box.lbsAddress) {
      box.lbsAddress = lbs;
      changed = true;
    }
    const gps = await this.lookup(box.gpsLng, box.gpsLat);
    if (gps && gps !== box.gpsAddress) {
      box.gpsAddress = gps;
      changed = true;
    }
    return changed;
  }
}
