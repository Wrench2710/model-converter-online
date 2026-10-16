import { useEffect, useState, useSyncExternalStore } from "react";
import { BrowserRuntime } from "./browserRuntime";
import type { AssetAttachment } from "./api";

export function useBrowserTasks(enabled: boolean) {
  const [runtime] = useState(() => new BrowserRuntime());
  const tasks = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) { runtime.clear(); setSelectedId(null); return; }
    const timer = window.setInterval(runtime.expire, 1000);
    window.addEventListener("focus", runtime.expire);
    document.addEventListener("visibilitychange", runtime.expire);
    const clearOnLeave = () => runtime.clear();
    window.addEventListener("pagehide", clearOnLeave);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", runtime.expire);
      document.removeEventListener("visibilitychange", runtime.expire);
      window.removeEventListener("pagehide", clearOnLeave);
      runtime.clear();
    };
  }, [enabled, runtime]);
  const add = async (file: File, target: string, assets: AssetAttachment[] = []) => {
    const task = runtime.enqueue(file, target, assets);
    setSelectedId(task.id);
  };
  const retry = async (id: string) => {
    const task = runtime.retry(id);
    if (task) setSelectedId(task.id);
  };
  return {
    runtime, tasks, queue: tasks, selectedId, setSelectedId, add, retry,
    refresh: async () => runtime.expire(),
    cancel: async (id: string) => runtime.cancel(id),
    remove: (ids: string[]) => { runtime.remove(ids); if (selectedId && ids.includes(selectedId)) setSelectedId(null); },
  };
}
