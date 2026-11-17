/**
 * 视频平台适配器：采样机构开箱时请求录像。
 * 平台还没定，接口先留成通用形式：向配置的地址 POST 一段 JSON，带 Bearer 令牌。
 * 没启用或没填地址时不发请求，状态记为「平台未接入」。以后接具体平台时只改这一个文件。
 */
export class VideoPlatform {
  constructor(readConfig, { fetchImpl = globalThis.fetch } = {}) {
    this.readConfig = readConfig;
    this.fetchImpl = fetchImpl;
  }

  /**
   * 请求录像。返回 { status, detail, url? }：
   * 平台未接入 / 已请求（平台受理，稍后回传）/ 失败。
   */
  async requestRecording(payload, override) {
    const config = override || this.readConfig();
    if (!config.enabled || !config.url)
      return { status: "平台未接入", detail: "系统设置里还没有接入视频平台" };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs || 8000);
    try {
      const response = await this.fetchImpl(config.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
        },
        body: JSON.stringify({ event: "box.opened", ...payload }),
        signal: controller.signal,
      });
      const text = (await response.text()).slice(0, 500);
      if (!response.ok)
        return { status: "失败", detail: `平台返回 ${response.status}${text ? `：${text}` : ""}` };
      let url = "";
      try {
        url = String(JSON.parse(text)?.url || "");
      } catch {
        /* 平台可以只回一个 2xx */
      }
      return { status: url ? "已完成" : "已请求", detail: "平台已受理", url };
    } catch (error) {
      const aborted = error?.name === "AbortError";
      return {
        status: "失败",
        detail: aborted ? "请求平台超时" : `请求平台失败：${error?.message || "未知错误"}`,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 预留：某一路监控的直播地址（HLS/FLV/WebRTC，看平台）。平台还没接，返回空串，
   * 页面上这一路显示「平台未接入」；部门里手填了直播地址的直接用那个。
   */
  async liveUrl() {
    return "";
  }

  /** 预留：某张任务期间的录像片段列表（开箱录像以外的整段回放）。平台还没接，返回空数组。 */
  async clips() {
    return [];
  }

  /** 设置页的「测试」：发一条 test 事件，看平台能不能通。 */
  async test(override) {
    return this.requestRecording({ test: true, openedAt: new Date().toISOString() }, override);
  }
}
