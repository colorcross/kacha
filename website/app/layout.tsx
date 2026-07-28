import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "咔嚓 Kacha｜本地专业 AI 视频工作流",
    template: "%s｜咔嚓 Kacha",
  },
  description:
    "把策划、精剪、声音、画面、字幕、返工与质量检查组织成一套可验证的本地视频工作流。",
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
    locale: "zh_CN",
    siteName: "咔嚓 Kacha",
    title: "咔嚓 Kacha｜把视频工作流做完，也把质量说清楚",
    description:
      "本地优先、可审计、可返工的专业 AI 视频工作流 skill。",
    images: [
      {
        url: "https://raw.githubusercontent.com/colorcross/kacha/main/website/public/og.png",
        width: 1731,
        height: 909,
        alt: "咔嚓 Kacha 本地专业 AI 视频工作流",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "咔嚓 Kacha｜本地专业 AI 视频工作流",
    description: "从策划到质量门禁，把视频工作流变成可验证的过程。",
    images: [
      "https://raw.githubusercontent.com/colorcross/kacha/main/website/public/og.png",
    ],
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
