import { useCallback, useEffect, useRef, useState } from "react";
import { AssetAttachment, cancelTask, listTasks, retryTask, Task, uploadTask } from "./api";

export function useTasks(userId: number | null) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [queueIds, setQueueIds] = useState<string[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const sockets = useRef<Record<string, WebSocket>>({});
  const owner = useRef(userId);
  const queueOwner = useRef<number | null>(null);
  owner.current = userId;
  const refresh = useCallback(async () => {
    const requestedOwner = owner.current;
    if (!requestedOwner) return;
    const result = await listTasks();
    if (requestedOwner && owner.current === requestedOwner) setTasks(result);
  }, []);

  useEffect(() => {
    if (!userId) {
      setTasks([]);
      setSelectedId(null);
      return;
    }
    if (queueOwner.current !== userId) {
      setQueueIds([]);
      queueOwner.current = userId;
    }
    refresh().catch(() => undefined);
    return () => {
      Object.values(sockets.current).forEach((socket) => socket.close());
      sockets.current = {};
    };
  }, [userId, refresh]);
  useEffect(() => {
    if (!userId) return;
    const active = tasks.filter((task) => ["queued", "running"].includes(task.status));
    for (const [id, socket] of Object.entries(sockets.current)) {
      if (!active.some((task) => task.id === id)) {
        delete sockets.current[id];
        socket.close();
      }
    }
    active.forEach((task) => {
      if (sockets.current[task.id]) return;
      const protocol = window.location.protocol === "https:" ? "wss" : "ws";
      const token = localStorage.getItem("modeldesk.access");
      const socket = new WebSocket(`${protocol}://${window.location.host}/ws/tasks/${task.id}/?token=${encodeURIComponent(token ?? "")}`);
      socket.onmessage = (event) => {
        if (owner.current !== userId) return;
        const update = JSON.parse(event.data) as Partial<Task> & { id: string };
        setTasks((current) => current.map((item) => item.id === update.id ? { ...item, ...update } : item));
        if (["succeeded", "failed", "canceled"].includes(update.status ?? "")) {
          refresh().catch(() => undefined);
          socket.close();
        }
      };
      socket.onclose = () => { if (sockets.current[task.id] === socket) delete sockets.current[task.id]; };
      sockets.current[task.id] = socket;
    });
  }, [userId, tasks, refresh]);

  const add = async (file: File, target: string, assets: AssetAttachment[] = []) => {
    const task = await uploadTask(file, target, assets);
    if (owner.current !== userId) return;
    setTasks((current) => [task, ...current.filter((item) => item.id !== task.id)]);
    setQueueIds((current) => [task.id, ...current.filter((id) => id !== task.id)]);
    setSelectedId(task.id);
  };
  const cancel = async (id: string) => {
    const updated = await cancelTask(id);
    if (owner.current === userId) setTasks((current) => current.map((task) => task.id === id ? updated : task));
  };
  const retry = async (id: string) => {
    const updated = await retryTask(id);
    if (owner.current !== userId) return;
    setTasks((current) => [updated, ...current.filter((task) => task.id !== updated.id)]);
    setQueueIds((current) => [updated.id, ...current.filter((value) => value !== updated.id)]);
    setSelectedId(updated.id);
  };
  const remove = (ids: string[]) => {
    setTasks((current) => current.filter((task) => !ids.includes(task.id)));
    setQueueIds((current) => current.filter((id) => !ids.includes(id)));
    setSelectedId((current) => current && ids.includes(current) ? null : current);
  };
  const queue = queueIds.flatMap((id) => tasks.find((task) => task.id === id) ?? []);
  return { tasks, queue, selectedId, setSelectedId, refresh, add, cancel, retry, remove };
}
