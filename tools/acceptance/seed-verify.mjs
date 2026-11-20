/**
 * 数据准备的接口层核对（不启动浏览器）。
 *
 * 为什么单独一个文件：`--seed-only` 要在「页面矩阵不重跑」的前提下仍然证明
 * 数据真的可用——只看到建单接口返回 200 不够，得把每张单再拉一次详情、
 * 确认状态/箱子/签收人确实是夹具想表达的那件事。
 *
 * 全部只读：GET 任务详情、任务列表、箱子列表、单位人员。不写库、不改源码。
 */
import { ACCOUNTS, EAST_SIGNER, STATION } from "./seed.mjs";

/** 把接口返回的各种分页形态收敛成数组 */
function asList(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.list)) return data.list;
  if (Array.isArray(data?.records)) return data.records;
  if (Array.isArray(data?.rows)) return data.rows;
  return [];
}

export async function verifySeed(api, tasks, { log = () => {} } = {}) {
  const checks = [];
  const record = (name, ok, detail) => {
    checks.push({ name, ok, detail });
    log(`  ${ok ? "✓" : "✗"} ${name}${detail ? `（${detail}）` : ""}`);
    return ok;
  };

  /** 1. 每张建出来的单都要能拉到详情，且关键字段是夹具想表达的值 */
  for (const item of tasks.seeded) {
    try {
      const data = await api.get(`/api/v1/sample/tasks/${item.id}`);
      const task = data?.task || data || {};
      const boxCount = Array.isArray(task.boxIds) ? task.boxIds.length : (task.boxes?.length ?? null);
      record(
        `详情可读：${item.label}`,
        Boolean(task.id || task.no),
        // 服务端没有单独的业务编号字段，单号就是 TK-… 这个 id（ReportPolicy.js:326）
        `单号 ${task.no || task.id || "—"} · ${task.kind || "—"} · 状态 ${task.status || "—"} · ${boxCount ?? "?"} 台箱 · 进度 ${(task.steps || []).join("→") || "—"}`
      );
      if (item.key === "transfer") {
        // 组织简化（B4a）：调拨新建退役，transfer 键现在是划拨单（AL-，提交即生效、无签收人）
        record(
          `划拨单提交即生效（华东 3，kind=划拨/已划拨）`,
          task.kind === "划拨" && task.status === "已划拨" && String(task.toOrgId ?? "") === "3",
          `kind=${task.kind ?? "—"}、status=${task.status ?? "—"}、toOrgId=${task.toOrgId ?? "—"}（要求 3）`
        );
      }
      if (item.key === "inspect" || item.key === "back") {
        record(
          `${item.label}签收人属于检测站（13）`,
          String(task.signerId ?? "") === "5" && String(task.toOrgId ?? "") === STATION.id,
          `signerId=${task.signerId ?? "—"}、toOrgId=${task.toOrgId ?? "—"}、maxOpens=${task.maxOpens ?? "—"}`
        );
      }
    } catch (error) {
      record(`详情可读：${item.label}`, false, `${error.code || ""} ${error.message}`);
    }
  }

  /** 2. 没建出来的单，失败原因必须已经记在 failures 里（不允许静默丢） */
  const missing = ["transfer", "sample", "inspect", "back"].filter((key) => !tasks[key]);
  const unexplained = missing.filter((key) => !(tasks.failures || []).some((f) => f.key === key));
  record(
    "缺的单都有失败记录",
    unexplained.length === 0,
    missing.length
      ? `缺 ${missing.join("/")}，其中没有失败记录的：${unexplained.join("/") || "无"}`
      : "四张单全部建出"
  );

  /** 3. 任务列表和箱子列表能撑起页面（数量级核对，不写死具体值）
   * 组织简化（B4a）：任务列表默认只列 kind=采样，划拨要 allKinds=1 才一起列。 */
  try {
    const data = await api.get("/api/v1/sample/tasks?pageNum=1&pageSize=100&allKinds=1");
    const list = asList(data);
    const total = data?.total ?? list.length;
    record(
      "任务列表能看到刚建的单",
      Number(total) >= tasks.seeded.length && list.length >= tasks.seeded.length,
      `total=${total}、当页 ${list.length} 条、本次建了 ${tasks.seeded.length} 张`
    );
  } catch (error) {
    record("任务列表能看到刚建的单", false, `${error.code || ""} ${error.message}`);
  }

  try {
    const data = await api.get("/api/v1/sample/boxes?pageNum=1&pageSize=100");
    const list = asList(data);
    const total = data?.total ?? list.length;
    record("箱子列表非空", Number(total) > 0 && list.length > 0, `total=${total}、当页 ${list.length} 台`);
  } catch (error) {
    record("箱子列表非空", false, `${error.code || ""} ${error.message}`);
  }

  /** 4. 华东分公司名下确实有人员（批次 A 收紧签收人归属时的夹具样本；划拨无签收人后保留为人员样本） */
  try {
    const data = await api.get("/api/v1/users?pageNum=1&pageSize=100&deptId=31");
    const list = asList(data);
    const hit = list.find((u) => String(u.id) === EAST_SIGNER.userId || u.username === EAST_SIGNER.username);
    record(
      `华东调度室（31）下有签收人`,
      Boolean(hit),
      hit ? `${hit.nickname}（id ${hit.id}，dept ${hit.deptId ?? hit.dept_id ?? "31"}）` : `查到 ${list.length} 人，没有 id ${EAST_SIGNER.userId}`
    );
  } catch (error) {
    record("华东调度室（31）下有签收人", false, `${error.code || ""} ${error.message}`);
  }

  /** 5. admin 自己仍然能建/看采样单（防止夹具改动把主账号权限搞坏） */
  try {
    const me = await api.get("/api/v1/users/me");
    record(
      "管理员身份可用",
      String(me?.user?.username ?? me?.username ?? "") === ACCOUNTS.admin.username,
      `${me?.user?.nickname ?? me?.nickname ?? "—"}，权限 ${me?.perms?.length ?? (me?.user?.perms || []).length ?? "?"} 项`
    );
  } catch (error) {
    record("管理员身份可用", false, `${error.code || ""} ${error.message}`);
  }

  const failed = checks.filter((c) => !c.ok);
  return { checks, summary: { total: checks.length, pass: checks.length - failed.length, fail: failed.length } };
}
