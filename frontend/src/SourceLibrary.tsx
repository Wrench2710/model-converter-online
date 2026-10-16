import axios from "axios";
import { useEffect, useState } from "react";
import { FileArchive, FolderOpen, History, Trash2 } from "lucide-react";
import { deleteSource, getSourceDetail, SourceDetail, SourceFile } from "./api";
import ConfirmDeletion from "./ConfirmDeletion";
import { taskDate, taskStatus } from "./taskPresentation";

export default function SourceLibrary({ sources, locale, focusedId, onViewTasks, onRemoved, onRefresh }: {
  sources: SourceFile[]; locale: "zh" | "en"; focusedId: string;
  onViewTasks: (sourceId: string) => void; onRemoved: (ids: string[]) => void; onRefresh: () => Promise<void>;
}) {
  const zh = locale === "zh";
  const [selected, setSelected] = useState<SourceFile | null>(null);
  const [detail, setDetail] = useState<SourceDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (focusedId) document.getElementById(`source-${focusedId}`)?.scrollIntoView({ block: "center" });
  }, [focusedId]);
  useEffect(() => {
    if (!selected) return;
    const abort = new AbortController();
    setLoading(true);
    setDetail(null);
    setError("");
    getSourceDetail(selected.id, abort.signal).then((data) => { if (!abort.signal.aborted) setDetail(data); })
      .catch(() => { if (!abort.signal.aborted) setError(zh ? "无法读取关联任务，请稍后重试。" : "Could not load linked tasks. Try again."); })
      .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [selected, zh]);
  const confirm = async () => {
    if (!selected || !detail || busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await deleteSource(selected.id, detail.tasks.map((task) => task.id));
      onRemoved(result.deleted_task_ids);
      setSelected(null);
      await onRefresh();
    } catch (reason) {
      if (axios.isAxiosError(reason) && reason.response?.status === 409) {
        setDetail(null);
        try { setDetail(await getSourceDetail(selected.id)); }
        catch { /* Keep deletion disabled until the source can be reviewed again. */ }
        setError(zh ? "关联任务已变化，请检查更新后的列表，再次确认。" : "Linked tasks changed. Review the updated list and confirm again.");
      } else setError(zh ? "删除失败，请稍后重试。" : "Deletion failed. Please try again.");
    } finally { setBusy(false); }
  };
  return <>
    <div className="source-records">
      {sources.map((source) => <article key={source.id} id={`source-${source.id}`} data-testid="source-item"
        className={`source-record ${focusedId === source.id ? "selected" : ""}`}>
        <div className="file-icon"><FileArchive size={17} /></div>
        <div className="source-copy"><strong>{source.original_name}</strong>
          <span>{source.extension.toUpperCase()} · {(source.size_bytes / 1024 / 1024).toFixed(1)} MB · {taskDate(source.created_at, locale)}</span>
          <span>{source.task_count ?? 0} {zh ? "条关联转换任务" : "linked conversions"}</span>
        </div>
        <div className="history-actions">
          <button className="icon-button" title={zh ? "查看关联任务" : "View linked tasks"} aria-label={`${zh ? "查看关联任务" : "View linked tasks"} ${source.original_name}`}
            onClick={() => onViewTasks(source.id)}><History size={17} /></button>
          <button className="icon-button danger-button" title={zh ? "删除源文件" : "Delete source file"} aria-label={`${zh ? "删除源文件" : "Delete source file"} ${source.original_name}`}
            onClick={() => setSelected(source)}><Trash2 size={17} /></button>
        </div>
      </article>)}
      {!sources.length && <div className="empty-state"><FolderOpen size={20} /><p>{zh ? "还没有源文件。" : "No source files yet."}</p></div>}
    </div>
    {selected && <ConfirmDeletion title={zh ? "删除源文件及关联任务？" : "Delete source file and linked tasks?"} busy={busy}
      disabled={loading || !detail} error={error} locale={locale} onConfirm={confirm} onClose={() => setSelected(null)}>
      <div className="deletion-target"><strong>{selected.original_name}</strong></div>
      <p>{zh ? "将永久删除源文件、以下转换记录及其贴图和产物。此操作无法撤销。" : "Permanently delete this source, the records below, and their maps and artifacts. This cannot be undone."}</p>
      {loading ? <p role="status">{zh ? "正在读取关联任务…" : "Loading linked tasks…"}</p> : detail && <>
        <strong>{detail.tasks.length} {zh ? "条关联转换任务" : "linked conversions"}</strong>
        <ul className="deletion-task-list">
          {detail.tasks.map((task) => <li key={task.id}>
            <strong>#{task.id.slice(0, 8)} · {selected.extension.toUpperCase()} → {task.target_format.toUpperCase()}</strong>
            <span>{taskStatus(task.status, locale)} · {taskDate(task.created_at, locale)}</span>
          </li>)}
        </ul>
        {detail.tasks.some((task) => ["queued", "running"].includes(task.status)) && <p>{zh ? "正在排队或运行的转换会停止，转换结果将被丢弃。" : "Queued or running conversions will stop and their results will be discarded."}</p>}
      </>}
    </ConfirmDeletion>}
  </>;
}
