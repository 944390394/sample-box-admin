/** 按需加载天地图 JavaScript API 4.0，全页只请求一次。 */

interface TiandituKeyResult {
  code?: number;
}

/** 地图事件里的经纬度。不同版本有的给属性，有的只给方法。 */
interface TiandituLngLat {
  lng?: number;
  lat?: number;
  getLng?: () => number;
  getLat?: () => number;
}

interface TiandituPoi {
  name?: string;
  address?: string;
  /** "116.39,39.91" */
  lonlat?: string;
}

interface TiandituSearchResult {
  getResultType?: () => number | string;
  getPois?: () => TiandituPoi[] | null;
  getArea?: () => { name?: string; lonlat?: string } | null;
}

interface TiandituApi {
  Map: new (container: string | HTMLElement) => TiandituMap;
  LngLat: new (lng: number, lat: number) => unknown;
  Point: new (x: number, y: number) => unknown;
  Marker: new (
    lnglat: unknown,
    options?: { title?: string; icon?: unknown; draggable?: boolean }
  ) => TiandituOverlay;
  LocalSearch?: new (
    map: TiandituMap,
    options: { pageCapacity?: number; onSearchComplete: (result: TiandituSearchResult) => void }
  ) => { search: (keyword: string) => void };
  Icon?: new (options: { iconUrl: string; iconSize: unknown; iconAnchor: unknown }) => unknown;
  InfoWindow: new (content: string, options?: Record<string, unknown>) => unknown;
  Circle?: new (center: unknown, radius: number, options?: Record<string, unknown>) => unknown;
  Polyline?: new (points: unknown[], options?: Record<string, unknown>) => unknown;
  Label?: new (options: Record<string, unknown>) => unknown;
  Control: {
    Zoom: new () => unknown;
    Scale: new () => unknown;
    MapType: new () => unknown;
  };
  qv?: (result?: TiandituKeyResult) => void;
  /** 瓦片地址里的 tk、sk 参数 */
  tk?: string;
  Geocoder?: new () => {
    getLocation: (
      lnglat: unknown,
      callback: (result: {
        getStatus?: () => number | string;
        getMsg?: () => string;
        getAddress?: () => string;
      }) => void
    ) => void;
  };
}

interface TiandituOverlay {
  addEventListener: (type: string, handler: (event?: { lnglat?: TiandituLngLat }) => void) => void;
  openInfoWindow: (win: unknown) => void;
  setLngLat?: (lnglat: unknown) => void;
}

interface TiandituMap {
  centerAndZoom: (lnglat: unknown, zoom: number) => void;
  enableScrollWheelZoom: () => void;
  disableScrollWheelZoom?: () => void;
  addControl: (control: unknown) => void;
  addOverLay: (overlay: unknown) => void;
  clearOverLays: () => void;
  setViewport: (lnglats: unknown[]) => void;
  checkResize: () => void;
  getZoom?: () => number;
  panTo?: (lnglat: unknown) => void;
  addEventListener?: (type: string, handler: (event?: { lnglat?: TiandituLngLat }) => void) => void;
  removeEventListener?: (
    type: string,
    handler: (event?: { lnglat?: TiandituLngLat }) => void
  ) => void;
  removeOverLay?: (overlay: unknown) => void;
}

declare global {
  interface Window {
    T?: TiandituApi;
    TMAP_NORMAL_MAP?: unknown;
  }
}

export type { TiandituApi, TiandituMap, TiandituOverlay, TiandituLngLat };

/** 事件里的经纬度转成数字；拿不到返回 null。 */
export function readLngLat(value?: TiandituLngLat | null) {
  if (!value) return null;
  const lng = typeof value.lng === "number" ? value.lng : value.getLng?.();
  const lat = typeof value.lat === "number" ? value.lat : value.getLat?.();
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  return { lng: Number(lng), lat: Number(lat) };
}

export interface PlaceHit {
  name: string;
  address: string;
  lng: number;
  lat: number;
}

/**
 * 地名搜索。LocalSearch 随 service.js 异步加载，等不到时返回空列表而不是报错。
 * 只取兴趣点和行政区两类结果，统计、线路类结果不适合当地址。
 */
