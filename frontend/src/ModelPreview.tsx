import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { AlertCircle, Maximize2, Minimize2, Rotate3d, ScanLine, ZoomIn, ZoomOut } from "lucide-react";
import { PendingItem, Task } from "./api";
import { disposeModel, loadPreview } from "./previewLoader";
import { browserError } from "./runtimePolicy";

const copy = {
  zh: { title: "模型预览", empty: "未选择模型", loading: "正在加载模型…", unavailable: "此任务暂无可用预览，产物可能已过期。",
    reset: "重置视角", wireframe: "切换线框", zoomIn: "放大", zoomOut: "缩小", download: "下载转换产物",
    expand: "区域全屏预览", collapse: "退出区域全屏",
    missingUV: "模型缺少 UV 坐标，手动贴图无法正确显示。请先在建模软件中展开 UV。",
    missing: "缺少关联文件，请附加：", failed: "预览加载失败，请检查模型与关联文件是否完整。",
    status: "状态", triangles: "三角面", dimensions: "尺寸", pending: "待确认", idle: "未选择", queued: "排队中", running: "转换中",
    succeeded: "已完成", canceled: "已取消", conversionFailed: "转换失败", downloading: "正在准备下载…",
  },
  en: { title: "Model preview", empty: "No model selected", loading: "Loading model…", unavailable: "No temporary preview is available. The artifact may have expired.",
    reset: "Reset camera", wireframe: "Toggle wireframe", zoomIn: "Zoom in", zoomOut: "Zoom out", download: "Download conversion artifact",
    expand: "Expand preview area", collapse: "Restore preview area",
    missingUV: "This model has no UV coordinates. Unwrap its UVs before attaching maps.",
    missing: "Attach missing linked files: ", failed: "Preview failed. Check the model and its linked files.",
    status: "Status", triangles: "Triangles", dimensions: "Dimensions", pending: "Pending confirmation", idle: "Idle", queued: "Queued", running: "Converting",
    succeeded: "Completed", canceled: "Canceled", conversionFailed: "Conversion failed", downloading: "Preparing download…",
  },
};

