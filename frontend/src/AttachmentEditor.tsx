import { useEffect, useState } from "react";
import { FilePlus2, ImagePlus, Plus, X } from "lucide-react";
import { AssetAttachment, PendingItem, TEXTURE_KINDS, TextureKind } from "./api";
import { BROWSER_INPUT_LIMIT, inputBytes } from "./runtimePolicy";

const labels = {
  zh: {
    title: "材质与关联文件", close: "关闭材质面板", linked: "关联文件", add: "添加关联文件",
    scope: "手动贴图应用于整个模型；多材质模型可附加原始 MTL 和对应图片。",
    linkedHint: "GLTF 的 BIN、OBJ 的 MTL 以及模型引用的图片，保持原文件名。",
    empty: "未附加", replace: "替换", remove: "移除", limit: "每个文件 ≤ 200 MB，总计 ≤ 500 MB，最多 32 个附件。",
    base_color: "底色 / Albedo", normal: "法线 / Normal", roughness: "粗糙度 / Roughness",
    metallic: "金属度 / Metallic", ao: "环境遮蔽 / AO", emissive: "自发光 / Emissive",
    invalid: "请选择 PNG、JPG、WebP、TGA 图片或 BIN、MTL 关联文件。",
    duplicate: "附件文件名不能重复，请先移除或重命名。",
    oversize: "超过文件大小或附件数量限制。",
  },
  en: {
    title: "Materials & linked files", close: "Close material panel", linked: "Linked files", add: "Add linked files",
    scope: "Manual maps apply to the whole model. For multiple materials, attach the original MTL and images.",
    linkedHint: "GLTF BIN, OBJ MTL, and referenced images. Keep the original filenames.",
    empty: "Not attached", replace: "Replace", remove: "Remove", limit: "200 MB per file, 500 MB per task, up to 32 attachments.",
    base_color: "Base color / Albedo", normal: "Normal", roughness: "Roughness",
    metallic: "Metallic", ao: "Ambient occlusion", emissive: "Emissive",
    invalid: "Choose PNG, JPG, WebP, TGA images, or linked BIN / MTL files.",
    duplicate: "Attachment filenames must be unique. Remove or rename the existing file.",
    oversize: "Attachment size or count limit exceeded.",
  },
};

function Thumbnail({ file }: { file?: File }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    if (!file || /\.tga$/i.test(file.name)) { setUrl(""); return; }
    const value = URL.createObjectURL(file);
    setUrl(value);
    return () => URL.revokeObjectURL(value);
  }, [file]);
  return <div className="texture-swatch">{url ? <img src={url} alt="" /> : <ImagePlus size={16} />}</div>;
}

export default function AttachmentEditor({ item, locale, onChange, onClose, browser = false }: {
  item: PendingItem; locale: "zh" | "en"; onChange: (assets: AssetAttachment[]) => void; onClose: () => void; browser?: boolean;
}) {
  const t = labels[locale];
  const [error, setError] = useState("");
  useEffect(() => setError(""), [item.id]);
  const add = (files: FileList | null, kind: TextureKind | "resource") => {
    if (!files?.length) return;
    const additions = Array.from(files);
    if (additions.some((file) => !(kind === "resource" ? /\.(png|jpe?g|webp|tga|bin|mtl)$/i : /\.(png|jpe?g|webp|tga)$/i).test(file.name))) {
      setError(t.invalid); return;
    }
    const remaining = item.assets.filter((asset) => asset.kind !== kind || kind === "resource");
    const assets = [...remaining, ...additions.map((file) => ({ id: crypto.randomUUID(), file, kind }))];
    const names = [item.file.name, ...assets.map((asset) => asset.file.name)].map((name) => name.toLowerCase());
    if (new Set(names).size !== names.length) { setError(t.duplicate); return; }
    if (assets.length > 32 || assets.some((asset) => asset.file.size > 200 * 1024 ** 2) ||
      inputBytes(item.file, assets) > (browser ? BROWSER_INPUT_LIMIT : 500 * 1024 ** 2)) {
      setError(t.oversize); return;
    }
    setError("");
    onChange(assets);
  };
  const remove = (id: string) => { onChange(item.assets.filter((asset) => asset.id !== id)); setError(""); };
  return <section className="attachment-editor" aria-label={t.title}>
    <div className="attachment-heading"><div><h2>{t.title}</h2><p>{item.file.name}</p></div>
      <button className="icon-button" title={t.close} aria-label={t.close} onClick={onClose}><X size={17} /></button>
    </div>
    <p className="section-hint">{t.scope}</p>
    <div className="texture-grid">{TEXTURE_KINDS.map((kind) => {
      const asset = item.assets.find((entry) => entry.kind === kind);
      return <div className="texture-slot" key={kind}>
        <Thumbnail file={asset?.file} />
        <div className="texture-copy"><strong>{t[kind]}</strong><span title={asset?.file.name}>{asset?.file.name ?? t.empty}</span></div>
        <label className="icon-button file-picker" title={asset ? t.replace : t[kind]}>
          <Plus size={16} /><input aria-label={t[kind]} type="file" accept=".png,.jpg,.jpeg,.webp,.tga"
            onChange={(event) => { add(event.target.files, kind); event.target.value = ""; }} />
        </label>
        {asset && <button className="icon-button" title={`${t.remove} ${t[kind]}`} aria-label={`${t.remove} ${t[kind]}`} onClick={() => remove(asset.id)}><X size={14} /></button>}
      </div>;
    })}</div>
    <div className="linked-heading"><strong>{t.linked}</strong>
      <label className="ghost-button compact file-picker"><FilePlus2 size={14} />{t.add}
        <input type="file" multiple aria-label={t.add} accept=".bin,.mtl,.png,.jpg,.jpeg,.webp,.tga"
          onChange={(event) => { add(event.target.files, "resource"); event.target.value = ""; }} />
      </label>
    </div>
    <p className="section-hint">{t.linkedHint}</p>
    {item.assets.filter((asset) => asset.kind === "resource").map((asset) => <div className="linked-file" key={asset.id}>
      <span title={asset.file.name}>{asset.file.name}</span><small>{(asset.file.size / 1024 ** 2).toFixed(1)} MB</small>
      <button className="icon-button" title={t.remove} aria-label={`${t.remove} ${asset.file.name}`} onClick={() => remove(asset.id)}><X size={14} /></button>
    </div>)}
    <p className="attachment-limit">{browser
      ? locale === "zh" ? "模型与附件合计 ≤ 100 MB，最多 32 个附件。" : "100 MB for model and attachments combined, up to 32 attachments."
      : t.limit}</p>
    {error && <p className="inline-error" role="alert">{error}</p>}
  </section>;
}