export async function searchPlaces(map: TiandituMap, keyword: string): Promise<PlaceHit[]> {
  const started = Date.now();
  while (!window.T?.LocalSearch && Date.now() - started < 8000) {
    await new Promise((resolve) => window.setTimeout(resolve, 100));
  }
  const api = window.T;
  if (!api?.LocalSearch) throw new Error("地名搜索组件加载超时，请重试");
  const parse = (lonlat?: string) => {
    const [lng, lat] = String(lonlat || "")
      .split(/[ ,]/)
      .map(Number);
    return Number.isFinite(lng) && Number.isFinite(lat) ? { lng, lat } : null;
  };
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error("地名搜索响应超时，请重试")), 8000);
    const search = new api.LocalSearch!(map, {
      pageCapacity: 10,
      onSearchComplete: (result) => {
        window.clearTimeout(timer);
        const type = Number(result?.getResultType?.());
        const hits: PlaceHit[] = [];
        if (type === 1) {
          for (const poi of result.getPois?.() || []) {
            const at = parse(poi.lonlat);
            if (at) hits.push({ name: poi.name || "", address: poi.address || "", ...at });
          }
        } else if (type === 3) {
          const area = result.getArea?.();
          const at = parse(area?.lonlat);
          if (area && at)
            hits.push({ name: area.name || keyword, address: area.name || "", ...at });
        }
        resolve(hits);
      },
    });
    search.search(keyword);
  });
}

/** 设置里的地图密钥，没有时用构建时的环境变量。 */
export function readMapKeys() {
  return readAddressKeys();
}

const KEY_ERROR =
  "天地图密钥不可用。请到控制台确认已开通 JavaScript API，并把当前网址加入允许列表。";

interface KeyStatus {
  code?: number;
  msg?: string;
}

type KeyListener = (message: string) => void;

const keyListeners = new Set<KeyListener>();
let loading: Promise<void> | null = null;

export function onTiandituKeyError(listener: KeyListener) {
  keyListeners.add(listener);
  return () => keyListeners.delete(listener);
}

function notifyKeyError() {
  keyListeners.forEach((listener) => listener(KEY_ERROR));
}

/** 4.0 主脚本没有 Label，TMAP_NORMAL_MAP 也只影响图层切换，不能拿它们卡住首屏。 */
function coreReady() {
  const api = window.T;
  return Boolean(api?.Map && api.Marker && api.InfoWindow);
}

function waitForApi() {
  if (coreReady()) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const started = Date.now();
    const timer = window.setInterval(() => {
      if (coreReady()) {
        window.clearInterval(timer);
        resolve();
        return;
      }
      if (Date.now() - started > 8000) {
        window.clearInterval(timer);
        reject(new Error("天地图加载超时"));
      }
    }, 40);
  });
}

async function readKeyStatus(tk: string): Promise<KeyStatus | null> {
  try {
    const response = await fetch(
      `https://api.tianditu.gov.cn/qv?tk=${encodeURIComponent(tk)}&t=${Date.now()}`,
      { signal: AbortSignal.timeout(2000) }
    );
    if (!response.ok) return null;
    return (await response.json()) as KeyStatus;
  } catch {
    return null;
  }
}

function injectScript(tk: string) {
  return new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = `https://api.tianditu.gov.cn/api?v=4.0&tk=${encodeURIComponent(tk)}`;
    script.async = true;
    script.dataset.tianditu = "1";
    script.onload = () => {
      const api = window.T;
      if (api) {
        api.qv = (result) => {
          if (result && result.code !== 0) notifyKeyError();
        };
      }
      resolve();
    };
    script.onerror = () => reject(new Error("天地图脚本加载失败"));
    document.head.appendChild(script);
  });
}

function applySecurityKey(tk: string, sk: string) {
  const api = window.T;
  if (!api || !sk) return;
  api.tk = `tk=${tk}&sk=${sk}&`;
}

export function loadTianditu(tk: string, sk = "") {
  if (coreReady()) {
    applySecurityKey(tk, sk);
    return Promise.resolve();
  }
  if (!tk) return Promise.reject(new Error("未配置天地图密钥"));
  if (loading) return loading;

  loading = (async () => {
    const statusPromise = readKeyStatus(tk).then((status) => {
      if (status && status.code !== 0) notifyKeyError();
    });
    await injectScript(tk);
    await waitForApi();
    applySecurityKey(tk, sk);
    void statusPromise;
  })().catch((error: unknown) => {
    loading = null;
    throw error;
  });

  return loading;
}

