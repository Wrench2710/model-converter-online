import * as THREE from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { STLExporter } from "three/examples/jsm/exporters/STLExporter.js";
import { PLYExporter } from "three/examples/jsm/exporters/PLYExporter.js";
import { strToU8, zipSync } from "three/examples/jsm/libs/fflate.module.js";
import { disposeModel, loadLocalModel } from "./localModel";
import type { PendingItem, Task } from "./api";
import { BROWSER_INPUT_LIMIT, BROWSER_OUTPUT_FORMATS, inputBytes } from "./runtimePolicy";

export type ConversionRequest = { item: PendingItem; budget: number };
export type ConversionResponse =
  | { type: "phase"; phase: NonNullable<Task["phase"]> }
  | { type: "error"; code: string }
  | { type: "result"; artifact: Blob; preview: Blob; kind: "file" | "zip"; triangles: number; dimensions: { x: number; y: number; z: number } };

const send = (message: ConversionResponse) => self.postMessage(message);
const fail = (code: string): never => { throw new Error(code); };
const asArrayBuffer = (data: ArrayBuffer | ArrayBufferView) => {
  if (data instanceof ArrayBuffer) return data;
  const bytes = new Uint8Array(data.byteLength);
  bytes.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  return bytes.buffer;
};
const asDataURL = (blob: Blob) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result as string);
  reader.onerror = () => reject(reader.error);
  reader.readAsDataURL(blob);
});

// Reuse the embedded GLB buffers so Worker JSON export cannot drop image URIs.
async function asGLTF(glb: ArrayBuffer) {
  const header = new DataView(glb);
  const jsonLength = header.getUint32(12, true);
  const model = JSON.parse(new TextDecoder().decode(new Uint8Array(glb, 20, jsonLength)));
  const binaryOffset = 20 + jsonLength;
  if (model.buffers?.length) {
    const length = header.getUint32(binaryOffset, true);
    model.buffers[0].uri = await asDataURL(new Blob([glb.slice(binaryOffset + 8, binaryOffset + 8 + length)], {
      type: "application/octet-stream",
    }));
  }
  return new Blob([JSON.stringify(model)], { type: "model/gltf+json" });
}

// FBXLoader uses window.URL for embedded images and TextureLoader for native
// image types. Adapt those two browser APIs only inside this isolated worker.
Object.defineProperty(globalThis, "window", { value: { URL }, configurable: true });
THREE.TextureLoader.prototype.load = function (url, onLoad, onProgress, onError) {
  const texture = new THREE.Texture();
  new THREE.ImageBitmapLoader(this.manager).setPath(this.path)
    .setOptions({ imageOrientation: "none", premultiplyAlpha: "none" })
    .load(url, (bitmap) => {
      texture.image = bitmap;
      texture.needsUpdate = true;
      onLoad?.(texture);
    }, onProgress, onError);
  return texture;
};

self.onmessage = async (event: MessageEvent<ConversionRequest>) => {
  let loaded: Awaited<ReturnType<typeof loadLocalModel>> | undefined;
  try {
    if (typeof OffscreenCanvas === "undefined" || typeof createImageBitmap === "undefined") fail("unsupported_browser");
    const { item, budget } = event.data;
    if (inputBytes(item.file, item.assets) > BROWSER_INPUT_LIMIT) fail("input_limit");
    const sourceFormat = item.file.name.split(".").pop()?.toLowerCase();
    if (!BROWSER_OUTPUT_FORMATS.includes(item.target) || sourceFormat === item.target) fail("unsupported_format");
    send({ type: "phase", phase: "reading" });
    loaded = await loadLocalModel(item.file, item.assets, new AbortController().signal);
    if (loaded.missing.length) fail("missing_resources");
    if (loaded.missingUV) fail("missing_uv");
    const root = loaded.root;
    root.updateMatrixWorld(true);
    let triangles = 0;
    let hasTextures = false;
    root.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (!mesh.isMesh) return;
      triangles += (mesh.geometry.index?.count ?? mesh.geometry.getAttribute("position")?.count ?? 0) / 3;
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        if (Object.values(material).some((value) => value instanceof THREE.Texture)) hasTextures = true;
      }
    });
    if (!triangles) fail("empty_model");
    const dimensions = new THREE.Box3().setFromObject(root).getSize(new THREE.Vector3());
    send({ type: "phase", phase: "exporting" });
    const exporter = new GLTFExporter();
    const options = { animations: root.animations, onlyVisible: false, maxTextureSize: 8192 };
    const result = await exporter.parseAsync(root, { ...options, binary: true });
    if (!(result instanceof ArrayBuffer)) return fail("conversion_failed");
    const glb = result;
    const preview = new Blob([glb], { type: "model/gltf-binary" });
    if (preview.size > budget) fail("result_limit");
    let artifact = preview;
    let kind: "file" | "zip" = "file";
    if (item.target !== "glb") {
      let model: Blob;
      if (item.target === "gltf") {
        model = await asGLTF(glb);
      } else if (item.target === "stl") {
        const data = new STLExporter().parse(root, { binary: true });
        model = new Blob([asArrayBuffer(data)], { type: "model/stl" });
      } else {
        // PLYExporter returns the result synchronously if no callback is supplied.
        const data = new PLYExporter().parse(root, undefined as never, { binary: true, littleEndian: true });
        if (!data) fail("conversion_failed");
        model = new Blob([asArrayBuffer(data!)], { type: "application/octet-stream" });
      }
      const packaged = item.target === "gltf" || hasTextures || item.assets.length > 0;
      if (model.size + preview.size > budget) fail("result_limit");
      if (packaged) {
        send({ type: "phase", phase: "packaging" });
        const files: Record<string, Uint8Array> = {
          [`model.${item.target}`]: new Uint8Array(await model.arrayBuffer()),
          "preview.glb": new Uint8Array(glb),
          "manifest.json": strToU8(JSON.stringify({
            runtime: "browser", source: item.file.name, target: item.target,
            geometryOnly: ["stl", "ply"].includes(item.target),
            materialPreview: "preview.glb",
          }, null, 2)),
        };
        let size = model.size + preview.size * 2;
        for (const asset of item.assets) {
          size += asset.file.size;
          if (size > budget) fail("result_limit");
          const name = asset.file.name.replace(/[\\/]/g, "_");
          files[`attachments/${name}`] = new Uint8Array(await asset.file.arrayBuffer());
        }
        const zipped = zipSync(files, { level: 0 });
        artifact = new Blob([zipped], { type: "application/zip" });
        kind = "zip";
      } else artifact = model;
      if (artifact.size + preview.size > budget) fail("result_limit");
    }
    send({ type: "result", artifact, preview, kind, triangles: Math.round(triangles), dimensions: {
      x: dimensions.x, y: dimensions.y, z: dimensions.z,
    } });
  } catch (reason) {
    const code = reason instanceof Error ? reason.message : "conversion_failed";
    const known = ["input_limit", "unsupported_format", "missing_resources", "missing_uv", "empty_model", "result_limit", "unsupported_browser"];
    send({ type: "error", code: known.includes(code) ? code : "conversion_failed" });
  } finally {
    if (loaded) { disposeModel(loaded.root); loaded.release(); }
  }
};
