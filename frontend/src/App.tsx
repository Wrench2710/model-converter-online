import { ChangeEvent, DragEvent, useCallback, useEffect, useMemo, useState } from "react";
import axios from "axios";
import {
  AlertCircle, Box, Check, Clock3, FileArchive, FileUp, FolderOpen, History, Languages,
  LayoutDashboard, LogIn, LogOut, Play, RefreshCw, Eye, ImagePlus, UploadCloud, UserRound, X,
  Monitor, Server, Download, Trash2, Square,
} from "lucide-react";
import { AUTH_EXPIRED_EVENT, currentUser, listSourceFiles, logout, PendingItem, SourceFile, Task, User } from "./api";
import AuthScreen from "./AuthScreen";
import ModelPreview from "./ModelPreview";
import { useTasks } from "./useTasks";
import AttachmentEditor from "./AttachmentEditor";
import TaskHistory from "./TaskHistory";
import SourceLibrary from "./SourceLibrary";
import { taskStatus } from "./taskPresentation";
import { useBrowserTasks } from "./useBrowserTasks";
import { BROWSER_INPUT_LIMIT, BROWSER_OUTPUT_FORMATS, browserError, INPUT_FORMATS, RuntimeKind } from "./runtimePolicy";
import RuntimeNotice from "./RuntimeNotice";
import RuntimeSwitchDialog from "./RuntimeSwitchDialog";

const FORMATS = INPUT_FORMATS;
type Locale = "en" | "zh";
type Page = "workspace" | "history" | "files";
const copy = {
  en: {
    workspace: "Workspace", history: "Task history", files: "Source files", signOut: "Sign out",
    title: "Convert and inspect your models.", refresh: "Refresh", pending: "Pending confirmation",
    pendingHint: "Review a file and output format before it enters the queue.", recent: "Recent tasks",
    queue: "Conversion queue", choose: "Choose file", drop: "Drop a model here", formats: "GLB, GLTF, OBJ, STL, PLY, or FBX up to 200 MB.",
    output: "Output format", start: "Start conversion", remove: "Remove", noTasks: "No conversion tasks yet.",
    noFiles: "No source files yet.", login: "Sign in", create: "Create account", username: "Username", password: "Password",
    welcome: "Private model workspace", loginHint: "Your files and task history stay separated from other users.",
    continue: "Continue", switchAuth: "Need an account?", switchLogin: "Already have an account?", invalid: "Please enter a username and password.",
    detail: "Task detail", cancel: "Cancel", retry: "Retry", confirm: "Confirm", ready: "Ready to convert",
    selected: "selected", language: "Language", runtime: "Conversion runtime", account: "Account",
    preview: "Preview", textures: "Attach textures", attachments: "attachments", sending: "Uploading…",
    invalidFile: "Use a supported model format, up to 200 MB per file.", uploadFailed: "Upload failed. Your pending task is still here.",
    textureNote: "GLB embeds all maps. Other formats include a ZIP with maps and a material-preserving GLB. STL/PLY contain geometry only; OBJ/FBX may not retain every PBR channel.",
  },
  zh: {
    workspace: "工作台", history: "任务历史", files: "源文件", signOut: "退出登录",
    title: "转换并检查你的模型。", refresh: "刷新", pending: "待确认任务",
    pendingHint: "先确认文件与输出格式，再将任务加入转换队列。", recent: "最近任务",
    queue: "转换队列", choose: "选择文件", drop: "拖拽模型到这里", formats: "支持 GLB、GLTF、OBJ、STL、PLY、FBX，最大 200 MB。",
    output: "输出格式", start: "开始转换", remove: "移除", noTasks: "还没有转换任务。",
    noFiles: "还没有源文件。", login: "登录", create: "创建账户", username: "用户名", password: "密码",
    welcome: "私有模型工作区", loginHint: "你的文件与任务记录会和其他用户隔离。",
    continue: "继续", switchAuth: "还没有账户？", switchLogin: "已有账户？", invalid: "请输入用户名和密码。",
    detail: "任务详情", cancel: "取消", retry: "重试", confirm: "确认", ready: "准备转换",
    selected: "已选择", language: "语言", runtime: "转换运行时", account: "账户",
    preview: "预览", textures: "附加贴图", attachments: "个附件", sending: "正在上传…",
    invalidFile: "请选择支持的模型格式，单文件最大 200 MB。", uploadFailed: "上传失败，待确认任务已保留。",
    textureNote: "GLB 内嵌所有贴图。其他格式通过 ZIP 附带贴图与保留材质的 GLB；STL/PLY 仅保存几何，OBJ/FBX 可能无法表达全部 PBR 通道。",
  },
} as const;

