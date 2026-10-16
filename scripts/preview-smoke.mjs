import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";

const playwrightPath = process.env.PLAYWRIGHT_MODULE || "playwright";
const { chromium } = await import(playwrightPath);
const outputDirectory = process.env.SMOKE_OUTPUT || "/tmp/modeldesk-preview-smoke";
await mkdir(outputDirectory, { recursive: true });
const docker = (code) => execFileSync("docker", ["compose", "exec", "-T", "backend", "python", "-c", code], { encoding: "utf8" }).trim();
const fixtureCode = `
import base64, io, json, tempfile, subprocess
from pathlib import Path
from PIL import Image
obj=b"o Plane\\nv -1 0 0\\nv 1 0 0\\nv 0 2 0\\nvt 0 0\\nvt 1 0\\nvt 0.5 1\\nvn 0 0 1\\nf 1/1/1 2/2/1 3/3/1\\n"
fixtures={"obj":base64.b64encode(obj).decode()}
with tempfile.TemporaryDirectory() as directory:
    root=Path(directory)
    source=root/"plane.obj"
    source.write_bytes(obj)
    for ext,exporter in (("glb","glb2"),("gltf","gltf2"),("fbx","fbx"),("stl","stlb"),("ply","plyb")):
        out=root/f"plane.{ext}"
        subprocess.run(["assimp","export",str(source),str(out),f"-f{exporter}"],capture_output=True,check=True)
        fixtures[ext]=base64.b64encode(out.read_bytes()).decode()
    fixtures["bin"]=base64.b64encode((root/"plane.bin").read_bytes()).decode()
    buffer=io.BytesIO()
    image=Image.new("RGB",(32,32),(240,40,30))
    for x in range(16):
        for y in range(32): image.putpixel((x,y),(25,190,230))
    image.save(buffer,format="PNG")
    fixtures["png"]=base64.b64encode(buffer.getvalue()).decode()
print(json.dumps({"fixtures":fixtures}))
`;
let browser;
try {
  const { fixtures } = JSON.parse(docker(fixtureCode));
  browser = await chromium.launch({
    channel: "chrome", headless: true,
    args: ["--enable-webgl", "--use-angle=swiftshader", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  const errors = [];
  const failedRequests = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => { if (response.status() >= 400 && /\/api\//.test(response.url())) failedRequests.push(`${response.status()} ${new URL(response.url()).pathname}`); });
  await page.addInitScript(() => {
    localStorage.setItem("modeldesk.access", "preview-smoke-memory-only");
    localStorage.setItem("modeldesk.locale", "zh");
  });
  let tasks = [];
  let authenticatedPreview = false;
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    assert.equal(request.headers().authorization, "Bearer preview-smoke-memory-only");
    const json = (data, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
    if (path === "/api/auth/me/") return json({ id: 1, username: "browser-smoke@example.com" });
    if (path === "/api/tasks/") return json(tasks);
    if (path === "/api/files/") return json([]);
    if (path === "/api/files/upload/") {
      const data = await new Request("http://test.local", { method: "POST", headers: request.headers(), body: request.postDataBuffer() }).formData();
      assert.ok(data.has("base_color") && data.has("normal") && data.has("roughness"), "Upload must contain per-model texture maps");
      const task = {
        id: "memory-smoke", source_file: { id: "memory-source", original_name: data.get("file").name, extension: "obj", size_bytes: data.get("file").size },
        target_format: data.get("target_format"), status: "succeeded", progress: 100,
        artifact_url: "/api/tasks/memory-smoke/artifact/", preview_url: "/api/tasks/memory-smoke/preview/", artifact_kind: "file",
        triangle_count: 1, dimensions: { x: 2, y: 2, z: 0 }, assets: [], error_message: "", created_at: new Date().toISOString(), artifact_expires_at: new Date(Date.now() + 600000).toISOString(),
      };
      tasks = [task];
      return json(task, 201);
    }
    if (path.endsWith("/preview/") || path.endsWith("/artifact/")) {
      authenticatedPreview = true;
      return route.fulfill({ contentType: "model/gltf-binary", body: Buffer.from(fixtures.glb, "base64") });
    }
    throw new Error(`Unexpected API call: ${path}`);
  });
  await page.goto(process.env.SMOKE_URL || "http://localhost");
  await page.getByLabel("选择文件", { exact: true }).waitFor();
  const file = (extension, name = `plane.${extension}`) => ({
    name, mimeType: "application/octet-stream", buffer: Buffer.from(fixtures[extension], "base64"),
  });
  const ready = async (name) => {
    await page.locator(".preview-title h2").filter({ hasText: name }).waitFor();
    try {
      await page.waitForFunction(() => document.querySelector(".preview-shell")?.getAttribute("data-preview-state") === "ready", null, { timeout: 15000 });
    } catch (error) {
      console.error(`Preview failure for ${name}:`, await page.locator(".preview-shell").innerText());
      throw error;
    }
  };
  await page.getByLabel("选择文件", { exact: true }).setInputFiles([file("obj", "first.obj"), file("obj", "second.obj")]);
  assert.equal(await page.locator("[data-testid=pending-item]").count(), 2);
  await ready("first.obj");
  await page.getByRole("button", { name: "预览 second.obj", exact: true }).click();
  await ready("second.obj");
  await page.getByRole("button", { name: "附加贴图 first.obj", exact: true }).click();
  await ready("first.obj");
  await page.getByLabel("底色 / Albedo", { exact: true }).setInputFiles(file("png", "checker.png"));
  await ready("first.obj");
  await page.locator(".texture-swatch img").waitFor();
  await page.getByLabel("法线 / Normal", { exact: true }).setInputFiles(file("png", "normal.png"));
  await page.getByLabel("粗糙度 / Roughness", { exact: true }).setInputFiles(file("png", "roughness.png"));
  await ready("first.obj");
  await page.screenshot({ path: `${outputDirectory}/desktop.png`, fullPage: true });
  // Assert that real geometry rendered rather than only a background/grid.
  const pixels = await page.locator(".viewport canvas").evaluate(async (canvas) => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const gl = canvas.getContext("webgl2");
    const pixels = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    let colored = 0;
    for (let i = 0; i < pixels.length; i += 4) if (Math.max(pixels[i], pixels[i + 1], pixels[i + 2]) - Math.min(pixels[i], pixels[i + 1], pixels[i + 2]) > 30) colored++;
    return colored;
  });
  assert.ok(pixels > 100, `Expected textured model pixels; found ${pixels}`);
  const viewport = page.locator(".viewport canvas");
  const beforeOrbit = await viewport.screenshot();
  const rectangle = await viewport.boundingBox();
  await page.mouse.move(rectangle.x + rectangle.width / 2, rectangle.y + rectangle.height / 2);
  await page.mouse.down();
  await page.mouse.move(rectangle.x + rectangle.width / 2 + 100, rectangle.y + rectangle.height / 2 + 20, { steps: 12 });
  await page.mouse.up();
  assert.ok(!beforeOrbit.equals(await viewport.screenshot()), "Orbit must change rendered pixels");
  await page.getByRole("button", { name: "预览 first.obj", exact: true }).click();
  await page.waitForTimeout(250);
  assert.ok(beforeOrbit.equals(await viewport.screenshot()), "Clicking the selected model must automatically restore its original camera");
  await page.getByRole("button", { name: "切换线框", exact: true }).click();
  await page.getByRole("button", { name: "切换线框", exact: true }).click();
  await page.getByRole("button", { name: "重置视角", exact: true }).click();
  const originalCanvas = await viewport.elementHandle();
  const assertExpandedLayout = async (stacked) => {
    await page.waitForFunction(() => {
      const canvas = document.querySelector(".viewport canvas");
      const gl = canvas?.getContext("webgl2");
      if (!gl || canvas.width !== canvas.clientWidth || canvas.height !== canvas.clientHeight) return false;
      const pixels = new Uint8Array(canvas.width * canvas.height * 4);
      gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      let modelPixels = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        if (Math.max(pixels[i], pixels[i + 1], pixels[i + 2]) > 150) modelPixels++;
      }
      return modelPixels > 100;
    }).catch(async (error) => {
      console.error("Expanded preview dimensions:", await viewport.evaluate((canvas) => ({
        buffer: [canvas.width, canvas.height], display: [canvas.clientWidth, canvas.clientHeight],
        bounds: canvas.getBoundingClientRect().toJSON(),
      })));
      throw error;
    });
    const boxes = await page.evaluate(() => {
      const box = (selector) => {
        const { x, y, width, height, right, bottom } = document.querySelector(selector).getBoundingClientRect();
        return { x, y, width, height, right, bottom };
      };
      return {
        sidebar: box(".sidebar"), list: box(".left-column"), preview: box(".preview-shell"),
        canvas: box(".viewport canvas"), width: innerWidth, height: innerHeight,
        overflow: document.documentElement.scrollWidth > innerWidth,
        listScrolls: document.querySelector(".left-column").scrollHeight > document.querySelector(".left-column").clientHeight,
        listOverflow: getComputedStyle(document.querySelector(".left-column")).overflowY,
      };
    });
    assert.ok(!boxes.overflow, "Expanded page must not overflow horizontally");
    assert.ok(boxes.preview.x >= boxes.sidebar.right, "Preview must leave the sidebar clear");
    assert.ok(boxes.preview.right <= boxes.width && boxes.preview.bottom <= boxes.height, "Preview must stay within the window");
    assert.ok(stacked ? boxes.preview.bottom <= boxes.list.y : boxes.preview.x >= boxes.list.right, "Preview must leave the conversion list clear");
    assert.ok(boxes.canvas.height > 50 && boxes.canvas.width > 100, "Expanded canvas must remain usable");
    assert.equal(boxes.listOverflow, "auto", "Conversion list must allow independent scrolling");
    if (stacked) assert.ok(boxes.listScrolls, "Conversion list must scroll when it exceeds the mobile pane");
    assert.equal(await page.locator(".viewport canvas").count(), 1);
    return boxes;
  };
  await page.getByRole("button", { name: "区域全屏预览", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".viewport canvas")?.clientHeight > 460);
  assert.ok(await originalCanvas.evaluate((canvas) => canvas === document.querySelector(".viewport canvas")), "Expansion must preserve the existing model scene");
  assert.equal(await page.getByRole("button", { name: "退出区域全屏", exact: true }).getAttribute("aria-expanded"), "true");
  await assertExpandedLayout(false);
  await page.screenshot({ path: `${outputDirectory}/expanded-desktop.png`, fullPage: true });
  await page.getByRole("button", { name: "预览 second.obj", exact: true }).click();
  await ready("second.obj");
  await page.getByRole("button", { name: "预览 first.obj", exact: true }).click();
  await ready("first.obj");
  await page.setViewportSize({ width: 1366, height: 768 });
  await assertExpandedLayout(false);
  await page.setViewportSize({ width: 390, height: 844 });
  await assertExpandedLayout(true);
  await page.getByRole("button", { name: "预览 second.obj", exact: true }).click();
  await ready("second.obj");
  await page.screenshot({ path: `${outputDirectory}/expanded-mobile.png`, fullPage: true });
  await page.setViewportSize({ width: 320, height: 568 });
  await assertExpandedLayout(true);
  await page.keyboard.press("Escape");
  assert.equal(await page.locator(".preview-expanded").count(), 0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "区域全屏预览", exact: true }).click();
  await page.getByRole("button", { name: "退出区域全屏", exact: true }).click();
  assert.equal(await page.locator(".preview-expanded").count(), 0);
  await page.getByRole("button", { name: "区域全屏预览", exact: true }).click();
  await page.getByRole("button", { name: /^任务历史/ }).click();
  assert.equal(await page.locator(".preview-expanded").count(), 0);
  await page.getByRole("button", { name: "工作台", exact: true }).click();
  await page.getByRole("button", { name: "预览 first.obj", exact: true }).click();
  await ready("first.obj");
  await page.screenshot({ path: `${outputDirectory}/mobile.png`, fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "Mobile page overflows horizontally");
  await page.setViewportSize({ width: 1440, height: 1000 });
  const first = page.locator("[data-testid=pending-item]").filter({ hasText: "first.obj" });
  await first.getByRole("button", { name: "开始转换", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".preview-shell")?.getAttribute("data-preview-state") === "ready" && !document.querySelector(".preview-shell")?.textContent?.includes("待确认"), null, { timeout: 30000 });
  assert.equal(await page.locator(".preview-shell").getByRole("button", { name: /下载转换产物/ }).count(), 0);
  assert.equal(await page.locator("[data-testid=pending-item]").count(), 1);
  await page.getByRole("button", { name: /^任务历史/ }).click();
  await page.getByRole("button", { name: "下载转换产物 memory-smoke", exact: true }).waitFor();
  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载转换产物 memory-smoke", exact: true }).click();
  const download = await downloadEvent;
  assert.equal(download.suggestedFilename(), "first.glb");
  await page.getByRole("button", { name: "工作台", exact: true }).click();
  for (const extension of ["glb", "stl", "ply", "fbx"]) {
    await page.getByLabel("选择文件", { exact: true }).setInputFiles(file(extension));
    await ready(`plane.${extension}`);
  }
  await page.getByLabel("选择文件", { exact: true }).setInputFiles(file("gltf"));
  await page.getByRole("button", { name: "附加贴图 plane.gltf", exact: true }).click();
  await page.getByLabel("添加关联文件", { exact: true }).setInputFiles(file("bin"));
  await ready("plane.gltf");
  await page.screenshot({ path: `${outputDirectory}/gltf-linked.png`, fullPage: true });
  assert.deepEqual(errors, [], `Browser errors: ${errors.join("; ")}`);
  assert.deepEqual(failedRequests, [], `API errors: ${failedRequests.join("; ")}`);
  assert.ok(authenticatedPreview, "Preview must fetch through the authenticated API");
  await writeFile(`${outputDirectory}/result.json`, JSON.stringify({ passed: true, texturedPixels: pixels, formats: ["obj", "glb", "stl", "ply", "fbx", "gltf"], pendingSelection: true, attachments: true, conversion: true, authenticatedPreview: true, expandedPreview: { desktop: true, mobile: true, scenePreserved: true, selection: true, escape: true, navigation: true } }, null, 2));
  console.log(`PASS: preview selection, textures, conversion, authenticated download, all six input formats, desktop/mobile, expanded preview. Artifacts: ${outputDirectory}`);
} finally {
  await browser?.close();
}
