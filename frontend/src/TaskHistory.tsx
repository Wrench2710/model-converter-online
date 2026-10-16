import axios from "axios";
import { useEffect, useState } from "react";
import { Clock3, Download, Eye, FolderOpen, RefreshCw, Search, Trash2 } from "lucide-react";
import { deleteTask, downloadArtifact, SourceFile, Task } from "./api";
import ConfirmDeletion from "./ConfirmDeletion";
import { taskDate, taskStatus } from "./taskPresentation";

const copy = {
  zh: {
    all: "全部源文件", search: "搜索文件名或任务编号", empty: "没有匹配的转换记录。", download: "下载转换产物",
    preview: "预览", source: "查看源文件", remove: "删除任务", retry: "重试", expired: "产物已过期", unavailable: "暂无产物",
    until: "可下载至", failed: "操作失败，请稍后重试。", downloadExpired: "产物已过期，转换记录仍然保留。",
    deleteTitle: "删除转换任务？", deleteBody: "将永久删除这条记录、附加贴图和未被其他任务使用的转换产物。",
    shared: "源文件仍被其他任务使用，将继续保留。", orphan: "这是源文件的最后一条转换记录，源文件也将删除。",
    active: "正在排队或运行的转换会停止，转换结果将被丢弃。",
  },
  en: {
    all: "All source files", search: "Search filename or task ID", empty: "No matching conversions.", download: "Download conversion artifact",
    preview: "Preview", source: "View source file", remove: "Delete task", retry: "Retry", expired: "Artifact expired", unavailable: "No artifact",
    until: "Download until", failed: "The action failed. Please try again.", downloadExpired: "The artifact expired. Its conversion record is retained.",
    deleteTitle: "Delete conversion task?", deleteBody: "Permanently delete this record, its attached maps, and artifacts no other task uses.",
    shared: "The source file is used by other tasks and will be kept.", orphan: "This is the source file's last conversion record. The source will also be deleted.",
    active: "Queued or running conversion will stop and its result will be discarded.",
  },
};

export default function TaskHistory({ tasks, sources, locale, sourceId, onSourceChange, onPreview, onOpenSource, onRemoved, onRetry, onRefresh }: {
  tasks: Task[]; sources: SourceFile[]; locale: "zh" | "en"; sourceId: string;
  onSourceChange: (id: string) => void; onPreview: (task: Task) => void; onOpenSource: (id: string) => void;
  onRemoved: (ids: string[]) => void; onRetry: (id: string) => Promise<void>; onRefresh: () => Promise<void>;
}) {
  const t = copy[locale];
  const [query, setQuery] = useState("");
  const [deleting, setDeleting] = useState<Task | null>(null);
  const [busy, setBusy] = useState(false);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [deleteError, setDeleteError] = useState("");
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const filtered = tasks.filter((task) => (!sourceId || task.source_file.id === sourceId)
    && `${task.source_file.original_name} ${task.id}`.toLowerCase().includes(query.trim().toLowerCase()));
  const download = async (task: Task) => {
    setDownloading(task.id);
    setError("");
    try { await downloadArtifact(task); }
    catch (reason) {
      setError(axios.isAxiosError(reason) && reason.response?.status === 410 ? t.downloadExpired : t.failed);
      await onRefresh().catch(() => undefined);
    } finally { setDownloading(null); }
  };
  const confirm = async () => {
    if (!deleting || busy) return;
    setBusy(true);
    setDeleteError("");
    try {
      const result = await deleteTask(deleting.id);
      onRemoved(result.deleted_task_ids);
      setDeleting(null);
    } catch { setDeleteError(t.failed); }
    finally { setBusy(false); }
  };
  return <>
    <div className="history-filters">
      <label className="history-search"><Search size={15} /><input type="search" aria-label={t.search} placeholder={t.search}
        value={query} onChange={(event) => setQuery(event.target.value)} /></label>
      <select aria-label={locale === "zh" ? "按源文件筛选" : "Filter by source"} value={sourceId} onChange={(event) => onSourceChange(event.target.value)}>
        <option value="">{t.all}</option>
        {sources.map((source) => <option key={source.id} value={source.id}>{source.original_name}</option>)}
      </select>
      <span className="count-badge">{filtered.length}</span>
    </div>
    {error && <p className="inline-error" role="alert">{error}</p>}
    <div className="history-records">
      {filtered.map((task) => {
        const available = task.status === "succeeded" && Boolean(task.artifact_url)
          && (!task.artifact_expires_at || new Date(task.artifact_expires_at).getTime() > now);
        return <article className="history-record" key={task.id} data-testid="history-item" data-task-id={task.id}>
          <button className="history-preview" aria-label={`${t.preview} ${task.source_file.original_name} ${task.id}`} onClick={() => onPreview(task)}>
            <Eye size={17} /><div><strong>{task.source_file.original_name}</strong>
              <span>{task.source_file.extension.toUpperCase()} → {task.target_format.toUpperCase()} · #{task.id.slice(0, 8)}</span>
              <time dateTime={task.created_at}>{taskDate(task.created_at, locale)}</time>
            </div>
          </button>
          <div className="history-status">
            <strong><span className={`state-dot ${task.status}`} />{taskStatus(task.status, locale)}{["queued", "running"].includes(task.status) ? ` · ${task.progress}%` : ""}</strong>
            <span>{available ? `${t.until} ${task.artifact_expires_at ? taskDate(task.artifact_expires_at, locale) : "—"}` : task.status === "succeeded" ? t.expired : t.unavailable}</span>
            {task.error_message && <span className="error-text">{task.error_message}</span>}
          </div>
          <div className="history-actions">
            <button className="icon-button" title={t.source} aria-label={`${t.source} ${task.source_file.original_name}`} onClick={() => onOpenSource(task.source_file.id)}><FolderOpen size={17} /></button>
            {["failed", "canceled"].includes(task.status) && <button className="icon-button" title={t.retry} aria-label={`${t.retry} ${task.id}`}
              onClick={() => { setError(""); onRetry(task.id).catch(() => setError(t.failed)); }}><RefreshCw size={17} /></button>}
            <button className="icon-button" title={available ? t.download : task.status === "succeeded" ? t.expired : t.unavailable}
              aria-label={`${t.download} ${task.id}`} disabled={!available || downloading !== null} onClick={() => download(task)}><Download size={17} /></button>
            <button className="icon-button danger-button" title={t.remove} aria-label={`${t.remove} ${task.id}`}
              onClick={() => { setDeleteError(""); setDeleting(task); }}><Trash2 size={17} /></button>
          </div>
        </article>;
      })}
      {!filtered.length && <div className="empty-state"><Clock3 size={20} /><p>{t.empty}</p></div>}
    </div>
    {deleting && <ConfirmDeletion title={t.deleteTitle} busy={busy} error={deleteError} locale={locale} onConfirm={confirm} onClose={() => setDeleting(null)}>
      <p>{t.deleteBody}</p>
      <div className="deletion-target"><strong>{deleting.source_file.original_name}</strong>
        <span>{deleting.source_file.extension.toUpperCase()} → {deleting.target_format.toUpperCase()} · #{deleting.id.slice(0, 8)}</span></div>
      <p>{tasks.some((task) => task.id !== deleting.id && task.source_file.id === deleting.source_file.id) ? t.shared : t.orphan}</p>
      {["queued", "running"].includes(deleting.status) && <p>{t.active}</p>}
    </ConfirmDeletion>}
  </>;
}
