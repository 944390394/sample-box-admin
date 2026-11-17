import test from "node:test";
import assert from "node:assert/strict";
import {
  parseGeocoderResponse,
  reverseAddress,
  TiandituGeocoder,
} from "../src/geo/TiandituGeocoder.js";

const text =
  'var tdt_loadResult={"status":"0","result":{"formatted_address":"广东省深圳市龙岗区平湖街道恒路物流创新广场"}};';
test("official SDK wrapper is parsed as JSON only, including numeric zero status", async () => {
  assert.equal(parseGeocoderResponse(text).status, "0");
  assert.equal(parseGeocoderResponse('{"status":0}').status, 0);
  assert.throws(() => parseGeocoderResponse("var tdt_loadResult={}; evil();"), /格式/);
  const result = await reverseAddress(
    "app-key",
    114.115,
    22.67923,
    async (url) => {
      const outer = new URL(url);
      assert.equal(outer.pathname, "/apiserver/ajaxproxy");
      const inner = new URL(decodeURIComponent(outer.searchParams.get("proxyReqUrl")));
      assert.equal(inner.searchParams.get("tk"), "app-key");
      assert.equal(inner.searchParams.get("sk"), "security-key");
      assert.equal(inner.searchParams.has("sign"), false);
      return { ok: true, text: async () => text };
    },
    "security-key"
  );
  assert.match(result, /深圳市/);
});
test("provider failures are distinguishable from empty address and do not expose credentials", async () => {
  await assert.rejects(
    reverseAddress("secret", 114, 22, async () => ({ ok: false, status: 403 })),
    /HTTP 403/
  );
  await assert.rejects(
    reverseAddress("secret", 114, 22, async () => {
      throw new Error("https://api?tk=secret");
    }),
    (error) => !error.message.includes("secret")
  );
  assert.equal(
    await reverseAddress("key", 114, 22, async () => ({
      ok: true,
      text: async () => 'var tdt_loadResult={"status":"0","result":{}};',
    })),
    ""
  );
});
test("concurrent coordinates share one request; failed lookups can retry after cooldown", async () => {
  let calls = 0,
    fail = true;
  const g = new TiandituGeocoder("key", async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 5));
    if (fail) throw new Error("offline");
    return { ok: true, text: async () => text };
  });
  const first = await Promise.allSettled([g.lookup(114, 22), g.lookup(114, 22)]);
  assert.equal(calls, 1);
  assert.ok(first.every((x) => x.status === "rejected"));
  assert.equal(await g.lookup(114, 22), "");
  assert.equal(calls, 1);
  g.retryAt.clear();
  fail = false;
  assert.match(await g.lookup(114, 22), /深圳/);
  assert.equal(calls, 2);
  assert.match(await g.lookup(114, 22), /深圳/);
  assert.equal(calls, 2);
});