const prettyBytes = (size: number) => `${(size / 1024 / 1024).toFixed(1)} MB`;

export default function App() {
  const [locale, setLocale] = useState<Locale>((localStorage.getItem("modeldesk.locale") as Locale) || "zh");
  const [user, setUser] = useState<User | null>(null);
  const [runtime, setRuntime] = useState<RuntimeKind>("server");
  const [authOpen, setAuthOpen] = useState(true);
  const [confirmRuntimeSwitch, setConfirmRuntimeSwitch] = useState(false);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [page, setPage] = useState<Page>("workspace");
  const [serverPending, setServerPending] = useState<PendingItem[]>([]);
  const [browserPending, setBrowserPending] = useState<PendingItem[]>([]);
  const isBrowser = runtime === "browser";
  const pending = isBrowser ? browserPending : serverPending;
  const setPending = isBrowser ? setBrowserPending : setServerPending;
  const [pendingPreviewId, setPendingPreviewId] = useState<string | null>(null);
  const [editingTextures, setEditingTextures] = useState(false);
  const [previewExpanded, setPreviewExpanded] = useState(true);
  const [previewResetKey, setPreviewResetKey] = useState(0);
  const [historySourceId, setHistorySourceId] = useState("");
  const [focusedSourceId, setFocusedSourceId] = useState("");
  const [uploading, setUploading] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [sources, setSources] = useState<SourceFile[]>([]);
  const [dragging, setDragging] = useState(false);
  const serverTasks = useTasks(!isBrowser && !authOpen ? user?.id ?? null : null);
  const browserTasks = useBrowserTasks(isBrowser && !authOpen);
  const { tasks, queue, selectedId, setSelectedId, refresh, add, cancel, retry, remove } = isBrowser ? browserTasks : serverTasks;
  const outputFormats = isBrowser ? BROWSER_OUTPUT_FORMATS : FORMATS;
  const t = copy[locale];
  const selected = useMemo(() => tasks.find((task) => task.id === selectedId), [selectedId, tasks]);
  const refreshSources = useCallback(async () => {
    if (!isBrowser && user) setSources(await listSourceFiles());
  }, [user?.id, isBrowser]);
  const pendingPreview = pending.find((item) => item.id === pendingPreviewId);
  const materialPanelOpen = editingTextures && Boolean(pendingPreview);
  useEffect(() => {
    if (page === "history") setPendingPreviewId(null);
  }, [page]);
  useEffect(() => {
    setPreviewExpanded(!materialPanelOpen);
  }, [page, materialPanelOpen]);
  useEffect(() => {
    if (!previewExpanded) return;
    const exitExpanded = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPreviewExpanded(false);
    };
    window.addEventListener("keydown", exitExpanded);
    return () => window.removeEventListener("keydown", exitExpanded);
  }, [previewExpanded]);

  useEffect(() => {
    const expired = () => { setUser(null); setSessionExpired(true); setAuthOpen(true); };
    window.addEventListener(AUTH_EXPIRED_EVENT, expired);
    return () => window.removeEventListener(AUTH_EXPIRED_EVENT, expired);
  }, []);
  useEffect(() => {
    if (!authOpen || user || !localStorage.getItem("modeldesk.access")) return;
    let active = true;
    currentUser().then((authenticated) => {
      if (active) { setUser(authenticated); setRuntime("server"); setAuthOpen(false); }
    }).catch(() => undefined);
    return () => { active = false; };
  }, [authOpen, user]);
  useEffect(() => { localStorage.setItem("modeldesk.locale", locale); }, [locale]);
  useEffect(() => {
    if (!isBrowser && user) refreshSources().catch(() => undefined);
    else setSources([]);
  }, [user?.id, tasks, refreshSources, isBrowser]);
  useEffect(() => {
    if (historySourceId && !sources.some((source) => source.id === historySourceId)) setHistorySourceId("");
  }, [sources, historySourceId]);

  useEffect(() => {
    if (!isBrowser) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (browserPending.length || browserTasks.runtime.hasUnfinishedWork) { event.preventDefault(); event.returnValue = ""; }
    };
    const clearPending = () => { setBrowserPending([]); setPendingPreviewId(null); setEditingTextures(false); };
    window.addEventListener("beforeunload", beforeUnload);
    window.addEventListener("pagehide", clearPending);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      window.removeEventListener("pagehide", clearPending);
    };
  }, [isBrowser, browserPending.length, browserTasks.runtime]);

  const enterServer = () => {
    browserTasks.runtime.clear();
    setBrowserPending([]);
    setPendingPreviewId(null);
    setEditingTextures(false);
    setConfirmRuntimeSwitch(false);
    setPage("workspace");
    setError("");
    if (user) setRuntime("server");
    else setAuthOpen(true);
  };
  const requestServer = () => {
    if (isBrowser && (browserPending.length || browserTasks.runtime.hasUnfinishedWork)) setConfirmRuntimeSwitch(true);
    else enterServer();
  };
  const changeRuntime = (next: RuntimeKind) => {
    if (next === runtime) return;
    if (next === "server") { requestServer(); return; }
    setRuntime("browser");
    setPage("workspace");
    setPendingPreviewId(null);
    setEditingTextures(false);
    setError("");
  };
  const signOut = () => {
    logout();
    browserTasks.runtime.clear();
    setUser(null);
    setServerPending([]);
    setBrowserPending([]);
    setSources([]);
    setRuntime("server");
    setAuthOpen(true);
    setSessionExpired(false);
    setPage("workspace");
    setPendingPreviewId(null);
    setEditingTextures(false);
    setError("");
  };
  if (authOpen) return <AuthScreen locale={locale} onLocaleChange={setLocale} sessionExpired={sessionExpired}
    onGuest={() => {
      logout();
      setUser(null);
      setServerPending([]);
      setBrowserPending([]);
      setRuntime("browser");
      setAuthOpen(false);
      setPage("workspace");
      setPendingPreviewId(null);
      setEditingTextures(false);
      setSessionExpired(false);
      setError("");
    }}
    onAuthenticated={(authenticated) => {
      setUser(authenticated); setRuntime("server"); setAuthOpen(false); setPage("workspace"); setSessionExpired(false); setError("");
    }} />;
  const addPending = (files: FileList | File[]) => {
    const items: PendingItem[] = [];
    let invalid: "input_limit" | "unsupported_format" | undefined;
    for (const file of Array.from(files)) {
      const extension = file.name.split(".").pop()?.toLowerCase();
      if (!extension || !FORMATS.includes(extension)) { invalid = "unsupported_format"; continue; }
      if (file.size > (isBrowser ? BROWSER_INPUT_LIMIT : 200 * 1024 ** 2)) { invalid = "input_limit"; continue; }
      const safeTarget = extension === "glb" ? "gltf" : "glb";
      items.push({ id: crypto.randomUUID(), file, target: safeTarget, assets: [] });
    }
    setPending((current) => [...current, ...items]);
    if (items[0]) { setPendingPreviewId(items[0].id); setPreviewResetKey((value) => value + 1); }
    setError(invalid ? isBrowser ? browserError(invalid, locale) : t.invalidFile : "");
  };
  const drop = (event: DragEvent<HTMLDivElement>) => { event.preventDefault(); setDragging(false); addPending(event.dataTransfer.files); };
  const choose = (event: ChangeEvent<HTMLInputElement>) => { if (event.target.files) addPending(event.target.files); event.target.value = ""; };
  const startPending = async (item: PendingItem) => {
    if (uploading.includes(item.id)) return;
    setUploading((ids) => [...ids, item.id]);
    setError("");
    try {
      await add(item.file, item.target, item.assets);
      setPending((items) => items.filter((entry) => entry.id !== item.id));
      setPendingPreviewId((id) => id === item.id ? null : id);
    } catch (reason) {
      setError(isBrowser && reason instanceof Error ? browserError(reason.message, locale)
        : axios.isAxiosError(reason) ? reason.response?.data?.detail ?? t.uploadFailed : t.uploadFailed);
    } finally { setUploading((ids) => ids.filter((id) => id !== item.id)); }
  };
  const selectPending = (id: string) => {
    setPendingPreviewId(id);
    setPreviewResetKey((value) => value + 1);
  };
  const selectTask = (task: Task) => {
    setSelectedId(task.id);
    setPendingPreviewId(null);
    setEditingTextures(false);
    setPreviewResetKey((value) => value + 1);
    setPage("workspace");
  };
  const taskAction = async (action: () => Promise<void>) => {
    setError("");
    try { await action(); }
    catch (reason) { setError(isBrowser && reason instanceof Error ? browserError(reason.message, locale)
      : locale === "zh" ? "操作失败，请稍后重试。" : "The action failed. Please try again."); }
  };
  const removed = (ids: string[]) => {
    remove(ids);
    refresh().catch(() => undefined);
    refreshSources().catch(() => undefined);
  };
  const nav = (next: Page) => { if (!isBrowser || next === "workspace") setPage(next); };
  const zh = locale === "zh";
  const browserFormats = zh ? "GLB、GLTF、OBJ、STL、PLY、FBX；模型及附件合计 ≤ 100 MB。" : "GLB, GLTF, OBJ, STL, PLY, FBX. Model + attachments ≤ 100 MB.";
  return <div className={`app-shell ${page === "workspace" ? "workspace-page" : ""} ${previewExpanded && page === "workspace" ? "preview-expanded" : ""}`}>
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark"><Box size={19} /></div><div><strong>Model Desk</strong><span>conversion studio</span></div></div>
      <nav>
        <button className={`nav-item ${page === "workspace" ? "active" : ""}`} onClick={() => nav("workspace")}><LayoutDashboard size={17} /> {t.workspace}</button>
        <button className={`nav-item ${page === "history" ? "active" : ""}`} disabled={isBrowser}
          title={isBrowser ? zh ? "服务端运行时可用" : "Available in the server runtime" : t.history}
          onClick={() => nav("history")}><History size={17} /> {t.history}<span className="nav-count">{isBrowser ? "—" : tasks.length}</span></button>
        <button className={`nav-item ${page === "files" ? "active" : ""}`} disabled={isBrowser}
          title={isBrowser ? zh ? "服务端运行时可用" : "Available in the server runtime" : t.files}
          onClick={() => nav("files")}><FolderOpen size={17} /> {t.files}</button>
      </nav>
      <div className="sidebar-footer"><span className="status-dot" /><span>{isBrowser ? zh ? "浏览器运行时" : "Browser runtime" : zh ? "服务端运行时" : "Server runtime"}</span></div>
      <div className="sidebar-account"><UserRound size={15} /><span>{user?.username ?? (zh ? "游客模式" : "Guest mode")}</span>
        <button title={user ? t.signOut : t.login} aria-label={user ? t.signOut : t.login}
          onClick={() => {
            if (!user) { requestServer(); return; }
            signOut();
          }}>{user ? <LogOut size={15} /> : <LogIn size={15} />}</button></div>
    </aside>
    <main className="main-panel">
      <header className="topbar"><div><span className="eyebrow">{page === "workspace" ? "WORKSPACE" : page === "history" ? "TASK HISTORY" : "SOURCE LIBRARY"}</span><h1>{page === "workspace" ? t.workspace : page === "history" ? t.history : t.files}</h1></div>
        <div className="topbar-actions">
          <label className="runtime-selector" title={zh ? "转换运行时" : "Conversion runtime"}>
            {isBrowser ? <Monitor size={15} /> : <Server size={15} />}
            <select aria-label={zh ? "转换运行时" : "Conversion runtime"} value={runtime} disabled={uploading.length > 0}
              onChange={(event) => changeRuntime(event.target.value as RuntimeKind)}>
              <option value="browser">{zh ? "浏览器" : "Browser"}</option>
              <option value="server" disabled={!user}>{zh ? user ? "服务端" : "服务端（需登录）" : user ? "Server" : "Server (sign in)"}</option>
            </select>
          </label>
          <div className="language-switch"><Languages size={14} /><button className={locale === "en" ? "active" : ""} onClick={() => setLocale("en")}>EN</button><button className={locale === "zh" ? "active" : ""} onClick={() => setLocale("zh")}>中</button></div>
          <button className="icon-button refresh-button" title={t.refresh} aria-label={t.refresh} onClick={() => taskAction(async () => { await Promise.all([refresh(), refreshSources()]); })}><RefreshCw size={15} /></button>
        </div>
      </header>
      {isBrowser && <RuntimeNotice locale={locale} signedIn={Boolean(user)} usedBytes={browserTasks.runtime.usedBytes} onServer={requestServer} />}
      {page !== "workspace" && error && <p className="inline-error page-error" role="alert">{error}</p>}
      {page === "files" ? <section className="content-section">
        <div className="section-heading"><h2>{t.files}</h2><span className="count-badge">{sources.length}</span></div>
        <SourceLibrary sources={sources} locale={locale} focusedId={focusedSourceId} onRemoved={removed} onRefresh={refreshSources}
          onViewTasks={(id) => { setHistorySourceId(id); setPage("history"); }} />
      </section> : page === "history" ? <section className="content-section">
        <TaskHistory tasks={tasks} sources={sources} locale={locale} sourceId={historySourceId} onSourceChange={setHistorySourceId}
          onPreview={selectTask} onOpenSource={(id) => { setFocusedSourceId(id); setPage("files"); }}
          onRemoved={removed} onRefresh={refresh} onRetry={async (id) => { await retry(id); setPendingPreviewId(null); setPage("workspace"); setPreviewResetKey((value) => value + 1); }} />
      </section> : <section className="workspace-grid">
        <div className="left-column">
          <div className="upload-card" onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={drop}>
            <div className={`drop-zone ${dragging ? "is-dragging" : ""}`}><UploadCloud size={24} /><h2>{t.drop}</h2><p>{isBrowser ? browserFormats : t.formats}</p><label className="primary-button file-picker"><FileUp size={16} /> {t.choose}<input type="file" aria-label={t.choose} multiple accept=".glb,.gltf,.obj,.stl,.ply,.fbx" onChange={choose} /></label></div>
          </div>
          <div className="section-heading"><div><span className="eyebrow">{pending.length ? "ACTION REQUIRED" : "READY"}</span><h2>{t.pending}</h2></div><span className="count-badge">{pending.length}</span></div>
          <p className="section-hint">{t.pendingHint}</p>
          {error && <p className="inline-error" role="alert">{error}</p>}
          <div className="pending-list">{pending.length ? pending.map((item) => <div className={`pending-row ${pendingPreviewId === item.id ? "selected" : ""}`} key={item.id} data-testid="pending-item">
            <button className="pending-select" aria-label={`${t.preview} ${item.file.name}`} aria-pressed={pendingPreviewId === item.id} onClick={() => selectPending(item.id)}>
              <div className="file-icon"><FileArchive size={17} /></div><div className="task-copy"><strong>{item.file.name}</strong><span>{prettyBytes(item.file.size)} · {item.assets.length} {t.attachments}</span></div><Eye size={16} />
            </button>
            <div className="pending-controls">
              <select aria-label={`${t.output} ${item.file.name}`} value={item.target} disabled={uploading.includes(item.id)}
                onChange={(event) => setPending((items) => items.map((entry) => entry.id === item.id ? { ...entry, target: event.target.value } : entry))}>
                {outputFormats.filter((format) => format !== item.file.name.split(".").pop()?.toLowerCase()).map((format) => <option key={format}>{format}</option>)}
              </select>
              <div className="pending-actions">
                <button className="icon-button" title={t.textures} aria-label={`${t.textures} ${item.file.name}`} disabled={uploading.includes(item.id)} onClick={() => { selectPending(item.id); setEditingTextures(true); setPreviewExpanded(false); }}><ImagePlus size={17} /></button>
                <button className="icon-button" title={t.remove} aria-label={`${t.remove} ${item.file.name}`} disabled={uploading.includes(item.id)} onClick={() => { setPending((items) => items.filter((entry) => entry.id !== item.id)); if (pendingPreviewId === item.id) setPendingPreviewId(null); }}><X size={15} /></button>
                <button className="icon-button start-button" title={uploading.includes(item.id) ? t.sending : t.start} aria-label={uploading.includes(item.id) ? t.sending : t.start} disabled={uploading.includes(item.id)} onClick={() => startPending(item)}><Play size={16} /></button>
              </div>
            </div>
          </div>) : <div className="empty-state compact-empty"><Check size={20} /><p>{t.ready}</p></div>}</div>
          <div className="section-heading"><h2>{t.queue}</h2><span className="count-badge">{queue.length}</span></div>
          <div className="task-list" data-testid="conversion-queue">{queue.length ? queue.map((task) => isBrowser
            ? <BrowserTaskRow key={task.id} task={task} locale={locale} selected={!pendingPreview && selected?.id === task.id}
                available={browserTasks.runtime.available(task.id)} onClick={() => selectTask(task)}
                onDownload={() => browserTasks.runtime.download(task.id)} onRemove={() => remove([task.id])}
                onCancel={() => taskAction(() => cancel(task.id))} onRetry={() => taskAction(() => retry(task.id))} />
            : <TaskRow key={task.id} task={task} locale={locale} selected={!pendingPreview && selected?.id === task.id} onClick={() => selectTask(task)} />)
            : <div className="empty-state"><Clock3 size={20} /><p>{t.noTasks}</p></div>}</div>
        </div>
        <div className="right-column">
          {editingTextures && pendingPreview && <fieldset className="attachment-fieldset" disabled={uploading.includes(pendingPreview.id)}>
            <AttachmentEditor item={pendingPreview} locale={locale} browser={isBrowser} onClose={() => setEditingTextures(false)}
              onChange={(assets) => setPending((items) => items.map((item) => item.id === pendingPreview.id ? { ...item, assets } : item))} />
          </fieldset>}
          <ModelPreview pending={pendingPreview} task={pendingPreview ? undefined : selected} locale={locale}
            browserPreview={isBrowser && !pendingPreview ? browserTasks.runtime.getPreview(selectedId) : undefined}
            expanded={previewExpanded} onToggleExpanded={() => setPreviewExpanded((current) => !current)} resetKey={previewResetKey} />
          {(pendingPreview || selected) && <p className="format-notice">{t.textureNote}</p>}
          {!pendingPreview && selected && <div className="detail-bar"><div><span className="eyebrow">{t.detail.toUpperCase()}</span><strong>{selected.source_file.extension.toUpperCase()} → {selected.target_format.toUpperCase()}</strong></div><div className="detail-actions">{["queued", "running"].includes(selected.status) && <button className="ghost-button" onClick={() => taskAction(() => cancel(selected.id))}>{t.cancel}</button>}{["failed", "canceled"].includes(selected.status) && <button className="primary-button compact" onClick={() => taskAction(() => retry(selected.id))}>{t.retry}</button>}{selected.error_message && <span className="error-text"><AlertCircle size={15} /> {isBrowser ? browserError(selected.error_message, locale) : selected.error_message}</span>}</div></div>}
        </div>
      </section>}
    </main>
    {confirmRuntimeSwitch && <RuntimeSwitchDialog locale={locale} onConfirm={enterServer} onClose={() => setConfirmRuntimeSwitch(false)} />}
  </div>;
}

