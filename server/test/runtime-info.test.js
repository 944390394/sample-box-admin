import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import tls from "node:tls";

import { formatCertExpiry, readDeployedCommit, readServingCertExpiry } from "../src/runtimeInfo.js";

test("证书日期取 UTC 的年月日", () => {
  assert.equal(formatCertExpiry("Jan 12 01:18:04 2027 GMT"), "2027-01-12");
  assert.equal(formatCertExpiry("not-a-date"), "");
});

test("读取连接上正在出示的证书到期日", async () => {
  const dir = mkdtempSync(join(tmpdir(), "settings-cert-"));
  const keyPath = join(dir, "key.pem");
  const certPath = join(dir, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "40",
      "-nodes",
      "-subj",
      "/CN=settings.test",
    ],
    { stdio: "ignore" }
  );
  const server = tls.createServer(
    { key: readFileSync(keyPath), cert: readFileSync(certPath) },
    (socket) => socket.end()
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const end = execFileSync("openssl", ["x509", "-in", certPath, "-noout", "-enddate"], {
      encoding: "utf8",
    });
    const expected = formatCertExpiry(end.trim().replace(/^notAfter=/, ""));
    const got = await readServingCertExpiry({
      host: "127.0.0.1",
      port: server.address().port,
      servername: "settings.test",
    });
    assert.equal(got, expected);
    assert.notEqual(got, "");
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("部署提交号读 HEAD 指向的提交", () => {
  const root = mkdtempSync(join(tmpdir(), "settings-git-"));
  const sha = "c8f4132029b1b9a20114bcd65afba0f783a4886b";
  mkdirSync(join(root, ".git", "refs", "heads"), { recursive: true });
  writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/master\n");
  writeFileSync(join(root, ".git", "refs", "heads", "master"), `${sha}\n`);
  try {
    assert.equal(readDeployedCommit(root), sha);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
