import { onActivated, onBeforeUnmount, onDeactivated, onMounted, ref } from "vue";

import type { BoxLogItem } from "@/api/sample/box";
import { AuthStorage } from "@/utils/auth";
import type { SampleBox } from "@/views/sample/data";

/** 与箱详情页内联订阅同形状：{type:"box", box, uplink?}，uplink 仅有记录权限时推送。 */
export interface SampleStreamMessage {
  type?: string;
  box?: SampleBox;
  uplink?: BoxLogItem;
}

interface SampleStreamOptions {
  /** 业务回调：连接存活期间逐条调用，消息形状与箱详情页一致。 */
  onMessage: (message: SampleStreamMessage) => void;
  /** 连接可用（首连/重连成功）：页面应停兜底轮询并补一次 catch-up。 */
  onLive?: () => void;
  /** 连接不可用（无令牌/3s 未连上/断开）：页面应启动自己的兜底轮询。 */
  onDown?: () => void;
  /** false＝不连接（mock 模式）。 */
  enabled?: boolean;
}

const CONNECT_TIMEOUT_MS = 3000;
const RETRY_MS = 5000;

/**
 * 采样箱实时通道（/api/v1/sample/stream）订阅，与箱详情页同一端点：
 * 服务端按登录人数据范围/权限逐箱推 {type:"box", box, uplink}。
 * 断开 5s 自动重连；3s 未连上通知页面退兜底轮询（onDown），连上再通知停轮询（onLive）。
 * keep-alive 失活暂停、激活重连，卸载关闭。隐藏暂停/恢复即查的刷新节奏由页面自定，
 * 这里只管连接生命周期。箱详情页的内联实现保持原样（并行波期间不动它）。
 */
export function useSampleStream(options: SampleStreamOptions) {
  const live = ref(false);

  let socket: WebSocket | null = null;
  let retryTimer = 0;
  let connectTimer = 0;
  let stopped = false;
  let deactivated = false;

  function streamUrl() {
    const token = encodeURIComponent(AuthStorage.getAccessToken());
    const base = String(import.meta.env.VITE_APP_BASE_API || "").replace(/\/$/, "");
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${window.location.host}${base}/api/v1/sample/stream?token=${token}`;
  }

  function connect() {
    if (stopped || deactivated || options.enabled === false) return;
    // 挂载＋首次激活可能各调一次：已有在连/存活的连接就不重复开
    if (
      socket &&
      (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)
    )
      return;
    window.clearTimeout(retryTimer);
    if (!AuthStorage.getAccessToken()) {
      live.value = false;
      options.onDown?.();
      return;
    }
    const current = new WebSocket(streamUrl());
    socket = current;
    window.clearTimeout(connectTimer);
    connectTimer = window.setTimeout(() => {
      if (stopped || socket !== current) return;
      if (current.readyState !== WebSocket.OPEN) options.onDown?.();
    }, CONNECT_TIMEOUT_MS);
    current.onopen = () => {
      if (socket !== current) return;
      live.value = true;
      options.onLive?.();
    };
    current.onmessage = (event) => {
      if (socket !== current) return;
      let message: SampleStreamMessage;
      try {
        message = JSON.parse(String(event.data)) as SampleStreamMessage;
      } catch {
        return;
      }
      options.onMessage(message);
    };
    current.onclose = () => {
      if (socket !== current) return;
      socket = null;
      live.value = false;
      if (stopped || deactivated) return;
      options.onDown?.();
      retryTimer = window.setTimeout(connect, RETRY_MS);
    };
  }

  function disconnect() {
    window.clearTimeout(retryTimer);
    window.clearTimeout(connectTimer);
    const current = socket;
    socket = null;
    live.value = false;
    current?.close();
  }

  onMounted(connect);
  onActivated(() => {
    deactivated = false;
    connect();
  });
  onDeactivated(() => {
    deactivated = true;
    disconnect();
  });
  onBeforeUnmount(() => {
    stopped = true;
    disconnect();
  });

  return { live };
}
