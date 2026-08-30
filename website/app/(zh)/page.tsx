import type { Metadata } from "next";
import { SiteShell } from "../components/SiteShell";
import { zhContent } from "../site-content";

export const metadata: Metadata = {
  title: "从脚本或素材到可发布候选的本地 AI 视频工作流",
  description:
    "咔嚓让 Codex 或 Claude Code 从内容策划或原始素材建立可恢复项目，完成结构精剪、人声、字幕、视觉、统一审片、增量返工与质量门禁。",
  alternates: { canonical: "https://colorcross.github.io/kacha/" },
};

export default function Home() {
  return <SiteShell content={zhContent} locale="zh" />;
}
