import type { Metadata } from "next";
import { SiteShell } from "./components/SiteShell";
import { zhContent } from "./site-content";

export const metadata: Metadata = {
  title: "从原始素材到可发布成片的本地 AI 视频工作流",
  description:
    "咔嚓让 Codex 或 Claude Code 完成结构精剪、人声处理、字幕校准、视觉包装、增量返工与质量检查。素材本地优先，修改可追踪。",
  alternates: { canonical: "https://colorcross.github.io/kacha/" },
};

export default function Home() {
  return <SiteShell content={zhContent} locale="zh" />;
}
