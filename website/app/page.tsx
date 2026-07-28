import type { Metadata } from "next";
import { SiteShell } from "./components/SiteShell";
import { zhContent } from "./site-content";

export const metadata: Metadata = {
  title: "本地专业 AI 视频工作流",
  description:
    "咔嚓把视频策划、精剪、声音、画面、字幕、返工与质量检查组织成可验证的本地工作流。",
  alternates: { canonical: "/" },
};

export default function Home() {
  return <SiteShell content={zhContent} locale="zh" />;
}
