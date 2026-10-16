import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { MTLLoader } from "three/examples/jsm/loaders/MTLLoader.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { PLYLoader } from "three/examples/jsm/loaders/PLYLoader.js";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { TGALoader } from "three/examples/jsm/loaders/TGALoader.js";
import type { AssetAttachment } from "./api";

export function disposeModel(root: THREE.Object3D) {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.geometry) return;
    geometries.add(mesh.geometry);
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      materials.add(material);
      Object.values(material).forEach((value) => { if (value instanceof THREE.Texture) textures.add(value); });
    }
  });
  geometries.forEach((value) => value.dispose());
  materials.forEach((value) => value.dispose());
  textures.forEach((value) => {
    value.dispose();
    if (typeof ImageBitmap !== "undefined" && value.source.data instanceof ImageBitmap) value.source.data.close();
  });
}

async function attachMaps(root: THREE.Object3D, assets: AssetAttachment[], manager: THREE.LoadingManager, urls: Map<File, string>, gltf: boolean) {
  const maps = new Map<string, THREE.Texture>();
  await Promise.all(assets.filter((asset) => asset.kind !== "resource").map(async (asset) => {
    const loader = /\.tga$/i.test(asset.file.name) ? new TGALoader(manager) : new THREE.TextureLoader(manager);
    const texture = await loader.loadAsync(urls.get(asset.file)!);
    texture.flipY = !gltf;
    texture.colorSpace = ["base_color", "emissive"].includes(asset.kind) ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    maps.set(asset.kind, texture);
  }));
  let missingUV = false;
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (maps.size && !mesh.geometry.getAttribute("uv")) missingUV = true;
    const override = (original: THREE.Material) => {
      if (!maps.size) return original;
      const material = original instanceof THREE.MeshStandardMaterial ? original : new THREE.MeshStandardMaterial({
        color: (original as THREE.MeshPhongMaterial).color ?? 0xffffff,
        map: (original as THREE.MeshPhongMaterial).map, side: original.side,
      });
      if (material !== original) original.dispose();
      if (maps.has("base_color")) { material.map = maps.get("base_color")!; material.color.set(0xffffff); material.metalness = 0; }
      if (maps.has("normal")) material.normalMap = maps.get("normal")!;
      if (maps.has("roughness")) { material.roughnessMap = maps.get("roughness")!; material.roughness = 1; }
      if (maps.has("metallic")) { material.metalnessMap = maps.get("metallic")!; material.metalness = 1; }
      if (maps.has("ao")) material.aoMap = maps.get("ao")!;
      if (maps.has("emissive")) { material.emissiveMap = maps.get("emissive")!; material.emissive.set(0xffffff); }
      material.needsUpdate = true;
      return material;
    };
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(override) : override(mesh.material);
  });
  return missingUV;
}

export async function loadLocalModel(file: File, assets: AssetAttachment[], signal: AbortSignal) {
  const urls = new Map<File, string>();
  const resources = new Map<string, string>();
  let root: THREE.Object3D | undefined;
  const manager = new THREE.LoadingManager();
  manager.addHandler(/\.tga$/i, new TGALoader(manager));
  const missing = new Set<string>();
  let resourcesLoaded = Promise.resolve();
  let finishResources: (() => void) | undefined;
  manager.onStart = () => { resourcesLoaded = new Promise<void>((resolve) => { finishResources = resolve; }); };
  manager.onLoad = () => finishResources?.();
  manager.onError = (url) => missing.add(url.startsWith("blob:") ? "texture" : url);
  manager.setURLModifier((url) => {
    if (/^(blob:|data:)/.test(url)) return url;
    const name = decodeURIComponent(url.replace(/\\/g, "/").split("/").pop() ?? "").toLowerCase();
    const resource = resources.get(name);
    if (resource) return resource;
    missing.add(name);
    // Local models only resolve files that the user explicitly attached.
    return "data:application/octet-stream;base64,";
  });
  const release = () => { urls.forEach((url) => URL.revokeObjectURL(url)); urls.clear(); resources.clear(); };
  try {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    for (const resource of [file, ...assets.map((asset) => asset.file)]) {
      const url = URL.createObjectURL(resource);
      urls.set(resource, url);
      resources.set(resource.name.toLowerCase(), url);
    }
    const extension = file.name.split(".").pop()?.toLowerCase();
    const gltf = extension === "gltf" || extension === "glb";
    if (gltf) {
      const loaded = await new GLTFLoader(manager).parseAsync(await file.arrayBuffer(), "");
      root = loaded.scene;
      root.animations = loaded.animations;
    } else if (extension === "fbx") {
      root = new FBXLoader(manager).parse(await file.arrayBuffer(), "");
    } else if (extension === "obj") {
      const loader = new OBJLoader(manager);
      const mtl = assets.find((asset) => /\.mtl$/i.test(asset.file.name));
      if (mtl) {
        const materials = new MTLLoader(manager).parse(await mtl.file.text(), "");
        materials.preload();
        loader.setMaterials(materials);
      }
      root = loader.parse(await file.text());
    } else if (extension === "stl" || extension === "ply") {
      const data = await file.arrayBuffer();
      const geometry = extension === "stl" ? new STLLoader(manager).parse(data) : new PLYLoader(manager).parse(data);
      geometry.computeVertexNormals();
      root = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
        color: geometry.hasAttribute("color") ? 0xffffff : 0xb5bbc4,
        vertexColors: geometry.hasAttribute("color"), roughness: 0.72, metalness: 0,
      }));
    } else throw new Error("Unsupported preview format");
    await resourcesLoaded;
    const missingUV = await attachMaps(root, assets, manager, urls, gltf);
    await resourcesLoaded;
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    return { root, missingUV, missing: [...missing], release };
  } catch (error) {
    if (root) disposeModel(root);
    release();
    throw error;
  }
}
