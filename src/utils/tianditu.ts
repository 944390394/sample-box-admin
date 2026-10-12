/** 按需加载天地图 JavaScript API 4.0，全页只请求一次。 */

interface TiandituKeyResult {
  code?: number;
}

interface TiandituApi {
  Map: new (container: string | HTMLElement) => TiandituMap;
  LngLat: new (lng: number, lat: number) => unknown;
  Point: new (x: number, y: number) => unknown;
  Marker: new (lnglat: unknown, options?: { title?: string }) => TiandituOverlay;
  InfoWindow: new (content: string, options?: Record<string, unknown>) => unknown;
  Label?: new (options: Record<string, unknown>) => unknown;
  Control: {
    Zoom: new () => unknown;
    Scale: new () => unknown;
    MapType: new () => unknown;
  };
  qv?: (result?: TiandituKeyResult) => void;
  /** 瓦片地址里的 tk、sk 参数 */
  tk?: string;
}

interface TiandituOverlay {
  addEventListener: (type: string, handler: () => void) => void;
  openInfoWindow: (win: unknown) => void;
}

interface TiandituMap {
  centerAndZoom: (lnglat: unknown, zoom: number) => void;
  enableScrollWheelZoom: () => void;
  addControl: (control: unknown) => void;
  addOverLay: (overlay: unknown) => void;
  clearOverLays: () => void;
  setViewport: (lnglats: unknown[]) => void;
  checkResize: () => void;
}

declare global {
  interface Window {
    T?: TiandituApi;
    TMAP_NORMAL_MAP?: unknown;
  }
}

export type { TiandituApi, TiandituMap, TiandituOverlay };

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
