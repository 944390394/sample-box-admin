import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const code = ts.transpileModule(
  readFileSync(new URL("../src/views/sample/boxes/telemetry.ts", import.meta.url), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }
).outputText;
const { telemetryState } = await import(
  "data:text/javascript;base64," + Buffer.from(code).toString("base64")
);

test("report timeout freezes the snapshot clock and a new report restores live time", () => {
  const last = "2026-10-27 07:29:07.405";
  const at = new Date("2026-10-27T07:29:07.405").getTime();
  assert.equal(telemetryState(last, 60, at + 179999).online, true);
  const offline = telemetryState(last, 60, at + 180000);
  assert.equal(offline.online, false);
  assert.equal(offline.referenceTime, at);
  assert.equal(telemetryState(last, 60, at + 8 * 3600000).referenceTime, at);
  const recovered = telemetryState("2026-10-27 15:29:07.405", 60, at + 8 * 3600000 + 1000);
  assert.equal(recovered.online, true);
  assert.equal(recovered.referenceTime, at + 8 * 3600000 + 1000);
});

test("missing reports stay unknown and timeout follows the configured report period", () => {
  for (const last of [undefined, "", "invalid"]) {
    const state = telemetryState(last, 60, Date.now());
    assert.equal(state.hasReport, false);
    assert.equal(state.online, false);
    assert.ok(Number.isNaN(state.referenceTime));
  }
  const last = "2026-10-27 07:29:07";
  const at = new Date("2026-10-27T07:29:07").getTime();
  assert.equal(telemetryState(last, 5, at + 15000).online, false);
  assert.equal(telemetryState(last, 300, at + 899999).online, true);
  assert.equal(telemetryState(last, 300, at + 900000).online, false);
  assert.equal(telemetryState(last, undefined, at + 179999).online, true);
});
