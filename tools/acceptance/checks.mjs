/**
 * 验收清单。每项写清楚：哪个角色、看哪一页、要满足什么。
 * 改了页面行为就同步改这里；新功能先在这里加一条，跑通才算做完。
 *
 * ctx：open(路由)、expect(条件, 说明)、shot(说明)、text(选择器)、noHorizontalScroll(说明)、mobile(函数)、page、tasks
 */
import { BOXES, GRANTER_ROLE, STATION } from "./seed.mjs";

const box = (key, tab = "") => `/device/boxes/${BOXES[key].imei}${tab ? `?tab=${tab}` : ""}`;

/** 菜单里的每一页：能打开、有标题、宽屏和手机都不横向滚动。 */
const PAGES = [
  ["工作台", "/monitor/home"],
  ["总览", "/monitor/overview"],
  ["单位总览（检测站）", `/monitor/overview/${STATION.id}`],
  ["任务单列表", "/task/tasks"],
  ["创建任务单", "/task/create"],
  ["采样箱列表", "/device/boxes"],
  ["实时地图", "/monitor/screen"],
  ["部门", "/system/dept"],
  ["人员", "/system/user"],
  ["角色与权限", "/system/role"],
  ["系统设置", "/system/settings"],
  ["操作日志", "/system/operation-log"],
  ["系统日志", "/system/runtime-log"],
  ["个人中心", "/profile"],
];

