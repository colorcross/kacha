import type { Metadata } from "next";
import "./globals.css";

const officialSiteUrl = "https://colorcross.github.io/kacha/";
const socialImageUrl = `${officialSiteUrl}og.png`;

export const metadata: Metadata = {
  title: {
    default: "咔嚓 Kacha｜本地专业 AI 视频工作流",
    template: "%s｜咔嚓 Kacha",
  },
  description:
    "从原始素材到可发布成片：结构精剪、人声处理、字幕校准、视觉包装、增量返工与质量检查，组成一套本地优先、可验证的 AI 视频工作流。",
  keywords: [
    "咔嚓",
    "Kacha",
    "AI 视频剪辑",
    "Codex skill",
    "Claude Code skill",
    "本地视频工作流",
  ],
  authors: [{ name: "行者大灰" }],
  creator: "行者大灰",
  openGraph: {
    type: "website",
    url: officialSiteUrl,
    locale: "zh_CN",
    siteName: "咔嚓 Kacha",
    title: "咔嚓 Kacha｜从原始素材到可以发布的成片",
    description:
      "本地优先、语义安全、可增量返工、可验证的专业 AI 视频工作流 skill。",
    images: [
      {
        url: socialImageUrl,
        width: 1731,
        height: 909,
        alt: "咔嚓 Kacha 本地专业 AI 视频工作流",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "咔嚓 Kacha｜从原始素材到可以发布的成片",
    description: "让 Codex 或 Claude Code 按专业流程完成视频后期，你保留最后判断。",
    images: [socialImageUrl],
  },
  icons: {
    icon: "/brand/kacha-logo.png",
    shortcut: "/brand/kacha-logo.png",
    apple: "/brand/kacha-logo.png",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
