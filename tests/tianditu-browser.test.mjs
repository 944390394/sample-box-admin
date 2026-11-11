import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

test("browser waits for asynchronous service module, deduplicates, serializes and retries failures", async () => {
  const previous = globalThis.window;
  const api = { Map: class {}, Marker: class {}, InfoWindow: class {}, LngLat: class {} };
  globalThis.window = { T: api, setTimeout, clearTimeout, setInterval, clearInterval };
  let calls = 0,
    active = 0,
    maxActive = 0,
    fail = false;
  const code = ts
    .transpileModule(readFileSync(new URL("../src/utils/tianditu.ts", import.meta.url), "utf8"), {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    })
    .outputText.replaceAll(
      "import.meta.env",
      '({VITE_TIANDITU_TK:"test-key",VITE_TIANDITU_SK:"test-security"})'
    );
  try {
    const mod = await import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));
    const first = mod.resolveChineseAddress(114.115, 22.67923);
    const duplicate = mod.resolveChineseAddress(114.115, 22.67923);
    setTimeout(() => {
      api.Geocoder = class {
        getLocation(point, cb) {
          calls++;
          maxActive = Math.max(maxActive, ++active);
          setTimeout(() => {
            active--;
            cb({
              getStatus: () => (fail ? 1 : 0),
              getMsg: () => "service unavailable",
              getAddress: () => "广东省深圳市龙岗区",
            });
          }, 5);
        }
      };
    }, 20);
    const results = await Promise.all([first, duplicate]);
    assert.ok(results.every((r) => r.status === "resolved"));
    assert.equal(calls, 1);
    await Promise.all([
      mod.resolveChineseAddress(114.12, 22.68),
      mod.resolveChineseAddress(114.13, 22.68),
    ]);
    assert.equal(maxActive, 1);
    fail = true;
    assert.equal((await mod.resolveChineseAddress(114.14, 22.68)).status, "error");
    fail = false;
    assert.equal((await mod.resolveChineseAddress(114.14, 22.68)).status, "resolved");
    assert.equal((await mod.resolveChineseAddress(NaN, 22)).status, "error");
  } finally {
    globalThis.window = previous;
  }
});