export const CHECKS = [
  ...PAGES.map(([name, route]) => ({
    name: `页面能打开：${name}`,
    role: "admin",
    async run({ open, expect, shot, noHorizontalScroll, mobile, page }) {
      await open(route);
      expect(!/#\/(404|401)/.test(page.url()), "没有跳到 404 或没权限页");
      expect(await page.locator(".page-container, .app-main, main").first().isVisible().catch(() => false), "页面内容显示出来了");
      await noHorizontalScroll("宽屏");
      await shot("宽屏 1440");
      await mobile(async () => {
        await noHorizontalScroll("手机 390 宽");
        await shot("手机 390", { fullPage: false });
      });
    },
  })),

  {
    name: "采样箱详情：状态条在每个标签页都在",
    role: "admin",
    async run({ open, expect, page, shot }) {
      await open(box("fresh"));
      const strip = page.locator('[data-test="summary-strip"]');
      const visible = () => strip.waitFor({ state: "visible", timeout: 10000 }).then(() => true, () => false);
      expect(await visible(), "概览上有状态条");
      for (const label of ["电量", "箱盖", "信号", "最近上报", "位置"]) {
        expect((await strip.innerText().catch(() => "")).includes(label), `状态条里有「${label}」`);
      }
      for (const tab of ["track", "event", "task", "log", "info"]) {
        await open(box("fresh", tab));
        expect(await visible(), `「${tab}」标签页也有状态条`);
      }
      await open(box("fresh"));
      await shot("GPS 新的箱子 · 概览");
    },
  },
  {
    name: "采样箱详情：GPS 过时的箱子当前位置用基站，并说明最后一次 GPS 是多久前",
    role: "admin",
    async run({ open, expect, page, shot, mobile, noHorizontalScroll }) {
      await open(box("staleGps"));
      const where = await page.locator('[data-test="summary-location"]').innerText().catch(() => "");
      expect(where.includes("基站"), `状态条的位置写的是基站（实际：${where.replace(/\s+/g, " ")}）`);
      const card = await page.locator('[data-test="location-card"]').innerText().catch(() => "");
      expect(/最后一次 GPS/.test(card), "位置卡提示最后一次 GPS 定位");
      expect(/3 天前|天前/.test(card), "写明 GPS 是几天前的");
      await shot("GPS 旧、基站新 · 概览");
      await mobile(async () => {
        await noHorizontalScroll("手机上的详情页");
        await shot("手机 390 · 概览", { fullPage: true });
      });
    },
  },
  {
    name: "采样箱详情 · 设备：分块清楚，数字取整，旧 GPS 标「旧」",
    role: "admin",
    async run({ open, expect, page, shot, text }) {
      await open(box("staleGps", "info"));
      const body = await text('[data-test="box-info"]');
      for (const title of ["身份", "归属", "运行", "电池", "定位"]) expect(body.includes(title), `有「${title}」一块`);
      expect(!/\d+\.\d{7,}/.test(body), "没有 7 位以上小数（坐标最多 6 位）");
      expect(!/4\.6999/.test(body), "速度取整，不出现 4.6999998");
      expect(/4\.7 km\/h/.test(body), "速度写成 4.7 km/h");
      const gpsRow = await page.locator('[data-test="loc-gps"]').innerText().catch(() => "");
      expect(/旧|天前/.test(gpsRow), "GPS 那一行标出已过时");
      await shot("设备信息");
    },
  },
  {
    name: "采样箱详情：只有基站、离线、待激活的箱子都能正常显示",
    role: "admin",
    async run({ open, expect, page, shot }) {
      await open(box("lbsOnly"));
      expect((await page.locator('[data-test="summary-location"]').innerText().catch(() => "")).includes("基站"), "只有基站的箱子：位置写基站");
      await shot("只有基站");
      await open(box("offline"));
      expect((await page.locator("body").innerText()).includes("离线"), "离线的箱子标「离线」");
      await shot("离线");
      await open(box("pending"));
      expect((await page.locator("body").innerText()).includes("激活"), "待激活的箱子有激活提示");
      await shot("待激活");
    },
  },
  {
    name: "采样箱列表：位置列写清来源和多久前",
    role: "admin",
    async run({ open, expect, page, shot }) {
      await open("/device/boxes");
      const row = page.locator("tr", { hasText: BOXES.staleGps.name }).first();
      const text = await row.innerText().catch(() => "");
      expect(text.includes("基站"), `GPS 旧的箱子在列表里显示基站位置（实际：${text.replace(/\s+/g, " ").slice(0, 120)}）`);
      await shot("采样箱列表");
    },
  },
  {
    name: "任务详情：箱子位置写清来源和多久前",
    role: "admin",
    async run({ open, expect, page, shot, tasks }) {
      await open(`/task/detail/${tasks.transfer}`);
      const body = await page.locator("body").innerText();
      expect(body.includes(BOXES.staleGps.name), "任务里有这台箱子");
      expect(/基站/.test(body), "GPS 旧的箱子按基站位置显示");
      await shot("调拨任务详情");
    },
  },

  {
    name: "任务单列表：进度是分步格子，待我处理是单独的小标签",
    role: "admin",
    async run({ open, expect, page, shot }) {
      await open("/task/tasks");
      const row = page.locator(".task-table tr", { hasText: "验收-调拨" }).first();
      expect((await row.locator(".steps i").count().catch(() => 0)) >= 2, "进度按步骤画成格子");
      expect((await row.locator(".todo").count().catch(() => 0)) >= 1, "能做的动作显示成「待我处理」标签");
      await shot("任务单列表");
    },
  },
  {
    name: "创建任务单：宽屏右侧有「任务摘要」，边填边更新",
    role: "admin",
    async run({ open, expect, page, shot, mobile, noHorizontalScroll }) {
      await open("/task/create");
      const summary = page.locator(".create-layout .summary");
      expect(await summary.isVisible().catch(() => false), "右侧显示任务摘要");
      expect((await summary.innerText().catch(() => "")).includes("任务摘要"), "摘要卡片有标题");
      await page.getByPlaceholder("比如：深圳仓").fill("验收-摘要联动");
      await page.waitForTimeout(300);
      expect((await summary.innerText().catch(() => "")).includes("验收-摘要联动"), "填了名称，摘要里马上显示");
      await shot("创建任务单 · 第一步");
      await mobile(async () => {
        await noHorizontalScroll("手机上的创建页");
        await shot("手机 390 · 创建任务单", { fullPage: true });
      });
      // 清掉名称，否则离开页面会弹「还没创建」的确认框，挡住后面的检查
      await page.getByPlaceholder("比如：深圳仓").fill("");
    },
  },
  {
    name: "部门、操作日志、系统日志：统一页头",
    role: "admin",
    async run({ open, expect, page }) {
      for (const [route, title] of [["/system/dept", "部门"], ["/system/operation-log", "操作日志"], ["/system/runtime-log", "系统日志"]]) {
        await open(route);
        const h1 = (await page.locator(".page-header h1").first().innerText().catch(() => "")).trim();
        expect(h1 === title, `「${title}」页用统一页头（实际：${h1 || "没有"}）`);
      }
      await open("/system/dept");
      expect(!(await page.locator(".el-descriptions").count().catch(() => 0)), "部门详情不再用带边框的表格");
      expect(await page.locator(".facts .fact").first().isVisible().catch(() => false), "部门详情用信息格子");
    },
  },
  {
    name: "人员：角色拆成一个个标签",
    role: "admin",
    async run({ open, expect, page, shot }) {
      await open("/system/user");
      const adminRow = page.locator("tr", { hasText: "admin" }).first();
      const chips = await adminRow.locator(".role-chip").allInnerTexts().catch(() => []);
      expect(chips.length >= 2, `管理员的两个角色各是一个标签（实际：${chips.join(" / ") || "没有"}）`);
      expect(!chips.some((c) => c.includes(",")), "标签里没有逗号");
      await shot("人员");
    },
  },
  {
    name: "个人中心：没有重复的卡片",
    role: "admin",
    async run({ open, expect, page, shot }) {
      await open("/profile");
      const body = await page.locator(".profile-page").innerText().catch(() => "");
      for (const gone of ["账号概览", "账号状态", "角色权限"]) expect(!body.includes(gone), `不再有「${gone}」卡片`);
      expect(body.includes("个人资料") && body.includes("安全设置"), "个人资料和安全设置都在");
      await shot("个人中心");
    },
  },

  {
    name: "权限：没有「历史轨迹」只能按任务看轨迹",
    role: "taskOnly",
    async run({ open, expect, page, shot }) {
      await open(box("fresh", "track"));
      const body = await page.locator("body").innerText();
      expect(!body.includes("24 小时"), "看不到「24 小时」");
      expect(body.includes("按任务"), "能按任务看");
      await shot("只看任务轨迹的角色");
    },
  },
  {
    name: "权限：能编辑角色但没有「给角色分配权限」时勾不了权限",
    role: "roleEditor",
    async run({ open, expect, page, shot }) {
      await open("/system/role");
      await page.getByText("调度员", { exact: true }).first().click();
      await page.waitForTimeout(800);
      const enabled = await page.locator(".perm-layout .el-checkbox:not(.is-disabled)").count().catch(() => 0);
      const all = await page.locator(".perm-layout .el-checkbox").count().catch(() => 0);
      expect(all > 0, "右侧列出了权限");
      expect(enabled === 0, `权限都勾不了（能勾的有 ${enabled} 个）`);
      await shot("角色编辑者看到的角色页");
    },
  },
  {
    name: "采样员：工作台和自己的箱子能看",
    role: "sampler",
    async run({ open, expect, shot, noHorizontalScroll, text }) {
      await open("/monitor/home");
      await noHorizontalScroll("工作台");
      await shot("采样员的工作台");
      await open(box("fresh"));
      expect((await text()).includes(BOXES.fresh.name), "能打开自己保管的箱子");
      await shot("采样员看箱子");
    },
  },
  {
    name: "调度员：任务单列表和实时地图",
    role: "dispatch",
    async run({ open, expect, shot, text }) {
      await open("/task/tasks");
      expect((await text()).includes("验收-调拨"), "看得到自己单位的调拨单");
      await shot("调度员的任务单");
      await open("/monitor/screen");
      await shot("调度员的实时地图");
    },
  },
  {
    name: "集团总览：各分公司、检测站滚动列出，检测站单列来站在途、待检测；点一行进单位总览",
    role: "admin",
    async run({ open, expect, page, shot, noHorizontalScroll, mobile }) {
      await open("/monitor/overview");
      const list = page.locator('[data-test="group-units"]');
      const text = (await list.innerText().catch(() => "")).replace(/\s+/g, " ");
      for (const name of ["总公司", "华南分公司", STATION.name]) expect(text.includes(name), `列表里有「${name}」`);
      const row = page.locator(`[data-test="unit-${STATION.id}"]`);
      const rowText = (await row.innerText().catch(() => "")).replace(/\s+/g, " ");
      expect(rowText.includes("检测站"), `检测站那一行标着「检测站」（${rowText}）`);
      const stationTiles = (await page.locator('[data-test="group-station-tiles"]').innerText().catch(() => "")).replace(/\s+/g, " ");
      expect(/已到检测站 · 未开箱检测 2/.test(stationTiles), `顶上写着已到检测站、未开箱检测 2 台（${stationTiles}）`);
      await noHorizontalScroll("宽屏");
      await shot("集团总览");
      await mobile(async () => {
        await noHorizontalScroll("手机 390 宽");
        await shot("集团总览 · 手机", { fullPage: true });
      });
      await row.click();
      await page.waitForTimeout(2000);
      expect(page.url().includes(`#/monitor/overview/${STATION.id}`), `点检测站那一行进了它的总览（${page.url().replace(/^.*#/, "#")}）`);
    },
  },
  {
    name: "检测站总览：已到未检测的箱子带本次开箱次数、超限标红；日历选今天看到送检任务",
    role: "admin",
    async run({ open, expect, page, shot, noHorizontalScroll, mobile }) {
      await open(`/monitor/overview/${STATION.id}`);
      const tiles = (await page.locator('[data-test="station-tiles"]').innerText().catch(() => "")).replace(/\s+/g, " ");
      expect(/已到 · 未开箱检测 2/.test(tiles), `已到未开箱检测 2 台（${tiles}）`);
      const waiting = (await page.locator('[data-test="station-waiting"]').innerText().catch(() => "")).replace(/\s+/g, " ");
      expect(waiting.includes(BOXES.inspectA.name) && waiting.includes(BOXES.inspectB.name), "待检测列表里有两台送检箱");
      expect(/1 次/.test(waiting) && /3 次 超限/.test(waiting), `A 开 1 次、B 开 3 次标超限（${waiting.slice(0, 160)}）`);
      const day = (await page.locator('[data-test="unit-day"]').innerText().catch(() => "")).replace(/\s+/g, " ");
      expect(day.includes("验收-送检总部"), "今天的任务里有送检单");
      expect((await page.locator('[data-test="unit-day"] .cell.picked').count()) === 1, "日历上选中了今天");
      await noHorizontalScroll("宽屏");
      await shot("检测站总览");
      await mobile(async () => {
        await noHorizontalScroll("手机 390 宽");
        await shot("检测站总览 · 手机", { fullPage: true });
      });
    },
  },
  {
    name: "检测站开始检测：任务详情逐台点「开始检测」，箱子回到在仓库；最后一台检测完任务变「已检测」",
    role: "admin",
    async run({ open, expect, page, shot, tasks, api }) {
      await open(`/task/detail/${tasks.inspect}`);
      const buttons = page.getByRole("button", { name: "开始检测", exact: true });
      expect((await buttons.count()) === 2, `两台箱子都有「开始检测」（${await buttons.count()} 个）`);
      await shot("待检测的送检单");
      await buttons.first().click();
      await page.locator(".el-message-box").getByRole("button", { name: "开始检测", exact: true }).click();
      await page.waitForTimeout(2000);
      expect((await page.getByRole("button", { name: "开始检测", exact: true }).count()) === 1, "开始检测一台后只剩一台的按钮");
      const detail = await api.get(`/api/v1/sample/tasks/${tasks.inspect}`);
      const done = detail.boxes.find((b) => b.inspectedAt);
      const mine = done ? await api.get(`/api/v1/sample/boxes/${done.id}`) : null;
      expect(mine?.life === "未使用", `开始检测的那台回到「未使用」（在仓库）（${mine?.life}）`);
      await page.getByRole("button", { name: "开始检测", exact: true }).first().click();
      await page.locator(".el-message-box").getByRole("button", { name: "开始检测", exact: true }).click();
      await page.waitForTimeout(2000);
      const after = await api.get(`/api/v1/sample/tasks/${tasks.inspect}`);
      expect(after.task.status === "已检测", `两台都开始检测后任务变「已检测」（${after.task.status}）`);
      await shot("检测完成的送检单");
      await open(`/monitor/overview/${STATION.id}`);
      const tiles = (await page.locator('[data-test="station-tiles"]').innerText().catch(() => "")).replace(/\s+/g, " ");
      expect(/今天已开箱检测 2/.test(tiles) && /未开箱检测 0/.test(tiles), `检测站总览：今天已检测 2、待检测 0（${tiles}）`);
    },
  },
  {
    name: "签收核验：开箱超限时没有「签收」，只能拒收或强制签收；拒收选退回后加上返程，寄出方只能接收退回",
    role: "admin",
    async run({ open, expect, page, shot, tasks, api }) {
      await open(`/task/detail/${tasks.back}`);
      const button = (name) => page.locator(".ops").getByRole("button", { name, exact: true });
      expect((await button("签收").count()) === 0, "核验有异常时没有「签收」按钮");
      expect((await button("强制签收").count()) === 1 && (await button("拒收").count()) === 1, "有「强制签收」和「拒收」");
      await button("拒收").click();
      const dialog = page.locator(".el-dialog");
      await dialog.waitFor({ state: "visible", timeout: 5000 });
      const text = (await dialog.innerText()).replace(/\s+/g, " ");
      expect(text.includes("签收核验有异常") && text.includes("开箱 1 次，超过上限 0 次"), `对话框列出了异常（${text.slice(0, 120)}）`);
      expect(await dialog.getByRole("checkbox").isChecked().catch(() => false), "「退回寄出单位」默认勾上");
      await shot("拒收对话框：核验异常和退回选项");
      await dialog.locator("textarea").fill("开箱次数不对，退回重新封箱");
      await dialog.getByRole("button", { name: "拒收", exact: true }).click();
      await page.waitForTimeout(2000);
      let detail = await api.get(`/api/v1/sample/tasks/${tasks.back}`);
      expect(detail.task.status === "退回中", `拒收后进入「退回中」（${detail.task.status}）`);
      expect(detail.task.steps.join(",") === "待寄出,运送中,待签收,退回中,已退回", `进度加上了返程（${detail.task.steps.join(" → ")}）`);
      expect((await button("接收退回").count()) === 1, "寄出方（管理员也在寄出单位范围内）只看到「接收退回」");
      await shot("拒收并退回后的任务单");
      await button("接收退回").click();
      await dialog.getByRole("button", { name: "接收退回", exact: true }).click();
      await page.waitForTimeout(2000);
      detail = await api.get(`/api/v1/sample/tasks/${tasks.back}`);
      const boxState = await api.get(`/api/v1/sample/boxes/${BOXES.back.imei}`);
      expect(detail.task.status === "已退回" && boxState.life === "未使用", `接收后任务「已退回」、箱子回到在仓库（${detail.task.status} / ${boxState.life}）`);
      await shot("接收退回后的任务单");
    },
  },
  {
    name: "工作台动态：同一台箱子反复上电合成一条「上电 N 次」，不再刷满整列",
    role: "admin",
    async run({ open, expect, page, shot }) {
      await open("/monitor/home");
      const feed = (await page.locator(".feed").innerText().catch(() => "")).replace(/\s+/g, " ");
      const lines = await page.locator(".feed li").allInnerTexts();
      const boots = lines.filter((t) => t.includes(BOXES.lbsOnly.name) && t.includes("上电"));
      expect(boots.length === 1, `「${BOXES.lbsOnly.name}」的上电只占一行（${boots.length} 行）`);
      expect(/上电 8 次/.test(feed), `写着「上电 8 次」（${(boots[0] || "").replace(/\s+/g, " ")}）`);
      expect(/最早/.test(boots[0] || ""), "第二行写着最早一次是什么时候");
      await shot("工作台动态合并后");
    },
  },
  {
    name: "授权界面：按页面分模块、每模块分三段；勾一项自动补前置，取消前置连带取消；只读、复制、可转授；保存前列出变更",
    role: "admin",
    async run({ open, expect, page, shot, api }) {
      await open("/system/role");
      await page.getByText(GRANTER_ROLE.name, { exact: true }).first().click();
      await page.waitForTimeout(1200);
      const editor = page.locator(".perm-editor");
      const navText = await editor.locator(".pe-nav").innerText().catch(() => "");
      for (const label of ["工作台", "任务单", "采样箱", "组织 · 部门", "组织 · 人员", "账号安全", "授权", "系统设置", "日志"]) expect(navText.includes(label), `左边目录有「${label}」`);
      const body = await editor.innerText();
      for (const tier of ["能进这页", "能看到什么", "能做什么"]) expect(body.includes(tier), `分段「${tier}」`);
      const labels = await editor.locator(".pe-label").allInnerTexts();
      expect(labels.length >= 100, `逐项列出（${labels.length} 项）`);
      const vague = labels.filter((label) => label.includes("等"));
      expect(vague.length === 0, `权限名里没有「等」${vague.length ? "：" + vague.join("、") : ""}`);
      for (const label of ["查看电量", "查看箱盖状态", "查看 ICCID", "停用采样箱", "恢复采样箱", "配置邮件服务", "配置视频平台", "配置微信小程序", "停用账号", "启用账号"]) {
        expect(labels.some((text) => text.trim() === label), `有单独的「${label}」`);
      }
      const checked = async (code) => (await page.locator(`[data-test="own-${code}"]`).getAttribute("class").catch(() => "")).includes("is-checked");
      // 点目录最后一个模块，滚下去以后目录还停在屏幕里
      await page.locator('[data-test="perm-nav-log"]').click();
      await page.waitForTimeout(900);
      const nav = await page.locator(".pe-nav").boundingBox();
      const clipped = await page.evaluate(() => {
        const out = [];
        for (let el = document.querySelector(".pe-nav")?.parentElement; el; el = el.parentElement) {
          const style = getComputedStyle(el);
          if (style.overflow !== "visible" || style.overflowY !== "visible") out.push(`${el.className || el.tagName}:${style.overflowY}`);
        }
        return out.join(" < ");
      });
      expect(nav && nav.y >= 0 && nav.y < 900, `滚到「日志」后左边目录还在屏幕里（y=${nav ? Math.round(nav.y) : "无"}；外层滚动：${clipped}）`);
      await shot("滚到最后一个模块时的目录", { fullPage: false });
      expect(await page.locator(".with-grant").count() > 0, "有「给角色分配权限」的角色显示「可转授」列");

      // 从其他角色复制，再撤销
      await page.locator('[data-test="copy-role"]').click();
      await page.locator(".el-select-dropdown__item").filter({ hasText: "验收-只看任务轨迹" }).first().click();
      await page.waitForTimeout(500);
      expect(await checked("device:box:task"), "复制「只看任务轨迹」后带上了「查看任务单」");
      await page.getByRole("button", { name: "撤销" }).click();
      await page.waitForTimeout(300);
      expect(!(await checked("device:box:task")), "撤销后恢复原样");

      // 勾「编辑部门基本信息」自动勾上「查看部门」
      await page.locator('[data-test="perm-nav-dept"]').click();
      await page.waitForTimeout(500);
      await page.locator('[data-test="own-sys:dept:update"]').click();
      await page.waitForTimeout(300);
      expect(await checked("sys:dept:view"), "勾「编辑部门基本信息」自动勾上「查看部门」");
      await shot("勾一项自动补上前置");
      // 取消「查看部门」：提示依赖它的项会一起取消
      await page.locator('[data-test="own-sys:dept:view"]').click();
      const box = page.locator(".el-message-box");
      await box.waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(300);
      expect((await box.innerText().catch(() => "")).includes("编辑部门基本信息"), "取消前置时列出会一起取消的项");
      await box.getByRole("button", { name: "一起取消" }).click();
      await page.waitForTimeout(300);
      expect(!(await checked("sys:dept:update")) && !(await checked("sys:dept:view")), "确认后两项一起取消");

      // 采样箱模块「只读」：能看到的都勾上，操作不勾
      await page.locator('[data-test="quick-read-box"]').click();
      await page.waitForTimeout(300);
      expect(await checked("device:box:power"), "只读勾上「查看电量」");
      expect(!(await checked("device:box:rename")), "只读不勾「修改采样箱名称」");
      // 可转授
      await page.locator('[data-test="pass-device:box:list"]').click();
      const bar = await page.locator('[data-test="save-bar"]').innerText();
      expect(/新增 \d+ 项/.test(bar) && bar.includes("可转授变化"), `保存栏写清改了什么（${bar.replace(/\s+/g, " ")}）`);
      await page.locator('[data-test="save-perms"]').click();
      await page.waitForTimeout(400);
      const confirmText = await page.locator(".el-dialog").filter({ hasText: "确认保存权限" }).innerText().catch(() => "");
      expect(confirmText.includes("采样箱") && confirmText.includes("查看电量") && confirmText.includes("开可转授"), "确认框按模块列出新增和可转授变化");
      await shot("保存前确认变更");
      await page.locator('[data-test="confirm-save"]').click();
      await page.waitForTimeout(1200);
      const saved = await api.get(`/api/v1/roles/${GRANTER_ROLE.id}/perms`);
      expect(saved.codes.includes("device:box:power") && !saved.codes.includes("device:box:rename"), "保存后服务端是只读的那几项");
      expect(saved.grantOption.includes("device:box:list"), "保存后「查看采样箱清单」可转授");
      await page.locator(".pe-search input").fill("轨迹");
      await page.waitForTimeout(300);
      expect(await page.locator(".perm-editor mark").count() > 0, "搜索时命中的字高亮");
      await shot("搜索「轨迹」");
      await page.locator(".pe-search input").fill("");
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(500);
      const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(over <= 1, `手机宽度不横向滚动${over > 1 ? `（多出 ${over}px）` : ""}`);
      await shot("手机宽度的授权界面", { fullPage: false });
      await page.setViewportSize({ width: 1440, height: 900 });
    },
  },
  {
    name: "部门上限：华南单独限制、收回「删除人员」；下级调度室勾不了上级没有的项",
    role: "admin",
    async run({ open, expect, page, shot, api }) {
      await open("/system/dept");
      await page.locator(".el-tree-node__content, .el-tree-v2 .el-tree-node").filter({ hasText: "华南分公司" }).first().click();
      await page.waitForTimeout(600);
      await page.getByRole("tab", { name: "权限上限" }).click();
      await page.waitForTimeout(1200);
      await page.locator('[data-test="limit-mode"]').getByText("单独限制").click();
      await page.waitForTimeout(400);
      await page.locator('[data-test="own-sys:user:delete"]').scrollIntoViewIfNeeded();
      await page.locator('[data-test="own-sys:user:delete"]').click();
      await page.waitForTimeout(300);
      // 滚到中间的模块后，左边目录还停在卡片里
      const nav = await page.locator('[data-test="dept-limit"] .pe-nav').boundingBox();
      expect(nav && nav.y >= 0 && nav.y < 900, `滚动后左边目录还在屏幕里（y=${nav ? Math.round(nav.y) : "无"}）`);
      await shot("华南：单独限制，去掉「删除人员」");
      await page.locator('[data-test="save-limit"]').click();
      await page.locator(".el-message-box").getByRole("button", { name: "保存" }).click();
      await page.waitForTimeout(1200);
      const limit = await api.get("/api/v1/depts/2/limit");
      expect(limit.limited && !limit.perms.includes("sys:user:delete") && limit.perms.length > 50, `华南存成单独限制，不含「删除人员」（${limit.perms.length} 项）`);

      // 下级：上级没有的项默认收起，展开后灰着、写明原因
      await page.locator(".el-tree-node__content, .el-tree-v2 .el-tree-node").filter({ hasText: "调度室" }).first().click();
      await page.waitForTimeout(600);
      await page.getByRole("tab", { name: "权限上限" }).click();
      await page.waitForTimeout(1200);
      await page.locator('[data-test="limit-mode"]').getByText("单独限制").click();
      await page.waitForTimeout(400);
      expect((await page.locator('[data-test="own-sys:user:delete"]').count()) === 0, "调度室里看不到上级没有的「删除人员」");
      await page.locator('[data-test="show-outside"]').click();
      await page.waitForTimeout(300);
      const cls = (await page.locator('[data-test="own-sys:user:delete"]').getAttribute("class").catch(() => "")) || "";
      expect(cls.includes("is-disabled"), "展开后「删除人员」灰着勾不了");
      await page.locator('.pe-row[data-code="sys:user:delete"]').scrollIntoViewIfNeeded();
      await shot("调度室：上级没有的项灰着");
      await page.locator('[data-test="limit-mode"]').getByText("跟上级一样").click();
    },
  },
  {
    name: "人员实际权限：每项写清来自哪个角色，被部门上限挡住的写明哪个部门",
    role: "admin",
    async run({ open, expect, page, shot }) {
      await open("/system/user?deptId=21");
      await page.locator('[data-test="eff-accept.south"]').click();
      await page.waitForTimeout(1200);
      const drawer = page.locator(".eff-drawer");
      expect((await drawer.innerText()).includes("所在部门这条线的上限"), "列出部门这条线");
      await drawer.getByText("被挡住的", { exact: true }).click();
      await page.waitForTimeout(300);
      const cut = await drawer.innerText();
      expect(cut.includes("删除人员") && cut.includes("华南分公司"), "「删除人员」写明被华南分公司的上限挡住");
      await drawer.getByText("能用的", { exact: true }).click();
      await page.waitForTimeout(300);
      expect((await drawer.innerText()).includes("来自 验收-人员管理"), "能用的写明来自哪个角色");
      await shot("实际权限抽屉");
    },
  },
  {
    name: "部门上限生效：华南收回「删除人员」后，华南的人在人员页看不到「删除」",
    role: "southPeople",
    async run({ open, expect, page, shot }) {
      await open("/system/user");
      const more = page.getByRole("button", { name: "更多" }).first();
      expect(await more.isVisible().catch(() => false), "有「更多」菜单（能停用账号）");
      await more.click();
      await page.waitForTimeout(300);
      const items = await page.locator(".el-dropdown-menu:visible").innerText().catch(() => "");
      expect(items.includes("停用账号"), "能停用账号");
      expect(!items.includes("删除"), `没有「删除」（菜单：${items.replace(/\s+/g, " ")}）`);
      await shot("华南的人：更多菜单里没有删除");
    },
  },
  {
    name: "工作台卡片逐张开关：收回调度员的「告警」卡片，工作台就不给这张",
    role: "dispatch",
    async run({ open, expect, page, shot, api }) {
      const roles = await api.get("/api/v1/roles?pageNum=1&pageSize=200");
      const dispatch = roles.list.find((role) => role.code === "DISPATCH");
      const before = await api.get(`/api/v1/roles/${dispatch.id}/perms`);
      // 同一个地址再 open 不会重新取数，第二次刷新页面
      let opened = false;
      const read = async () => {
        const wait = page.waitForResponse((res) => res.url().includes("/api/v1/sample/workbench"), { timeout: 20000 });
        if (opened) await page.reload({ waitUntil: "domcontentloaded" });
        else await open("/monitor/home");
        opened = true;
        return (await (await wait).json()).data;
      };
      try {
        const first = await read();
        expect(first.cards.includes("monitor:card:alert") && "alert" in first.boxTodo, "原来有「告警」卡片");
        await api.put(`/api/v1/roles/${dispatch.id}/perms`, { codes: before.codes.filter((code) => code !== "monitor:card:alert"), grantOption: before.grantOption });
        const second = await read();
        expect(!second.cards.includes("monitor:card:alert") && !("alert" in second.boxTodo), "收回后服务端不给「告警」卡片");
        expect("offline" in second.boxTodo, "别的卡片照常");
        await shot("调度员工作台：没有告警卡片");
      } finally {
        await api.put(`/api/v1/roles/${dispatch.id}/perms`, { codes: before.codes, grantOption: before.grantOption });
      }
    },
  },
  {
    name: "分公司的人打开总览直接进自己单位",
    role: "dispatch",
    async run({ open, expect, page, shot }) {
      await open("/monitor/overview");
      await page.waitForTimeout(1500);
      expect(page.url().includes("#/monitor/overview/2"), `调度员进的是华南分公司（${page.url().replace(/^.*#/, "#")}）`);
      const head = (await page.locator(".page-header, header").first().innerText().catch(() => "")).replace(/\s+/g, " ");
      expect(head.includes("华南分公司"), `标题是华南分公司（${head.slice(0, 60)}）`);
      await shot("调度员的单位总览");
    },
  },
  {
    name: "时间每秒刷新：刚上报的箱子「最近上报」按秒往上走，列表和位置里的「x 秒前」也跟着走",
    role: "admin",
    async run({ sendUplinks, open, expect, page, shot }) {
      await sendUplinks();
      await open(box("fresh"));
      const last = page.locator('[data-test="summary-last"]');
      await last.waitFor({ state: "visible", timeout: 10000 });
      // 等到出现「x 秒前」（10 秒内显示「刚刚」）
      let first = "";
      for (let i = 0; i < 15 && !/秒前/.test(first); i++) {
        await page.waitForTimeout(1000);
        first = (await last.innerText().catch(() => "")).trim();
      }
      await page.waitForTimeout(2300);
      const second = (await last.innerText().catch(() => "")).trim();
      const n1 = Number((first.match(/(\d+) 秒前/) || [])[1]);
      const n2 = Number((second.match(/(\d+) 秒前/) || [])[1]);
      expect(/秒前/.test(first), `显示成「x 秒前」（${first}）`);
      expect(n2 - n1 >= 2 && n2 - n1 <= 3, `2 秒多以后跟着走了 2～3 秒（${first} → ${second}），不用等页面重新拉数据`);
      const where = (await page.locator('[data-test="summary-location"]').innerText().catch(() => "")).trim();
      expect(/秒前|分钟前|刚刚/.test(where), `位置那一格也写着多久前（${where.replace(/\s+/g, " ")}）`);
      await shot("最近上报按秒走");
    },
  },
  {
    name: "电量曲线：7 天每 5 分钟都有数据，合并后是一条连着的线，只在停报处断开",
    role: "admin",
    async run({ api, open, expect, page, shot }) {
      const pad = (n) => String(n).padStart(2, "0");
      const stamp = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
      const to = new Date();
      const from = new Date(to.getTime() - 7 * 86400000);
      const points = await api.get(`/api/v1/sample/boxes/${BOXES.fresh.imei}/battery?from=${encodeURIComponent(stamp(from))}&to=${encodeURIComponent(stamp(to))}`);
      const real = points.filter((p) => !p.gap).length;
      const gaps = points.filter((p) => p.gap).length;
      expect(real >= 200, `7 天有足够的点（${real} 个）`);
      expect(gaps >= 1 && gaps <= 2, `只在停报的地方断开（断开 ${gaps} 处）`);
      const charging = points.filter((p) => p.charge === 1 || p.charge === 2).length;
      expect(charging >= 3, `充电那段的点带着充电状态（${charging} 个），页面才能画出绿色底色`);
      await open(box("fresh"));
      await page.getByRole("radio", { name: "7 天" }).click({ force: true }).catch(() => page.getByText("7 天", { exact: true }).click());
      await page.waitForTimeout(1500);
      await page.locator(".battery-card").scrollIntoViewIfNeeded().catch(() => {});
      await shot("7 天电量曲线");
    },
  },
  {
    name: "USB 串口读取：从采样箱列表进去，有连接按钮和使用步骤，手机宽度不横向滚动",
    role: "admin",
    async run({ open, expect, page, shot, noHorizontalScroll, mobile }) {
      await open("/device/boxes");
      const entry = page.getByRole("button", { name: /USB 串口读取/ });
      expect(await entry.isVisible().catch(() => false), "采样箱列表页头有「USB 串口读取」");
      await entry.click();
      await page.waitForTimeout(2500);
      expect(page.url().includes("#/device/serial"), `点了以后进到串口读取页（实际：${page.url().replace(/^.*#/, "#")}）`);
      await open("/device/serial");
      // 机器人用的 Edge 在 localhost 上支持 Web Serial，应该看到连接卡片而不是「不支持」
      expect(!(await page.locator('[data-test="serial-unsupported"]').isVisible().catch(() => false)), "Edge 上没有提示「不支持」");
      expect(await page.getByRole("button", { name: /连接设备/ }).isVisible().catch(() => false), "有「连接设备」按钮");
      const steps = await page.locator('[data-test="serial-connect"]').innerText().catch(() => "");
      expect(steps.includes("CH340"), "使用步骤里写了要选 CH340");
      expect((await page.locator('[data-test="serial-queue"]').innerText().catch(() => "")).includes("连接后自动读取"), "没连接时未同步记录一块写着连接后自动读取");
      await noHorizontalScroll("宽屏");
      await shot("USB 串口读取 · 宽屏");
      await mobile(async () => {
        await noHorizontalScroll("手机 390 宽");
        await shot("USB 串口读取 · 手机", { fullPage: true });
      });
    },
  },
];
