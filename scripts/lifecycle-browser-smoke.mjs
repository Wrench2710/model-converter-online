import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const output = process.env.SMOKE_OUTPUT || "/tmp/modeldesk-lifecycle-smoke";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  channel: "chrome", headless: true,
  args: ["--enable-webgl", "--use-angle=swiftshader", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"],
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem("modeldesk.access", "memory-lifecycle-access");
    localStorage.setItem("modeldesk.locale", "zh");
  });
  await page.routeWebSocket("**/ws/**", () => {});
  const makeSource = (id, name) => ({
    id, original_name: name, extension: "obj", size_bytes: 100, task_count: 0, created_at: new Date().toISOString(),
  });
  const makeTask = (id, source, expired = false) => ({
    id, source_file: source, target_format: "glb", status: "succeeded", progress: 100, artifact_kind: "file",
    artifact_url: expired ? null : `/api/tasks/${id}/artifact/`, preview_url: null,
    artifact_expires_at: new Date(Date.now() + (expired ? -60000 : 600000)).toISOString(),
    assets: [], dimensions: {}, triangle_count: null, error_message: "", created_at: new Date().toISOString(),
  });
  const sourceA = makeSource("source-a", "historical.obj");
  const sourceB = makeSource("source-b", "new.obj");
  let sources = [sourceA];
  let tasks = [makeTask("history-available", sourceA), makeTask("history-expired", sourceA, true)];
  let deletes = 0;
  let rejectStaleConfirmation = false;
  const associated = (sourceId) => tasks.filter((task) => task.source_file.id === sourceId);
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    assert.equal(request.headers().authorization, "Bearer memory-lifecycle-access");
    const json = (data, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
    if (path === "/api/auth/me/") return json({ id: 1, username: "memory@example.com" });
    if (path === "/api/tasks/") return json(tasks);
    if (path === "/api/files/") return json(sources.map((source) => ({ ...source, task_count: associated(source.id).length })));
    if (path === "/api/files/upload/") {
      sources.push(sourceB);
      const task = { ...makeTask("current-task", sourceB), status: "queued", progress: 0, artifact_url: null };
      tasks = [task, ...tasks];
      return json(task, 201);
    }
    const retry = tasks.find((item) => path === `/api/tasks/${item.id}/retry/`);
    if (retry) {
      const task = { ...makeTask("retry-new-task", retry.source_file), status: "queued", progress: 0, artifact_url: null };
      tasks = [task, ...tasks];
      return json(task, 201);
    }
    const source = sources.find((item) => path === `/api/files/${item.id}/`);
    if (source) {
      if (method === "GET") return json({ ...source, tasks: associated(source.id) });
      assert.equal(method, "DELETE");
      const snapshot = request.postDataJSON().task_ids;
      if (rejectStaleConfirmation) {
        rejectStaleConfirmation = false;
        tasks.push(makeTask("added-before-confirm", sourceA, true));
      }
      const linked = associated(source.id).map((task) => task.id);
      if (JSON.stringify([...snapshot].sort()) !== JSON.stringify([...linked].sort())) return json({ code: "linked_tasks_changed" }, 409);
      deletes++;
      tasks = tasks.filter((task) => !linked.includes(task.id));
      sources = sources.filter((item) => item.id !== source.id);
      return json({ deleted_task_ids: linked, source_deleted: true });
    }
    const task = tasks.find((item) => path === `/api/tasks/${item.id}/`);
    if (task && method === "DELETE") {
      deletes++;
      tasks = tasks.filter((item) => item.id !== task.id);
      const sourceDeleted = associated(task.source_file.id).length === 0;
      if (sourceDeleted) sources = sources.filter((item) => item.id !== task.source_file.id);
      return json({ deleted_task_ids: [task.id], source_deleted: sourceDeleted });
    }
    if (path.endsWith("/artifact/")) return route.fulfill({ contentType: "application/octet-stream", body: Buffer.from("memory-artifact") });
    throw new Error(`Unexpected API request: ${method} ${path}`);
  });
  const history = () => page.getByRole("button", { name: /^任务历史/ }).click();
  const workspace = () => page.getByRole("button", { name: "工作台", exact: true }).click();
  const library = () => page.getByRole("button", { name: "源文件", exact: true }).click();
  const painted = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const noOverflow = async () => {
    await painted();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "Page must fit the viewport");
  };
  await page.goto(process.env.SMOKE_URL || "http://localhost");
  await page.getByLabel("选择文件", { exact: true }).waitFor();
  assert.equal(await page.locator("[data-testid=conversion-queue] .task-row").count(), 0);
  await history();
  assert.equal(await page.locator("[data-testid=history-item]").count(), 2);
  assert.equal(await page.getByRole("button", { name: "下载转换产物 history-expired", exact: true }).isDisabled(), true);
  const event = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载转换产物 history-available", exact: true }).click();
  assert.equal((await event).suggestedFilename(), "historical.glb");

  await workspace();
  await page.getByLabel("选择文件", { exact: true }).setInputFiles({
    name: "new.obj", mimeType: "application/octet-stream", buffer: Buffer.from("v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n"),
  });
  assert.equal(await page.locator(".upload-card select").count(), 0, "Output format must only be in the pending task");
  assert.equal(await page.getByLabel("输出格式 new.obj", { exact: true }).count(), 1);
  await page.getByRole("button", { name: "开始转换", exact: true }).click();
  await page.locator("[data-testid=conversion-queue] .task-row").waitFor();
  assert.equal(await page.locator("[data-testid=conversion-queue] .task-row").count(), 1);
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  assert.equal(await page.locator("[data-testid=conversion-queue] .task-row").count(), 1);
  await history();
  assert.equal(await page.locator("[data-testid=history-item]").count(), 3);
  await painted();
  await page.screenshot({ path: `${output}/history-desktop.png`, fullPage: true });
  await page.reload();
  await page.getByLabel("选择文件", { exact: true }).waitFor();
  assert.equal(await page.locator("[data-testid=conversion-queue] .task-row").count(), 0, "Reload must clear only the current-page queue");
  await history();
  assert.equal(await page.locator("[data-testid=history-item]").count(), 3, "Reload must preserve all historical records");

  await page.getByRole("button", { name: "删除任务 history-available", exact: true }).click();
  await page.getByRole("dialog").waitFor();
  await page.getByRole("button", { name: "取消", exact: true }).click();
  assert.equal(deletes, 0);
  await page.getByRole("button", { name: "删除任务 history-available", exact: true }).click();
  await page.getByRole("button", { name: "确认删除", exact: true }).click();
  await page.locator("[data-task-id=history-available]").waitFor({ state: "detached" });
  assert.equal(deletes, 1);
  assert.equal(sources.length, 2, "Deleting one task must retain its shared source");

  await library();
  await page.getByRole("button", { name: "查看关联任务 historical.obj", exact: true }).click();
  assert.equal(await page.locator("[data-testid=history-item]").count(), 1);
  assert.equal(await page.getByLabel("按源文件筛选", { exact: true }).inputValue(), "source-a");
  await page.getByLabel("按源文件筛选", { exact: true }).selectOption("");
  assert.equal(await page.locator("[data-testid=history-item]").count(), 2);
  await page.setViewportSize({ width: 390, height: 844 });
  await noOverflow();
  await page.screenshot({ path: `${output}/history-mobile.png`, fullPage: true });
  await library();
  await noOverflow();
  await page.getByRole("button", { name: "删除源文件 historical.obj", exact: true }).click();
  await page.getByRole("dialog").getByText("#history-").waitFor();
  await painted();
  await page.screenshot({ path: `${output}/source-delete-mobile.png`, fullPage: true });
  await page.keyboard.press("Escape");
  assert.equal(deletes, 1);
  await page.getByRole("button", { name: "删除源文件 historical.obj", exact: true }).click();
  await page.getByRole("dialog").getByText("#history-").waitFor();
  rejectStaleConfirmation = true;
  await page.getByRole("button", { name: "确认删除", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "关联任务已变化" }).waitFor();
  assert.equal(deletes, 1, "Stale confirmation must not delete unseen tasks");
  assert.equal(await page.locator(".deletion-task-list li").count(), 2);
  await page.getByRole("button", { name: "确认删除", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "detached" });
  assert.equal(deletes, 2);
  await page.locator("#source-source-a").waitFor({ state: "detached" });
  assert.equal(tasks.length, 1);

  await page.getByRole("button", { name: "删除源文件 new.obj", exact: true }).click();
  await page.getByRole("dialog").getByText("正在排队或运行的转换会停止，转换结果将被丢弃。").waitFor();
  await page.getByRole("button", { name: "确认删除", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "detached" });
  await history();
  assert.equal(await page.locator("[data-testid=history-item]").count(), 0);
  await workspace();
  assert.equal(await page.locator("[data-testid=conversion-queue] .task-row").count(), 0);
  sources = [sourceA];
  tasks = [{ ...makeTask("retry-original", sourceA), status: "failed", artifact_url: null, error_message: "Original failure" }];
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await history();
  await page.getByRole("button", { name: "重试 retry-original", exact: true }).click();
  await page.locator("[data-testid=conversion-queue] .task-row").waitFor();
  assert.equal(await page.locator("[data-testid=conversion-queue] .task-row").count(), 1);
  await history();
  assert.equal(await page.locator("[data-testid=history-item]").count(), 2);
  assert.equal(await page.locator("[data-task-id=retry-original] .error-text").innerText(), "Original failure");
  assert.equal(await page.locator("[data-task-id=retry-new-task]").count(), 1);
  assert.deepEqual(errors, []);
  console.log(`PASS: persistent history, page-only queue, history downloads, task deletion, linked-source confirmation, stale confirmation, retry history, mobile layouts. Artifacts: ${output}`);
} finally {
  await browser.close();
}
