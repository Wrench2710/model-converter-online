import { ReactNode, useEffect, useRef } from "react";
import { Trash2 } from "lucide-react";

export default function ConfirmDeletion({ title, children, busy, disabled, error, locale, onConfirm, onClose }: {
  title: string; children: ReactNode; busy: boolean; disabled?: boolean; error: string; locale: "zh" | "en";
  onConfirm: () => void; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current!;
    const previous = document.activeElement as HTMLElement | null;
    element.showModal();
    return () => { element.close(); previous?.focus(); };
  }, []);
  return <dialog ref={dialog} className="delete-dialog" aria-labelledby="deletion-title"
    onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
    <h2 id="deletion-title">{title}</h2>
    <div className="deletion-body">{children}</div>
    {error && <p className="inline-error" role="alert">{error}</p>}
    <div className="deletion-actions">
      <button className="ghost-button" autoFocus disabled={busy} onClick={onClose}>{locale === "zh" ? "取消" : "Cancel"}</button>
      <button className="primary-button danger-button" disabled={busy || disabled} onClick={onConfirm}>
        <Trash2 size={15} />{busy ? (locale === "zh" ? "正在删除…" : "Deleting…") : (locale === "zh" ? "确认删除" : "Delete permanently")}
      </button>
    </div>
  </dialog>;
}
