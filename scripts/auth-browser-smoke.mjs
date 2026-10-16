import assert from "node:assert/strict";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({
  channel: "chrome", headless: true,
  args: ["--enable-webgl", "--use-angle=swiftshader", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"],
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem("modeldesk.access", "initial-memory-access");
    localStorage.setItem("modeldesk.refresh", "initial-memory-refresh");
    localStorage.setItem("modeldesk.locale", "zh");
  });
  await page.routeWebSocket("**/ws/**", () => {});
  let tasks = [];
  let mode = "valid";
  let validAccess = "initial-memory-access";
  let refreshes = 0;
  let submissions = 0;
  let texture;
  const invalid = { detail: "Given token not valid for any token type", code: "token_not_valid" };
  const model = Buffer.from("v -1 0 0\nv 1 0 0\nv 0 2 0\nvt 0 0\nvt 1 0\nvt 0.5 1\nf 1/1 2/2 3/3\n");
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const json = (data, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
    if (path === "/api/auth/refresh/") {
      refreshes++;
      assert.equal(request.headers().authorization, undefined);
      if (mode === "invalid") return json(invalid, 401);
      if (mode === "outage") return json({ detail: "Temporary outage" }, 503);
      validAccess = `refreshed-memory-access-${refreshes}`;
      return json({ access: validAccess });
    }
    if (path === "/api/auth/login/") {
      assert.equal(request.headers().authorization, undefined);
      validAccess = "signed-in-memory-access";
      return json({ access: validAccess, refresh: "signed-in-memory-refresh" });
    }
    if (request.headers().authorization !== `Bearer ${validAccess}`) return json(invalid, 401);
    if (path === "/api/auth/me/") return json({ id: 1, username: "memory@example.com" });
    if (path === "/api/tasks/") return json(tasks);
    if (path === "/api/files/") return json([]);
    if (path === "/api/files/upload/") {
      const data = await new Request("http://memory.local", {
        method: "POST", headers: request.headers(), body: request.postDataBuffer(),
      }).formData();
      assert.deepEqual(Buffer.from(await data.get("file").arrayBuffer()), model, "Retried upload must keep the original model");
      assert.equal(data.get("target_format"), "glb");
      if (submissions > 0) {
        assert.equal(data.get("base_color").name, "retained.png");
        assert.deepEqual(Buffer.from(await data.get("base_color").arrayBuffer()), texture, "Sign-in must preserve texture bytes");
      }
      submissions++;
      const task = {
        id: `memory-task-${submissions}`, source_file: { original_name: data.get("file").name, extension: "obj", size_bytes: model.length },
        target_format: "glb", status: "queued", progress: 0, artifact_url: null, preview_url: null,
        artifact_kind: "file", assets: [], dimensions: {}, triangle_count: null, error_message: "", created_at: new Date().toISOString(),
      };
      tasks = [task, ...tasks];
      return json(task, 201);
    }
    throw new Error(`Unexpected API request: ${path}`);
  });
  await page.goto(process.env.SMOKE_URL || "http://localhost");
  const choose = () => page.getByLabel("选择文件", { exact: true }).setInputFiles({
    name: "memory.obj", mimeType: "application/octet-stream", buffer: model,
  });
  const start = () => page.getByRole("button", { name: "开始转换", exact: true }).click();
  await choose();
  validAccess = "expired-on-server";
  await start();
  await page.waitForFunction(() => document.querySelectorAll("[data-testid=pending-item]").length === 0);
  assert.equal(refreshes, 1);
  assert.equal(submissions, 1);

  await choose();
  texture = Buffer.from(await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 2;
    const context = canvas.getContext("2d");
    context.fillStyle = "#ff0000";
    context.fillRect(0, 0, 2, 2);
    return canvas.toDataURL().split(",")[1];
  }), "base64");
  await page.getByRole("button", { name: "附加贴图 memory.obj", exact: true }).click();
  await page.getByLabel("底色 / Albedo", { exact: true }).setInputFiles({
    name: "retained.png", mimeType: "image/png", buffer: texture,
  });
  await page.locator(".texture-swatch img").waitFor();
  mode = "outage";
  validAccess = "expired-on-server-again";
  await start();
  await page.getByRole("alert").filter({ hasText: "Temporary outage" }).waitFor();
  assert.equal(await page.locator("[data-testid=pending-item]").count(), 1);
  assert.ok(await page.evaluate(() => localStorage.getItem("modeldesk.refresh")));

  mode = "invalid";
  await start();
  await page.getByRole("status").filter({ hasText: "登录已过期" }).waitFor();
  assert.equal(await page.evaluate(() => localStorage.getItem("modeldesk.access")), null);
  assert.equal(await page.evaluate(() => localStorage.getItem("modeldesk.refresh")), null);
  await page.getByLabel("邮箱", { exact: true }).fill("memory@example.com");
  await page.getByLabel("密码", { exact: true }).fill("Memory!Password123");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.locator("[data-testid=pending-item]").waitFor();
  assert.equal(await page.locator("[data-testid=pending-item]").count(), 1);
  await page.locator(".texture-swatch img").waitFor();
  assert.equal(await page.locator(".inline-error").count(), 0);
  mode = "valid";
  await start();
  await page.waitForFunction(() => document.querySelectorAll("[data-testid=pending-item]").length === 0);
  assert.equal(submissions, 2);
  assert.deepEqual(errors, [], "Authentication recovery must not cause unhandled browser errors");
  console.log("PASS: browser upload refresh, outage retry, expired-session sign-in, retained model/textures, and resumed conversion.");
} finally {
  await browser.close();
}
