/**
 * 进程内事件流。
 * 监听器按订阅顺序执行，一个失败不会挡住后面的，也不会把已提交的写入再回滚。
 */
export class EventStream {
  constructor() {
    this.listeners = [];
  }

  subscribe(listener) {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((item) => item !== listener);
    };
  }

  async publish(event) {
    for (const listener of [...this.listeners]) {
      try {
        await listener(event);
      } catch (error) {
        console.error("事件处理失败", error instanceof Error ? error.message : error);
      }
    }
  }
}
