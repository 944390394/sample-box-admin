import { writeFile } from "node:fs/promises";
import path from "node:path";

const esc = (text) => String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/** 验收报告：一页 HTML，上面是汇总，下面每项检查一张卡片，带检查明细和截图。 */
export async function writeReport(dir, results, { serverTail = [] } = {}) {
  const failed = results.filter((r) => !r.ok);
  const cards = results
    .map(
      (r, i) => `
  <section class="card ${r.ok ? "ok" : "bad"}" id="c${i + 1}">
    <header><span class="badge">${r.ok ? "通过" : "没通过"}</span><h2>${esc(r.name)}</h2><span class="role">${esc(r.role)}</span></header>
    <ul>${r.notes.map((n) => `<li class="${n.startsWith("✗") ? "x" : ""}">${esc(n)}</li>`).join("")}</ul>
    <div class="shots">${r.shots.map((s) => `<figure><a href="${s.file}" target="_blank"><img src="${s.file}" loading="lazy" alt="${esc(s.label)}"></a><figcaption>${esc(s.label)}</figcaption></figure>`).join("")}</div>
  </section>`
    )
    .join("");
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>验收报告</title>
<style>
:root { --ok:#00b42a; --bad:#f53f3f; --line:#e5e6eb; --muted:#86909c; --bg:#f5f7fa; --card:#fff; --text:#1d2129; }
@media (prefers-color-scheme: dark) { :root { --line:#2e3238; --muted:#8a919c; --bg:#0d1117; --card:#161a20; --text:#e6e8eb; } }
* { box-sizing: border-box; }
body { margin: 0; padding: 24px 16px; font: 14px/1.6 system-ui, "PingFang SC", "Microsoft YaHei", sans-serif; color: var(--text); background: var(--bg); }
main { max-width: 1200px; margin: 0 auto; }
h1 { margin: 0 0 4px; font-size: 22px; }
.sum { margin: 0 0 20px; color: var(--muted); }
.sum b.ok { color: var(--ok); } .sum b.bad { color: var(--bad); }
.toc { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 20px; }
.toc a { padding: 2px 8px; font-size: 12px; color: inherit; text-decoration: none; border: 1px solid var(--line); border-radius: 4px; }
.toc a.bad { color: var(--bad); border-color: var(--bad); }
.card { margin-bottom: 16px; padding: 16px; background: var(--card); border: 1px solid var(--line); border-left: 4px solid var(--ok); border-radius: 10px; }
.card.bad { border-left-color: var(--bad); }
header { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
h2 { margin: 0; font-size: 16px; }
.badge { padding: 0 8px; font-size: 12px; color: #fff; background: var(--ok); border-radius: 4px; }
.bad .badge { background: var(--bad); }
.role { color: var(--muted); font-size: 12px; }
ul { margin: 10px 0; padding-left: 18px; }
li.x { color: var(--bad); }
.shots { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 12px; }
figure { margin: 0; }
img { width: 100%; max-height: 360px; object-fit: cover; object-position: top; border: 1px solid var(--line); border-radius: 6px; }
figcaption { font-size: 12px; color: var(--muted); }
pre { padding: 12px; overflow-x: auto; font-size: 12px; background: var(--card); border: 1px solid var(--line); border-radius: 8px; }
</style></head><body><main>
<h1>验收报告</h1>
<p class="sum">${new Date().toLocaleString("zh-CN")} · 共 ${results.length} 项，<b class="ok">${results.length - failed.length} 项通过</b>，<b class="bad">${failed.length} 项没通过</b></p>
<nav class="toc">${results.map((r, i) => `<a href="#c${i + 1}" class="${r.ok ? "" : "bad"}">${esc(r.name)}</a>`).join("")}</nav>
${cards}
${serverTail.length ? `<h2>服务端最后输出</h2><pre>${esc(serverTail.join("\n"))}</pre>` : ""}
</main></body></html>`;
  await writeFile(path.join(dir, "index.html"), html, "utf8");
  await writeFile(path.join(dir, "results.json"), JSON.stringify(results, null, 2), "utf8");
}
