import { parseGeocoderResponse } from "./TiandituGeocoder.js";

/**
 * 天地图地名搜索 V2.0，走官方 SDK 的代理通道（浏览器端密钥不能直连，见 TiandituGeocoder）。
 * 浏览器里的 LocalSearch 只搜当前地图视野，地图停在深圳时搜外地的地名会搜偏；
 * 这里按「全国 → 省 → 市」搜：
 * - 不指定区域：全国搜，命中多个省时返回各省的条数，让用户先选省；
 * - 指定省：返回该省下各市的条数，让用户再选市；
 * - 指定市（或区县、直辖市）：返回具体地点。
 * 区域编码是 9 位国标码，如合肥市 156340100。
 */
const CHINA_BOUND = "73,3,136,54";

function lonlat(text) {
  const [lng, lat] = String(text || "")
    .split(/[ ,]/)
    .map(Number);
  return Number.isFinite(lng) && Number.isFinite(lat) ? { lng, lat } : null;
}

/** 省市区 + 详细地址；详细地址已经带了省市就不重复。 */
function fullAddress(poi) {
  const address = String(poi.address || "");
  const parts = [poi.province, poi.city !== poi.province ? poi.city : "", poi.county].filter(
    Boolean
  );
  const prefix = parts.filter((part) => !address.includes(part)).join("");
  return `${prefix}${address}`;
}

export function readRegionCode(value) {
  const code = String(value || "").trim();
  return /^156\d{6}$/.test(code) ? code : "";
}

export async function searchPlaces({ tk, keyword, region = "", page = 0, fetchImpl = fetch }) {
  const keyWord = String(keyword || "")
    .trim()
    .slice(0, 50);
  if (!tk) throw new Error("未配置天地图密钥");
  if (!keyWord) return { kind: "none", items: [], total: 0 };
  const specify = readRegionCode(region);
  const start = Math.max(0, Math.min(290, Math.floor(Number(page) || 0) * 10));
  const post = specify
    ? { keyWord, queryType: 12, specify, start, count: 10, show: 2 }
    : { keyWord, level: 5, mapBound: CHINA_BOUND, queryType: 1, start, count: 10, show: 2 };
  const target = `http://api.tianditu.gov.cn/v2/search?postStr=${JSON.stringify(post)}&type=query&tk=${tk}`;
  const url = `https://api.tianditu.gov.cn/apiserver/ajaxproxy?proxyReqUrl=${encodeURIComponent(target)}`;
  let body;
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    body = parseGeocoderResponse(await response.text());
  } catch {
    // 不把带密钥的地址带进错误信息
    throw new Error("天地图地名搜索暂时不可用，可以直接在地图上点选");
  }
  const type = Number(body?.resultType);
  if (type === 2) {
    const items = (body.statistics?.allAdmins || body.statistics?.priorityCitys || [])
      .map((admin) => ({
        name: admin.adminName,
        code: String(admin.adminCode),
        count: Number(admin.count) || 0,
        leaf: Boolean(admin.isleaf),
        ...lonlat(admin.lonlat),
      }))
      .filter((admin) => readRegionCode(admin.code));
    return { kind: "regions", items, total: Number(body.count) || 0 };
  }
  if (type === 3) {
    const items = (body.area ? [].concat(body.area) : [])
      .map((area) => ({
        name: area.name,
        address: area.name,
        code: String(area.adminCode || ""),
        ...lonlat(area.lonlat),
      }))
      .filter((area) => area.lng != null);
    return { kind: "pois", items, total: items.length };
  }
  const items = (body?.pois || [])
    .map((poi) => ({
      name: poi.name || "",
      address: fullAddress(poi),
      type: poi.typeName || "",
      ...lonlat(poi.lonlat),
    }))
    .filter((poi) => poi.lng != null);
  return {
    kind: items.length ? "pois" : "none",
    items,
    total: Number(body?.count) || items.length,
  };
}
