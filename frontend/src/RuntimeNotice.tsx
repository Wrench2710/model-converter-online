import { AlertTriangle, LogIn, Server } from "lucide-react";

export default function RuntimeNotice({ locale, signedIn, usedBytes, onServer }: {
  locale: "zh" | "en"; signedIn: boolean; usedBytes: number; onServer: () => void;
}) {
  const zh = locale === "zh";
  return <aside className="runtime-notice" role="alert">
    <AlertTriangle size={18} />
    <div>
      <strong>{zh ? "浏览器运行时" : "Browser runtime"}</strong>
      <p>{zh
        ? "不支持 OBJ、FBX 输出及持久化历史。模型与附件合计 ≤ 100 MB；结果十分钟后清理，刷新或切换运行时将丢失。"
        : "OBJ/FBX export and persistent history are unavailable. Inputs total ≤ 100 MB. Results expire in 10 minutes and are cleared on reload or runtime switch."}</p>
      <span>{zh ? "临时结果" : "Temporary results"}: {(usedBytes / 1024 ** 2).toFixed(1)} / 200 MB</span>
    </div>
    <button className="ghost-button compact" onClick={onServer}>
      {signedIn ? <Server size={14} /> : <LogIn size={14} />}
      {signedIn ? zh ? "切换服务端" : "Use server" : zh ? "登录使用更多功能" : "Sign in for more"}
    </button>
  </aside>;
}
