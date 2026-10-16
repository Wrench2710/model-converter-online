import axios, { InternalAxiosRequestConfig } from "axios";

export type TaskStatus = "queued" | "running" | "succeeded" | "failed" | "canceled";
export type Task = {
  runtime?: "browser";
  phase?: "reading" | "exporting" | "packaging";
  result_bytes?: number;
  id: string;
  source_file: { id: string; original_name: string; extension: string; size_bytes: number };
  target_format: string;
  status: TaskStatus;
  progress: number;
  artifact_url: string | null;
  preview_url: string | null;
  artifact_kind: "file" | "zip";
  artifact_expires_at: string | null;
  assets: { id: string; kind: string; original_name: string; size_bytes: number }[];
  triangle_count: number | null;
  dimensions: { x?: number; y?: number; z?: number };
  error_message: string;
  created_at: string;
};

export const TEXTURE_KINDS = ["base_color", "normal", "roughness", "metallic", "ao", "emissive"] as const;
export type TextureKind = typeof TEXTURE_KINDS[number];
export type AssetAttachment = { id: string; kind: TextureKind | "resource"; file: File };
export type PendingItem = { id: string; file: File; target: string; assets: AssetAttachment[] };

export const AUTH_EXPIRED_EVENT = "modeldesk:auth-expired";
const publicAuthPaths = ["/auth/login/", "/auth/register/", "/auth/captcha/", "/auth/refresh/"];
type AuthRequest = InternalAxiosRequestConfig & { sessionVersion?: number; authRetried?: boolean };
let sessionVersion = 0;
let refreshing: Promise<void> | null = null;
const expireSession = (version: number) => {
  if (version !== sessionVersion) return;
  logout();
  window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT));
};
export const api = axios.create({ baseURL: "/api" });
api.interceptors.request.use((config) => {
  (config as AuthRequest).sessionVersion = sessionVersion;
  const token = localStorage.getItem("modeldesk.access");
  if (!publicAuthPaths.includes(config.url ?? "") && token) config.headers.Authorization = `Bearer ${token}`;
  else config.headers.delete("Authorization");
  return config;
});
api.interceptors.response.use((response) => response, async (error: unknown) => {
  if (!axios.isAxiosError(error)) throw error;
  const config = error.config as AuthRequest | undefined;
  if (error.response?.status !== 401 || !config || publicAuthPaths.includes(config.url ?? "")
    || config.sessionVersion !== sessionVersion) throw error;
  const version = sessionVersion;
  if (config.authRetried) {
    expireSession(version);
    throw error;
  }
  config.authRetried = true;
  // A concurrent request may already have replaced the rejected token.
  const currentAccess = localStorage.getItem("modeldesk.access");
  if (currentAccess && config.headers.Authorization !== `Bearer ${currentAccess}`) return api.request(config);
  const refresh = localStorage.getItem("modeldesk.refresh");
  if (!refresh) {
    expireSession(version);
    throw error;
  }
  if (!refreshing) {
    const request = api.post<{ access: string; refresh?: string }>("/auth/refresh/", { refresh })
      .then(({ data }) => {
        if (sessionVersion !== version || localStorage.getItem("modeldesk.refresh") !== refresh) {
          throw new Error("Session changed during token refresh.");
        }
        if (!data.access) throw new Error("Token refresh returned no access token.");
        localStorage.setItem("modeldesk.access", data.access);
        if (data.refresh) localStorage.setItem("modeldesk.refresh", data.refresh);
      }).catch((reason: unknown) => {
        if (axios.isAxiosError(reason) && [400, 401, 403].includes(reason.response?.status ?? 0)) expireSession(version);
        throw reason;
      });
    refreshing = request;
    void request.finally(() => { if (refreshing === request) refreshing = null; }).catch(() => undefined);
  }
  await refreshing;
  if (sessionVersion !== version) throw error;
  return api.request(config);
});

export type User = { id: number; username: string };
export type AuthResult = { access: string; refresh: string; user?: User };

export async function login(username: string, password: string) {
  const result = (await api.post<AuthResult>("/auth/login/", { username, password })).data;
  sessionVersion++;
  refreshing = null;
  localStorage.setItem("modeldesk.access", result.access);
  localStorage.setItem("modeldesk.refresh", result.refresh);
  return (await currentUser());
}
export type Captcha = { id: string; image: string; expires_in: number };
export async function getCaptcha(signal?: AbortSignal) {
  return (await api.get<Captcha>("/auth/captcha/", { signal })).data;
}
export async function register(username: string, password: string, captcha_id: string, captcha: string) {
  const result = (await api.post<AuthResult>("/auth/register/", { username, password, captcha_id, captcha })).data;
  sessionVersion++;
  refreshing = null;
  localStorage.setItem("modeldesk.access", result.access);
  localStorage.setItem("modeldesk.refresh", result.refresh);
  return result.user as User;
}
export async function currentUser() {
  return (await api.get<User>("/auth/me/")).data;
}
export function logout() {
  sessionVersion++;
  refreshing = null;
  localStorage.removeItem("modeldesk.access");
  localStorage.removeItem("modeldesk.refresh");
}

export async function listTasks() {
  return (await api.get<Task[]>("/tasks/")).data;
}
export type SourceFile = {
  id: string;
  original_name: string;
  extension: string;
  size_bytes: number;
  created_at: string;
  task_count: number;
};
export async function listSourceFiles() {
  return (await api.get<SourceFile[]>("/files/")).data;
}
export type SourceDetail = Omit<SourceFile, "task_count"> & { tasks: Pick<Task, "id" | "target_format" | "status" | "created_at">[] };
export type DeletionResult = { deleted_task_ids: string[]; source_deleted: boolean };
export async function getSourceDetail(id: string, signal?: AbortSignal) {
  return (await api.get<SourceDetail>(`/files/${id}/`, { signal })).data;
}
export async function deleteSource(id: string, taskIds: string[]) {
  return (await api.delete<DeletionResult>(`/files/${id}/`, { data: { task_ids: taskIds } })).data;
}
export async function deleteTask(id: string) {
  return (await api.delete<DeletionResult>(`/tasks/${id}/`)).data;
}
export async function uploadTask(file: File, target_format: string, assets: AssetAttachment[] = []) {
  const body = new FormData();
  body.append("file", file);
  body.append("target_format", target_format);
  assets.forEach((asset) => body.append(asset.kind === "resource" ? "resources" : asset.kind, asset.file));
  return (await api.post<Task>("/files/upload/", body)).data;
}

export async function downloadArtifact(task: Task) {
  if (!task.artifact_url) return;
  const response = await api.get<Blob>(task.artifact_url, { responseType: "blob" });
  const url = URL.createObjectURL(response.data);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${task.source_file.original_name.replace(/\.[^.]+$/, "")}.${task.artifact_kind === "zip" ? "zip" : task.target_format}`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export async function cancelTask(id: string) {
  return (await api.post<Task>(`/tasks/${id}/cancel/`)).data;
}
export async function retryTask(id: string) {
  return (await api.post<Task>(`/tasks/${id}/retry/`)).data;
}
