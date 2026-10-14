import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import tls from "node:tls";

/** 把证书 notAfter 收成 UTC 日期。读不到就给空字符串，不写死某一天。 */
export function formatCertExpiry(validTo) {
  const date = new Date(validTo);
  if (Number.isNaN(date.getTime())) return "";
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${date.getUTCFullYear()}-${month}-${day}`;
}

/**
 * 读取本机正在对外提供的 sample.baiyuhub.top 证书到期日。
 * 连 127.0.0.1:443 并带上这个域名的 SNI，拿到的是站点当前出示的那张证。
 */
export function readServingCertExpiry(options = {}) {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 443;
  const servername = options.servername ?? "sample.baiyuhub.top";
  return new Promise((resolveExpiry) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolveExpiry(value);
    };
    const socket = tls.connect(
      { host, port, servername, rejectUnauthorized: false, timeout: 4000 },
      () => {
        const cert = socket.getPeerCertificate();
        socket.end();
        finish(cert?.valid_to ? formatCertExpiry(cert.valid_to) : "");
      }
    );
    socket.on("error", () => finish(""));
    socket.on("timeout", () => {
      socket.destroy();
      finish("");
    });
  });
}

/** 当前部署目录的提交号。不是 git 仓库时返回空字符串。 */
export function readDeployedCommit(root) {
  try {
    const gitPath = resolve(root, ".git");
    if (!existsSync(gitPath)) return "";
    const gitDir = resolveGitDir(gitPath);
    if (!gitDir) return "";
    const head = readFileSync(resolve(gitDir, "HEAD"), "utf8").trim();
    if (!head.startsWith("ref: ")) return commitOf(head);
    const refPath = resolve(gitDir, head.slice(5).trim());
    if (!existsSync(refPath)) return "";
    return commitOf(readFileSync(refPath, "utf8").trim());
  } catch {
    return "";
  }
}

function resolveGitDir(gitPath) {
  if (existsSync(resolve(gitPath, "HEAD"))) return gitPath;
  const text = readFileSync(gitPath, "utf8").trim();
  const match = text.match(/^gitdir:\s*(.+)$/);
  if (!match) return "";
  return isAbsolute(match[1]) ? match[1] : resolve(gitPath, "..", match[1]);
}

function commitOf(value) {
  return /^[0-9a-f]{40}$/i.test(value) ? value : "";
}
