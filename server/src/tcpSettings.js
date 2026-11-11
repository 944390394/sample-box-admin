/**
 * 管理端展示的接入信息。全部只读。
 * 主机名来自 SAMPLE_TCP_HOST，缺省 sample.baiyuhub.top。
 * 端口必须是服务实际 listen 得到的端口，不在这里另写一个默认端口。
 * 管理端地址来自 SAMPLE_ADMIN_URL，缺省 https://sample.baiyuhub.top，路径丢掉。
 */

export function tcpPassthroughSettings(listeningPort, env = process.env, extra = {}) {
  const configured = String(env.SAMPLE_TCP_HOST ?? "").trim();
  const address = hostnameOf(configured || "sample.baiyuhub.top");
  const portNumber = Number(listeningPort);
  const listening = Number.isInteger(portNumber) && portNumber >= 1 && portNumber <= 65535;
  return {
    mode: "TCP 透传",
    address,
    port: listening ? portNumber : null,
    hint: "不要填写路径",
    adminUrl: adminOrigin(env.SAMPLE_ADMIN_URL),
    listening,
    version: String(extra.version ?? ""),
    certExpiresAt: String(extra.certExpiresAt ?? ""),
  };
}

function adminOrigin(raw) {
  const value = String(raw ?? "").trim() || "https://sample.baiyuhub.top";
  const withScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `https://${value}`;
  try {
    const url = new URL(withScheme);
    if (!url.hostname) return "https://sample.baiyuhub.top";
    return `${url.protocol}//${url.host}`;
  } catch {
    return "https://sample.baiyuhub.top";
  }
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