export interface AddressResult {
  status: "resolved" | "empty" | "error";
  address: string;
  message?: string;
}
const addressCache = new Map<string, string>();
const addressPending = new Map<string, Promise<AddressResult>>();
let addressQueue: Promise<unknown> = Promise.resolve();
let addressKeys: Promise<{ tk: string; sk: string }> | undefined;
let addressKeysAt = 0;

async function readAddressKeys() {
  let tk = import.meta.env.VITE_TIANDITU_TK ?? "";
  let sk = import.meta.env.VITE_TIANDITU_SK ?? "";
  try {
    const { default: SettingsAPI } = await import("@/api/system/settings");
    const settings = await SettingsAPI.get();
    if (settings.map?.tk) {
      tk = settings.map.tk;
      sk = settings.map.sk || sk;
    }
  } catch {
    /* 设置接口不可用时退回构建时的环境变量。 */
  }
  return { tk, sk };
}

/** 主脚本先提供地图，service.js 随后异步提供 Geocoder，不能把未加载当成无地址。 */
export function waitForGeocoder(timeoutMs = 10000): Promise<TiandituApi> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const check = () => {
      if (window.T?.Geocoder && window.T.LngLat) return resolve(window.T);
      if (Date.now() - started >= timeoutMs)
        return reject(new Error("地址解析组件加载超时，请重试"));
      window.setTimeout(check, 50);
    };
    check();
  });
}

/** 串行调用SDK，避免其全局JSONP结果在多个地点并发时相互覆盖；仅缓存成功地址。 */
export async function resolveChineseAddress(lng: number, lat: number): Promise<AddressResult> {
  if (!Number.isFinite(lng) || !Number.isFinite(lat) || Math.abs(lng) > 180 || Math.abs(lat) > 90) {
    return { status: "error", address: "", message: "坐标格式不正确" };
  }
  if (!addressKeys || Date.now() - addressKeysAt > 60000) {
    addressKeysAt = Date.now();
    addressKeys = readAddressKeys();
  }
  const { tk, sk } = await addressKeys;
  if (!tk) return { status: "error", address: "", message: "未配置天地图应用密钥" };
  const key = `${tk}:${lng.toFixed(5)},${lat.toFixed(5)}`;
  const cached = addressCache.get(key);
  if (cached) return { status: "resolved", address: cached };
  const pending = addressPending.get(key);
  if (pending) return pending;
  const task = addressQueue.then(async (): Promise<AddressResult> => {
    try {
      await loadTianditu(tk, sk);
      const api = await waitForGeocoder();
      const Geocoder = api.Geocoder!;
      const text = await new Promise<string>((resolve, reject) => {
        const timer = window.setTimeout(() => reject(new Error("地址服务响应超时，请重试")), 8000);
        try {
          new Geocoder().getLocation(new api.LngLat(lng, lat), (result) => {
            window.clearTimeout(timer);
            try {
              if (String(result.getStatus?.()) !== "0") {
                const message = result.getMsg?.() || "地址服务暂时不可用";
                reject(
                  new Error(
                    /安全|密钥|权限|key/i.test(message)
                      ? "地址服务密钥校验失败，请检查系统设置"
                      : "地址服务暂时不可用，请重试"
                  )
                );
                return;
              }
              resolve(String(result.getAddress?.() || "").trim());
            } catch {
              reject(new Error("地址服务返回格式异常，请重试"));
            }
          });
        } catch {
          window.clearTimeout(timer);
          reject(new Error("地址服务请求失败，请重试"));
        }
      });
      if (text) {
        if (addressCache.size >= 1000) addressCache.delete(addressCache.keys().next().value!);
        addressCache.set(key, text);
      }
      return { status: text ? "resolved" : "empty", address: text };
    } catch (error) {
      return {
        status: "error",
        address: "",
        message: error instanceof Error ? error.message : "地址解析失败，请重试",
      };
    }
  });
  addressPending.set(key, task);
  addressQueue = task;
  try {
    return await task;
  } finally {
    addressPending.delete(key);
  }
}

/** 兼容当前地址等只需要文本的调用方，失败状态由地图列表单独展示。 */
export async function reverseChineseAddress(lng: number, lat: number) {
  return (await resolveChineseAddress(lng, lat)).address;
}
