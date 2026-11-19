/**
 * 接口兜底分支的错误口径（体检编号 L-P1-8）。
 *
 * 修复前 index.js 把 error.message 原样回给客户端：SQL 语法错误、JSON 解析失败、
 * 第三方库的英文报错都跟着外泄，而且一律 500。
 * 现在只有带码的错误（domain/AppError，或手工带 publicCode + httpStatus 的对象）能带原文出去，
 * 未知异常统一 B0001 + 固定文案。
 *
 * 这里同时守住：校验类错误确实带了码（回 400 不是 500），前端能按码分辨。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { errorResponse } from "../src/http/errorResponse.js";
import { AppError, badRequest, conflict } from "../src/domain/AppError.js";
import { mergeBoxSettings } from "../src/settings/boxConfig.js";

test("带码的错误按码回，文案照给", () => {
  const typed = errorResponse(badRequest("上报周期要在 5 到 3600 秒之间"));
  assert.deepEqual(typed, { code: "A0400", status: 400, message: "上报周期要在 5 到 3600 秒之间" });
  // 现有控制器里手工带的 { publicCode, httpStatus } 也算带码
  assert.deepEqual(errorResponse({ publicCode: "A0404", httpStatus: 404, message: "看不到" }), {
    code: "A0404",
    status: 404,
    message: "看不到",
  });
  assert.equal(errorResponse(conflict("任务状态已改变，请刷新后重试")).status, 409);
  assert.ok(new AppError("A0409", 409, "x") instanceof Error, "仍是 Error，catch 得住");
});

test("未知异常只回固定文案，原文不外泄", () => {
  const internal = new Error("SqliteError: no such column: password_hash");
  const out = errorResponse(internal);
  assert.equal(out.code, "B0001");
  assert.equal(out.status, 500);
  assert.ok(!out.message.includes("password_hash"), "内部字段名泄出去了");
  assert.ok(!out.message.includes("SqliteError"), "驱动报错泄出去了");
  // JSON 解析、空引用这类真正的内部错误同样只回固定文案
  for (const error of [
    new SyntaxError("Unexpected token < in JSON at position 0"),
    new TypeError("Cannot read properties of undefined (reading 'body')"),
    new Error("ER_NOT_READ_ONLY: reading from the middle of a transaction"),
    { message: "手工造的对象：没有码" },
    null,
  ]) {
    const res = errorResponse(error);
    assert.equal(res.code, "B0001", String(error?.message));
    assert.equal(res.status, 500);
    assert.equal(res.message, "系统出错，请稍后再试或联系管理员");
  }
});

test("设置类校验抛的是带码错误，回 400 不是 500", () => {
  for (const input of [{ reportPeriodSec: 1 }, { batteryReserve: 99 }]) {
    let caught;
    try {
      mergeBoxSettings({}, input);
    } catch (error) {
      caught = error;
    }
    assert.ok(caught, `${JSON.stringify(input)} 竟然通过了校验`);
    const res = errorResponse(caught);
    assert.equal(res.code, "A0400", caught.message);
    assert.equal(res.status, 400);
    assert.ok(res.message, "校验错误要给用户看文案");
  }
});