export default function ModelPreview({ pending, task, locale, expanded, onToggleExpanded, resetKey, browserPreview }: {
  pending?: PendingItem; task?: Task; locale: "zh" | "en"; expanded: boolean; onToggleExpanded: () => void; resetKey: number; browserPreview?: Blob;
}) {
  const t = copy[locale];
  const mount = useRef<HTMLDivElement>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const modelRef = useRef<THREE.Object3D | null>(null);
  const frameRef = useRef<(() => void) | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<{ unavailable: boolean; detail: string } | null>(null);
  const [warning, setWarning] = useState<{ missingUV: boolean; missing: string[] } | null>(null);
  const [stats, setStats] = useState<{ triangles: number; dimensions: THREE.Vector3 } | null>(null);
  const label = pending?.file.name ?? task?.source_file.original_name ?? t.empty;

  useEffect(() => {
    if (!mount.current) return;
    const host = mount.current;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#2c2c2e");
    const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 10000);
    let renderer: THREE.WebGLRenderer;
    try { renderer = new THREE.WebGLRenderer({ antialias: true }); }
    catch { setError({ unavailable: false, detail: "" }); return; }
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    host.appendChild(renderer.domElement);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controlsRef.current = controls;
    cameraRef.current = camera;
    scene.add(new THREE.HemisphereLight(0xffffff, 0x202024, 2.1));
    const light = new THREE.DirectionalLight(0xffffff, 2.5);
    light.position.set(4, 7, 5);
    scene.add(light);
    const grid = new THREE.GridHelper(10, 20, 0x55555a, 0x3d3d41);
    scene.add(grid);
    camera.position.set(4, 3, 5);
    const frameObject = (object: THREE.Object3D) => {
      controls.enableDamping = false;
      controls.update();
      const bounds = new THREE.Box3().setFromObject(object);
      if (bounds.isEmpty()) throw new Error("The model contains no previewable geometry.");
      const center = bounds.getCenter(new THREE.Vector3());
      const radius = Math.max(bounds.getSize(new THREE.Vector3()).length(), 0.5);
      controls.target.copy(center);
      camera.position.set(radius * 1.3, radius * 0.8, radius * 1.5).add(center);
      camera.near = Math.max(radius / 1000, 0.001);
      camera.far = radius * 100;
      camera.updateProjectionMatrix();
      controls.update();
      controls.enableDamping = true;
    };
    frameRef.current = () => modelRef.current && frameObject(modelRef.current);
    const abort = new AbortController();
    let active = true;
    setLoading(Boolean(pending || task?.status === "succeeded"));
    setError(null);
    setWarning(null);
    setStats(null);
    if (pending || task?.status === "succeeded") loadPreview(pending, task, abort.signal, browserPreview).then((loaded) => {
      if (!active) { disposeModel(loaded.root); loaded.release(); return; }
      const display = new THREE.Group();
      display.add(loaded.root);
      modelRef.current = display;
      (display as THREE.Object3D & { releasePreviewUrls?: () => void }).releasePreviewUrls = loaded.release;
      scene.add(display);
      const bounds = new THREE.Box3().setFromObject(loaded.root);
      const dimensions = bounds.getSize(new THREE.Vector3());
      const scale = 2.4 / Math.max(dimensions.x, dimensions.y, dimensions.z, 0.001);
      display.scale.setScalar(scale);
      display.position.copy(bounds.getCenter(new THREE.Vector3())).multiplyScalar(-scale);
      display.updateMatrixWorld(true);
      let triangles = 0;
      loaded.root.traverse((node) => {
        const mesh = node as THREE.Mesh;
        if (mesh.isMesh) triangles += (mesh.geometry.index?.count ?? mesh.geometry.getAttribute("position")?.count ?? 0) / 3;
      });
      setStats({ triangles: Math.round(triangles), dimensions });
      frameObject(display);
      grid.position.y = new THREE.Box3().setFromObject(display).min.y - 0.01;
      if (loaded.missingUV || loaded.missing.length) setWarning({ missingUV: loaded.missingUV, missing: loaded.missing });
      setLoading(false);
    }).catch((reason: unknown) => {
      if (!active || reason instanceof DOMException && reason.name === "AbortError") return;
      const message = reason instanceof Error ? reason.message : "";
      setError({ unavailable: message === "NO_PREVIEW", detail: message });
      setLoading(false);
    });
    const resize = () => {
      const width = host.clientWidth;
      const height = host.clientHeight;
      if (!width || !height) return;
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    let animation = 0;
    const render = () => { animation = requestAnimationFrame(render); controls.update(); renderer.render(scene, camera); };
    render();
    return () => {
      active = false;
      abort.abort();
      cancelAnimationFrame(animation);
      observer.disconnect();
      controls.dispose();
      if (modelRef.current) {
        disposeModel(modelRef.current);
        (modelRef.current as THREE.Object3D & { releasePreviewUrls?: () => void }).releasePreviewUrls?.();
      }
      grid.geometry.dispose();
      (grid.material as THREE.Material).dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
      modelRef.current = null;
      frameRef.current = null;
    };
  }, [pending?.id, pending?.assets, task?.id, task?.preview_url, task?.artifact_url, task?.status, browserPreview]);

  useEffect(() => { frameRef.current?.(); }, [resetKey]);

  const toggleWireframe = () => modelRef.current?.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      const value = material as THREE.Material & { wireframe?: boolean };
      if ("wireframe" in value) value.wireframe = !value.wireframe;
    }
  });
  const zoom = (factor: number) => {
    if (!cameraRef.current || !controlsRef.current) return;
    cameraRef.current.position.multiplyScalar(factor);
    controlsRef.current.update();
  };
  const state = pending ? "pending" : task?.status ?? "idle";
  const dimensions = pending ? stats?.dimensions : task?.dimensions;
  return <section className="preview-shell" data-preview-state={loading ? "loading" : error ? "error" : stats ? "ready" : "empty"}>
    <div className="preview-toolbar">
      <div className="preview-title"><h2 title={label}>{label}</h2><span>{t.title}</span></div>
      <div className="icon-actions">
        <button aria-label={t.reset} title={t.reset} disabled={!stats} onClick={() => frameRef.current?.()}><Rotate3d size={16} /></button>
        <button aria-label={t.wireframe} title={t.wireframe} disabled={!stats} onClick={toggleWireframe}><ScanLine size={16} /></button>
        <button aria-label={t.zoomIn} title={t.zoomIn} disabled={!stats} onClick={() => zoom(0.85)}><ZoomIn size={16} /></button>
        <button aria-label={t.zoomOut} title={t.zoomOut} disabled={!stats} onClick={() => zoom(1.15)}><ZoomOut size={16} /></button>
        <button aria-label={expanded ? t.collapse : t.expand} title={expanded ? t.collapse : t.expand}
          aria-expanded={expanded} aria-controls="model-preview-viewport" onClick={onToggleExpanded}>
          {expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
        </button>
      </div>
    </div>
    <div className="viewport" id="model-preview-viewport" ref={mount} aria-busy={loading}>
      {loading && <div className="preview-message" role="status">{t.loading}</div>}
      {error && <div className="preview-message preview-error" role="alert"><AlertCircle size={16} />{error.unavailable ? t.unavailable : `${t.failed}${error.detail ? ` (${error.detail})` : ""}`}</div>}
      {!pending && task && task.status !== "succeeded" && <div className="preview-message">{task.status === "failed"
        ? task.runtime === "browser" ? browserError(task.error_message, locale) : task.error_message || t.conversionFailed
        : task.runtime === "browser" ? t[task.status] : `${t[task.status]} · ${task.progress}%`}</div>}
      {!pending && !task && <div className="preview-message">{t.empty}</div>}
      {warning && !error && <div className="preview-warning" role="status">{warning.missing.length ? `${t.missing}${warning.missing.join(", ")}` : t.missingUV}</div>}
    </div>
    <div className="stats-row">
      <div><span>{t.status}</span><strong>{state === "failed" ? t.conversionFailed : t[state]}</strong></div>
      <div><span>{t.triangles}</span><strong>{(pending ? stats?.triangles : task?.triangle_count)?.toLocaleString() ?? "—"}</strong></div>
      <div><span>{t.dimensions}</span><strong>{dimensions?.x != null ? `${dimensions.x.toFixed(2)} × ${dimensions.y?.toFixed(2)} × ${dimensions.z?.toFixed(2)}` : "—"}</strong></div>
    </div>
  </section>;
}
