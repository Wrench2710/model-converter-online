import { TaskStatus } from "./api";

const labels: Record<"zh" | "en", Record<TaskStatus, string>> = {
  zh: { queued: "排队中", running: "转换中", succeeded: "已完成", failed: "转换失败", canceled: "已取消" },
  en: { queued: "Queued", running: "Converting", succeeded: "Completed", failed: "Failed", canceled: "Canceled" },
};
export const taskStatus = (status: TaskStatus, locale: "zh" | "en") => labels[locale][status];
export const taskDate = (date: string, locale: "zh" | "en") => new Date(date).toLocaleString(locale === "zh" ? "zh-CN" : "en-US", {
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
});
