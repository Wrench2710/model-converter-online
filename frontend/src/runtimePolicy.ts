import type { AssetAttachment } from "./api";

export type RuntimeKind = "browser" | "server";
export const INPUT_FORMATS = ["glb", "gltf", "obj", "stl", "ply", "fbx"];
export const BROWSER_OUTPUT_FORMATS = ["glb", "gltf", "stl", "ply"];
export const BROWSER_INPUT_LIMIT = 100 * 1024 ** 2;
export const BROWSER_RESULT_LIMIT = 200 * 1024 ** 2;
export const RESULT_LIFETIME = 10 * 60 * 1000;
export const inputBytes = (file: File, assets: AssetAttachment[]) =>
  file.size + assets.reduce((total, asset) => total + asset.file.size, 0);

export type BrowserErrorCode = "input_limit" | "unsupported_format" | "missing_resources" | "missing_uv"
  | "empty_model" | "result_limit" | "unsupported_browser" | "conversion_failed" | "conversion_timeout";

export const browserError = (code: string, locale: "zh" | "en") => {
  const messages: Record<BrowserErrorCode, [string, string]> = {
    input_limit: ["模型和附件合计不能超过 100 MB。", "Model and attachments must total 100 MB or less."],
    unsupported_format: ["浏览器不支持此转换格式，且输出格式不能与输入相同。", "This conversion is unavailable in the browser. Choose a different output format."],
    missing_resources: ["缺少模型引用的资源，请附加对应贴图、BIN 或 MTL 文件。", "Attach the model's missing textures, BIN or MTL files."],
    missing_uv: ["模型缺少 UV，无法正确导出手动贴图。", "The model needs UV coordinates to export the attached maps."],
    empty_model: ["模型没有可转换的网格。", "The model contains no convertible mesh."],
    result_limit: ["结果将超过 200 MB 内存限额，请删除现有结果，或使用服务端转换。", "The result exceeds the 200 MB memory budget. Delete existing results or use the server runtime."],
    unsupported_browser: ["此浏览器缺少 Worker、OffscreenCanvas 或图片解码能力，请更新浏览器或使用服务端转换。", "Required Worker, OffscreenCanvas or image decoding features are missing. Update your browser or use the server runtime."],
    conversion_failed: ["转换失败，请检查格式、模型及关联资源。压缩模型或特殊扩展可能需要服务端转换。", "Conversion failed. Check the model and linked resources. Compressed models or special extensions may need the server runtime."],
    conversion_timeout: ["转换时间过长，任务已停止并释放资源。请使用服务端转换。", "Conversion timed out and its resources were released. Use the server runtime."],
  };
  return (messages[code as BrowserErrorCode] ?? messages.conversion_failed)[locale === "zh" ? 0 : 1];
};