function TaskRow({ task, selected, onClick, locale }: { task: Task; selected: boolean; onClick: () => void; locale: Locale }) {
  const pretty = `${(task.source_file.size_bytes / 1024 / 1024).toFixed(1)} MB`;
  const phase = task.phase ? ({
    reading: locale === "zh" ? "读取模型" : "Reading",
    exporting: locale === "zh" ? "转换模型" : "Exporting",
    packaging: locale === "zh" ? "打包资源" : "Packaging",
  })[task.phase] : "";
  return <button className={`task-row ${selected ? "selected" : ""}`} onClick={onClick}><div className="file-icon"><Box size={17} /></div><div className="task-copy"><strong>{task.source_file.original_name}</strong><span>{task.source_file.extension.toUpperCase()} → {task.target_format.toUpperCase()} · {pretty}</span></div><div className="task-state"><span className={`state-dot ${task.status}`} />{taskStatus(task.status, locale)}<small>{task.runtime === "browser" ? phase : `${task.progress}%`}</small></div></button>;
}

function BrowserTaskRow({ task, selected, onClick, locale, available, onDownload, onRemove, onCancel, onRetry }: {
  task: Task; selected: boolean; onClick: () => void; locale: Locale; available: boolean;
  onDownload: () => void; onRemove: () => void; onCancel: () => void; onRetry: () => void;
}) {
  const zh = locale === "zh";
  const active = ["queued", "running"].includes(task.status);
  const downloadLabel = available ? zh ? "下载转换产物" : "Download conversion artifact" : zh ? "暂无结果或结果已释放" : "No result, or result released";
  const removeLabel = zh ? "删除任务和临时结果" : "Delete task and temporary result";
  return <article className="browser-task" data-task-id={task.id}>
    <TaskRow task={task} selected={selected} onClick={onClick} locale={locale} />
    <div className="browser-task-actions">
      <span>{available
        ? `${zh ? "释放于" : "Expires"} ${new Date(task.artifact_expires_at!).toLocaleTimeString(zh ? "zh-CN" : "en-US", { hour: "2-digit", minute: "2-digit" })}`
        : task.status === "succeeded" ? zh ? "临时结果已释放" : "Result released" : zh ? "仅本次会话" : "This session only"}</span>
      {active && <button className="icon-button" title={zh ? "取消转换" : "Cancel conversion"} onClick={onCancel} aria-label={zh ? "取消转换" : "Cancel conversion"}><Square size={14} /></button>}
      {["failed", "canceled"].includes(task.status) && <button className="icon-button" title={zh ? "重试" : "Retry"} onClick={onRetry} aria-label={zh ? "重试" : "Retry"}><RefreshCw size={14} /></button>}
      <button className="icon-button" disabled={!available} title={downloadLabel} aria-label={`${zh ? "下载转换产物" : "Download conversion artifact"} ${task.id}`} onClick={onDownload}><Download size={15} /></button>
      <button className="icon-button danger-button" title={removeLabel} aria-label={`${removeLabel} ${task.id}`} onClick={onRemove}><Trash2 size={15} /></button>
    </div>
    {task.error_message && <p className="inline-error browser-task-error" role="alert">{browserError(task.error_message, locale)}</p>}
  </article>;
}
