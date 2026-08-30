import type { Metadata } from "next";

const officialSiteUrl = "https://colorcross.github.io/kacha/";
const socialImageUrl = `${officialSiteUrl}og.png`;
const shared = {
  authors: [{ name: "行者大灰" }],
  creator: "行者大灰",
  icons: {
    icon: "/brand/kacha-logo.png",
    shortcut: "/brand/kacha-logo.png",
    apple: "/brand/kacha-logo.png",
  },
} satisfies Partial<Metadata>;

export const zhRootMetadata: Metadata = {
  ...shared,
  title: {
    default: "咔嚓 Kacha｜本地专业 AI 视频工作流",
    template: "%s｜咔嚓 Kacha",
  },
  description:
    "从脚本或原始素材到可发布候选：可恢复编排、结构精剪、人声、字幕、视觉、统一审片、增量返工与质量检查组成一套本地优先的 AI 视频工作流。",
  keywords: ["咔嚓", "Kacha", "AI 视频剪辑", "Codex skill", "Claude Code skill", "本地视频工作流"],
  openGraph: {
    type: "website",
    url: officialSiteUrl,
    locale: "zh_CN",
    siteName: "咔嚓 Kacha",
    title: "咔嚓 Kacha｜从脚本或素材到可以发布的候选",
    description: "本地优先、语义安全、可增量返工、可验证的专业 AI 视频工作流 skill。",
    images: [{ url: socialImageUrl, width: 1731, height: 909, alt: "咔嚓 Kacha 本地专业 AI 视频工作流" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "咔嚓 Kacha｜从脚本或素材到可以发布的候选",
    description: "让 Codex 或 Claude Code 按专业流程完成视频后期，你保留最后判断。",
    images: [socialImageUrl],
  },
};

export const enRootMetadata: Metadata = {
  ...shared,
  title: {
    default: "Kacha｜Local professional AI video workflow",
    template: "%s｜Kacha",
  },
  description:
    "A local-first, recoverable workflow for editing, voice, captions, visual packaging, review, incremental revision, and evidence-bound quality checks.",
  keywords: ["Kacha", "AI video editing", "Codex skill", "Claude Code skill", "local video workflow"],
  openGraph: {
    type: "website",
    url: `${officialSiteUrl}en/`,
    locale: "en_US",
    siteName: "Kacha",
    title: "Kacha｜From script or footage to a publishable candidate",
    description: "A local-first, recoverable and verifiable professional AI video workflow.",
    images: [{ url: socialImageUrl, width: 1731, height: 909, alt: "Kacha local professional AI video workflow" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Kacha｜From script or footage to a publishable candidate",
    description: "Let Codex or Claude Code run the production workflow while you keep the final judgment.",
    images: [socialImageUrl],
  },
};
