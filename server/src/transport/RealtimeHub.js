/**
 * 进程内订阅。一台 API 上的 WebSocket 都挂在这里。
 * 箱子状态变化时同步调用监听器，监听器自己负责写套接字。
 */
export class RealtimeHub {
  constructor() {
    this.listeners = new Set();
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(box) {
    for (const listener of this.listeners) listener(box);
  }
}
