import type { PendingItem, Task } from "./api";
import type { ConversionRequest, ConversionResponse } from "./browserConversion.worker";
import { BROWSER_INPUT_LIMIT, BROWSER_OUTPUT_FORMATS, BROWSER_RESULT_LIMIT, INPUT_FORMATS, inputBytes, RESULT_LIFETIME } from "./runtimePolicy";

type Entry = { task: Task; input?: PendingItem; artifact?: Blob; preview?: Blob; downloaded: boolean };

export class BrowserRuntime {
  private entries = new Map<string, Entry>();
  private listeners = new Set<() => void>();
  private snapshot: Task[] = [];
  private active: { id: string; worker: Worker; timeout: ReturnType<typeof setTimeout> } | null = null;
  private downloads = new Map<string, ReturnType<typeof setTimeout>>();

  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.snapshot;
  private publish() {
    this.snapshot = [...this.entries.values()].map((entry) => entry.task).reverse();
    this.listeners.forEach((listener) => listener());
  }
  get usedBytes() { return [...this.entries.values()].reduce((sum, entry) => sum + (entry.task.result_bytes ?? 0), 0); }
  get hasUnfinishedWork() {
    return [...this.entries.values()].some(({ task, artifact, downloaded }) =>
      ["queued", "running"].includes(task.status) || Boolean(artifact && !downloaded));
  }
  getPreview(id?: string | null) { return id ? this.entries.get(id)?.preview : undefined; }
  available(id: string) {
    const entry = this.entries.get(id);
    return Boolean(entry?.artifact && Date.parse(entry.task.artifact_expires_at ?? "") > Date.now());
  }
  enqueue(file: File, target: string, assets: PendingItem["assets"] = []) {
    if (inputBytes(file, assets) > BROWSER_INPUT_LIMIT) throw new Error("input_limit");
    const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
    if (!INPUT_FORMATS.includes(extension) || !BROWSER_OUTPUT_FORMATS.includes(target) || extension === target) throw new Error("unsupported_format");
    const id = crypto.randomUUID();
    const task: Task = {
      runtime: "browser", id, source_file: { id: crypto.randomUUID(), original_name: file.name, extension, size_bytes: file.size },
      target_format: target, status: "queued", progress: 0, artifact_url: null, preview_url: null,
      artifact_kind: "file", artifact_expires_at: null, triangle_count: null, dimensions: {}, error_message: "",
      assets: assets.map((asset) => ({ id: asset.id, kind: asset.kind, original_name: asset.file.name, size_bytes: asset.file.size })),
      created_at: new Date().toISOString(),
    };
    this.entries.set(id, { task, input: { id, file, target, assets }, downloaded: false });
    this.publish();
    queueMicrotask(() => this.pump());
    return task;
  }
  private stopWorker() {
    if (!this.active) return;
    clearTimeout(this.active.timeout);
    this.active.worker.terminate();
    this.active = null;
  }
  private pump() {
    if (this.active) return;
    this.expire();
    const entry = [...this.entries.values()].find(({ task }) => task.status === "queued");
    if (!entry?.input) return;
    if (this.usedBytes >= BROWSER_RESULT_LIMIT) {
      this.fail(entry, "result_limit");
      queueMicrotask(() => this.pump());
      return;
    }
    try {
      const worker = new Worker(new URL("./browserConversion.worker.ts", import.meta.url), { type: "module" });
      const timeout = setTimeout(() => {
        if (this.active?.worker !== worker) return;
        this.fail(entry, "conversion_timeout");
        this.stopWorker();
        this.pump();
      }, RESULT_LIFETIME);
      this.active = { id: entry.task.id, worker, timeout };
      entry.task = { ...entry.task, status: "running", phase: "reading" };
      this.publish();
      worker.onmessage = ({ data }: MessageEvent<ConversionResponse>) => {
        if (this.active?.worker !== worker || !this.entries.has(entry.task.id)) return;
        if (data.type === "phase") {
          entry.task = { ...entry.task, phase: data.phase };
          this.publish();
          return;
        }
        if (data.type === "error") this.fail(entry, data.code);
        else {
          const bytes = data.artifact.size + (entry.task.target_format === "glb" ? 0 : data.preview.size);
          if (this.usedBytes + bytes > BROWSER_RESULT_LIMIT) this.fail(entry, "result_limit");
          else {
            entry.artifact = data.artifact;
            entry.preview = data.preview;
            entry.input = undefined;
            entry.task = { ...entry.task, status: "succeeded", progress: 100, phase: undefined,
              artifact_kind: data.kind, artifact_expires_at: new Date(Date.now() + RESULT_LIFETIME).toISOString(),
              result_bytes: bytes, triangle_count: data.triangles, dimensions: data.dimensions };
            this.publish();
          }
        }
        this.stopWorker();
        this.pump();
      };
      worker.onerror = (event) => {
        event.preventDefault();
        if (this.active?.worker !== worker) return;
        this.fail(entry, "conversion_failed");
        this.stopWorker();
        this.pump();
      };
      worker.onmessageerror = () => {
        if (this.active?.worker !== worker) return;
        this.fail(entry, "conversion_failed");
        this.stopWorker();
        this.pump();
      };
      const message: ConversionRequest = { item: entry.input, budget: BROWSER_RESULT_LIMIT - this.usedBytes };
      worker.postMessage(message);
    } catch {
      this.stopWorker();
      this.fail(entry, "unsupported_browser");
      queueMicrotask(() => this.pump());
    }
  }
  private fail(entry: Entry, code: string) {
    entry.task = { ...entry.task, status: "failed", phase: undefined, error_message: code };
    this.publish();
  }
  cancel(id: string) {
    const entry = this.entries.get(id);
    if (!entry || !["queued", "running"].includes(entry.task.status)) return;
    if (this.active?.id === id) this.stopWorker();
    entry.task = { ...entry.task, status: "canceled", phase: undefined };
    this.publish();
    this.pump();
  }
  retry(id: string) {
    const entry = this.entries.get(id);
    if (!entry?.input || !["failed", "canceled"].includes(entry.task.status)) return;
    return this.enqueue(entry.input.file, entry.input.target, entry.input.assets);
  }
  remove(ids: string[]) {
    if (this.active && ids.includes(this.active.id)) this.stopWorker();
    ids.forEach((id) => this.entries.delete(id));
    this.publish();
    this.pump();
  }
  expire = () => {
    let changed = false;
    for (const entry of this.entries.values()) {
      if (entry.artifact && Date.parse(entry.task.artifact_expires_at ?? "") <= Date.now()) {
        entry.artifact = undefined;
        entry.preview = undefined;
        entry.task = { ...entry.task, result_bytes: 0 };
        changed = true;
      }
    }
    if (changed) this.publish();
  };
  download(id: string) {
    this.expire();
    const entry = this.entries.get(id);
    if (!entry?.artifact) return;
    const url = URL.createObjectURL(entry.artifact);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${entry.task.source_file.original_name.replace(/\.[^.]+$/, "")}.${entry.task.artifact_kind === "zip" ? "zip" : entry.task.target_format}`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    entry.downloaded = true;
    const timer = setTimeout(() => { URL.revokeObjectURL(url); this.downloads.delete(url); }, 1000);
    this.downloads.set(url, timer);
  }
  clear = () => {
    this.stopWorker();
    this.downloads.forEach((timer, url) => { clearTimeout(timer); URL.revokeObjectURL(url); });
    this.downloads.clear();
    this.entries.clear();
    this.publish();
  };
}
