/**
 * 管理端展示的 TCP 透传入口。
 * 主机名来自 SAMPLE_TCP_HOST，缺省 sample.baiyuhub.top。
 * 端口必须是服务实际 listen 得到的端口，不在这里另写一个默认端口。
 * 只返回主机名和端口，URL 里的路径丢掉。
 */
export function tcpPassthroughSettings(listeningPort, env = process.env) {
  const configured = String(env.SAMPLE_TCP_HOST ?? "").trim();
  const address = hostnameOf(configured || "sample.baiyuhub.top");
  const port = Number(listeningPort);
  if (!address || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { address, port };
}

function hostnameOf(raw) {
  const withoutScheme = raw.replace(/^[a-z][a-z\d+.-]*:\/\//i, "");
  const hostport = withoutScheme.split(/[/?#]/)[0];
  if (!hostport) return "";
  if (hostport.startsWith("[")) {
    const end = hostport.indexOf("]");
    return end > 1 ? hostport.slice(1, end) : "";
  }
  const colon = hostport.lastIndexOf(":");
  if (colon > 0 && /^\d+$/.test(hostport.slice(colon + 1))) return hostport.slice(0, colon);
  return hostport;
}
