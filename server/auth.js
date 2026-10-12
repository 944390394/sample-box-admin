import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const captchas = new Map();

export function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 32).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || "").split(":");
  if (!salt || !hash) return false;
  const actual = scryptSync(password, salt, 32);
  const expected = Buffer.from(hash, "hex");
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

export function signToken(payload, secret, ttlSeconds) {
  const body = Buffer.from(
    JSON.stringify({ ...payload, exp: Date.now() + ttlSeconds * 1000 })
  ).toString("base64url");
  const signature = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${signature}`;
}

export function readToken(token, secret) {
  const [body, signature] = String(token || "").split(".");
  if (!body || !signature) return null;
  const expected = createHmac("sha256", secret).update(body).digest("base64url");
  const actualBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expected);
  if (actualBuf.length !== expectedBuf.length || !timingSafeEqual(actualBuf, expectedBuf))
    return null;
  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  if (!payload.exp || payload.exp < Date.now()) return null;
  return payload;
}

export function issueCaptcha() {
  const captchaId = randomBytes(16).toString("hex");
  const captchaCode = String(Math.floor(1000 + Math.random() * 9000));
  captchas.set(captchaId, { code: captchaCode, exp: Date.now() + 5 * 60 * 1000 });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"><rect width="120" height="40" fill="#f2f3f5"/><text x="16" y="28" font-size="24" font-family="monospace" fill="#303133">${captchaCode}</text></svg>`;
  const captchaBase64 = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
  return { captchaId, captchaBase64 };
}

export function consumeCaptcha(captchaId, captchaCode) {
  const found = captchas.get(captchaId);
  captchas.delete(captchaId);
  if (!found || found.exp < Date.now()) return false;
  return found.code === String(captchaCode || "").trim();
}
