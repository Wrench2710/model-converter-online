import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const output = process.env.SMOKE_OUTPUT || "/tmp/modeldesk-layout-smoke";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  channel: "chrome", headless: true,
  args: ["--enable-webgl", "--use-angle=swiftshader", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"],
});
try {
  const failures = [];
  for (const width of process.env.LAYOUT_WIDTH ? [Number(process.env.LAYOUT_WIDTH)] : [1440, 1100, 980, 768, 640, 390, 320]) {
    const page = await browser.newPage({ viewport: { width, height: width === 320 ? 568 : 844 } });
    await page.addInitScript(() => {
      localStorage.setItem("modeldesk.access", "layout-memory-access");
      localStorage.setItem("modeldesk.locale", "zh");
    });
    await page.routeWebSocket("**/ws/**", () => {});
    const tasks = [];
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      const json = (data) => route.fulfill({ contentType: "application/json", body: JSON.stringify(data) });
      if (path === "/api/auth/me/") return json({ id: 1, username: "layout@example.com" });
      if (path === "/api/files/") return json([]);
      if (path === "/api/tasks/") return json(tasks);
      if (path === "/api/files/upload/") {
        const data = await new Request("http://memory.local", {
          method: "POST", headers: request.headers(), body: request.postDataBuffer(),
        }).formData();
        const task = {
          id: `layout-${tasks.length}`, source_file: { id: "layout-source", original_name: data.get("file").name, extension: "obj", size_bytes: 50 },
          target_format: "glb", status: "running", progress: 25, artifact_url: null, preview_url: null,
          assets: [], dimensions: {}, triangle_count: null, error_message: "", created_at: "2026-10-15T00:00:00Z",
        };
        tasks.push(task);
        return json(task);
      }
      throw new Error(`Unexpected API call: ${path}`);
    });
    await page.goto(process.env.SMOKE_URL || "http://localhost");
    await page.getByLabel("选择文件", { exact: true }).waitFor();
    const fillsPreviewPane = async () => {
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const boxes = await page.evaluate(() => ({
        preview: document.querySelector(".preview-shell").getBoundingClientRect().toJSON(),
        pane: document.querySelector(".right-column").getBoundingClientRect().toJSON(),
      }));
      assert.ok(Math.abs(boxes.preview.height - boxes.pane.height) <= 1 &&
        Math.abs(boxes.preview.y - boxes.pane.y) <= 1,
      `${width}px preview must fill its pane by default: preview=${boxes.preview.height}, pane=${boxes.pane.height}`);
    };
    await fillsPreviewPane();
    const snapshot = async () => {
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      return page.evaluate(() => {
        const list = document.querySelector(".left-column");
        const selectors = [
          ".topbar", ".workspace-grid", ".left-column", ".upload-card", ".section-heading",
          ".section-hint", ".pending-list", ".pending-row", ".pending-select", ".pending-controls",
          ".pending-controls select", ".pending-actions", "[data-testid=conversion-queue]", ".task-row", ".task-row .task-copy",
          ".preview-toolbar", ".stats-row",
        ];
        return Object.fromEntries(selectors.filter((selector) => document.querySelector(selector)).map((selector) => {
          const element = document.querySelector(selector);
          const rect = element.getBoundingClientRect();
          const insideList = list.contains(element);
          return [selector, {
            x: rect.x, y: rect.y + (insideList ? list.scrollTop : 0),
            width: rect.width, height: rect.height,
          }];
        }));
      });
    };
    const compare = (before, after, action) => {
      for (const selector of Object.keys(before)) {
        if (action === "expand" && [".preview-toolbar", ".stats-row"].includes(selector)) continue;
        for (const dimension of ["x", "y", "width", "height"]) {
          if (Math.abs(before[selector][dimension] - after[selector][dimension]) > 1) {
            failures.push(`${width}px ${action}: ${selector} ${dimension} ${before[selector][dimension].toFixed(1)} -> ${after[selector][dimension].toFixed(1)}`);
          }
        }
      }
    };
    const emptyChinese = await snapshot();
    await page.locator(".language-switch button").filter({ hasText: "EN" }).click();
    compare(emptyChinese, await snapshot(), "empty locale");
    await page.locator(".language-switch button").filter({ hasText: "中" }).click();
    await page.getByLabel("选择文件", { exact: true }).setInputFiles(
      Array.from({ length: 5 }, (_, index) => ({
        name: `model-${index}.obj`, mimeType: "application/octet-stream",
        buffer: Buffer.from("v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n"),
      })),
    );
    await page.getByRole("button", { name: "开始转换", exact: true }).first().click();
    await page.locator("[data-testid=conversion-queue] .task-row").waitFor();
    await page.getByRole("button", { name: "预览 model-1.obj", exact: true }).click();
    await page.waitForFunction(() => document.querySelector(".preview-shell")?.dataset.previewState === "ready");
    await fillsPreviewPane();
    await page.screenshot({ path: `${output}/default-${width}.png`, fullPage: true });
    const listBeforeMaterials = await snapshot();
    await page.getByRole("button", { name: "附加贴图 model-1.obj", exact: true }).click();
    await page.getByRole("button", { name: "关闭材质面板", exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "区域全屏预览", exact: true }).getAttribute("aria-expanded"), "false");
    assert.ok(await page.locator(".preview-shell").evaluate((element) =>
      element.getBoundingClientRect().height < element.parentElement.clientHeight), "Material editing must use the compact preview");
    await page.getByRole("button", { name: "关闭材质面板", exact: true }).click();
    await fillsPreviewPane();
    const afterMaterials = await snapshot();
    for (const selector of [".left-column", ".pending-list", "[data-testid=conversion-queue]"]) {
      for (const dimension of ["x", "width"]) {
        assert.ok(Math.abs(listBeforeMaterials[selector][dimension] - afterMaterials[selector][dimension]) <= 1,
          `${width}px material panel changed ${selector} ${dimension}`);
      }
    }
    await page.getByRole("button", { name: "退出区域全屏", exact: true }).click();
    const canvas = await page.locator(".viewport canvas").elementHandle();
    await page.locator(".language-switch button").filter({ hasText: "EN" }).click();
    const english = await snapshot();
    await page.screenshot({ path: `${output}/english-${width}.png`, fullPage: true });
    await page.locator(".language-switch button").filter({ hasText: "中" }).click();
    const chinese = await snapshot();
    compare(english, chinese, "locale");
    assert.ok(await canvas.evaluate((element) => element === document.querySelector(".viewport canvas")), "Locale changes must preserve the model scene");
    await page.screenshot({ path: `${output}/normal-${width}.png`, fullPage: true });
    await page.getByRole("button", { name: "区域全屏预览", exact: true }).click();
    compare(chinese, await snapshot(), "expand");
    await page.locator(".language-switch button").filter({ hasText: "EN" }).click();
    const expandedEnglish = await snapshot();
    await page.locator(".language-switch button").filter({ hasText: "中" }).click();
    compare(expandedEnglish, await snapshot(), "expanded locale");
    await page.screenshot({ path: `${output}/expanded-${width}.png`, fullPage: true });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width}px horizontal overflow`);
    await page.keyboard.press("Escape");
    compare(chinese, await snapshot(), "collapse");
    const left = page.locator(".left-column");
    await left.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await page.locator("[data-testid=conversion-queue] .task-row").click();
    const scrollTop = await left.evaluate((element) => element.scrollTop);
    await page.getByRole("button", { name: "区域全屏预览", exact: true }).click();
    assert.equal(await left.evaluate((element) => element.scrollTop), scrollTop, "Expansion must preserve list scroll position");
    await page.keyboard.press("Escape");
    assert.equal(await left.evaluate((element) => element.scrollTop), scrollTop, "Expansion must preserve list scroll position");
    await page.getByRole("button", { name: /^任务历史/ }).click();
    await page.getByRole("button", { name: "工作台", exact: true }).click();
    await fillsPreviewPane();
    await page.close();
  }
  assert.equal(failures.length, 0, `${failures.length} layout shifts:\n${failures.slice(0, 35).join("\n")}`);
  console.log("PASS: preview fills its pane by default and after closing materials or returning to the workspace; materials use compact mode; expansion/collapse and both locales preserve list geometry at 1440, 1100, 980, 768, 640, 390 and 320px.");
} finally {
  await browser.close();
}
