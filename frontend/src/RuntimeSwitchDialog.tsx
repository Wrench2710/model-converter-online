import { useEffect, useRef } from "react";
import { ArrowRight } from "lucide-react";

export default function RuntimeSwitchDialog({ locale, onConfirm, onClose }: {
  locale: "zh" | "en"; onConfirm: () => void; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current!;
    const previous = document.activeElement as HTMLElement | null;
    element.showModal();
    return () => { element.close(); previous?.focus(); };
  }, []);
  const zh = locale === "zh";
  return <dialog ref={dialog} className="delete-dialog" aria-labelledby="runtime-switch-title"
    onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <h2 id="runtime-switch-title">{zh ? "离开浏览器运行时？" : "Leave the browser runtime?"}</h2>
    <div className="deletion-body"><p>{zh
      ? "本次浏览器会话的待确认文件、转换任务和临时结果将被清空，运行中的浏览器转换会停止。请先下载需要的结果。"
      : "Pending files, browser tasks and temporary results will be cleared, and active browser conversions will stop. Download any results you need first."}</p></div>
    <div className="deletion-actions">
      <button className="ghost-button" autoFocus onClick={onClose}>{zh ? "取消" : "Cancel"}</button>
      <button className="primary-button" onClick={onConfirm}><ArrowRight size={15} />{zh ? "清空并继续" : "Clear and continue"}</button>
    </div>
  </dialog>;
}
