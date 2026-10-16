import { api, PendingItem, Task } from "./api";
import { loadLocalModel } from "./localModel";

export { disposeModel } from "./localModel";

export async function loadPreview(pending: PendingItem | undefined, task: Task | undefined, signal: AbortSignal, browserPreview?: Blob) {
  if (pending) return loadLocalModel(pending.file, pending.assets, signal);
  if (task?.runtime === "browser") {
    if (!browserPreview) throw new Error("NO_PREVIEW");
    return loadLocalModel(new File([browserPreview], "preview.glb"), [], signal);
  }
  const url = task?.preview_url ?? (task?.artifact_kind !== "zip" ? task?.artifact_url : null);
  if (!url) throw new Error("NO_PREVIEW");
  const response = await api.get<Blob>(url, { responseType: "blob", signal });
  return loadLocalModel(new File([response.data], `preview.${task?.preview_url ? "glb" : task?.target_format}`), [], signal);
}
