import "../globals.css";
import { zhRootMetadata } from "../site-metadata";

export const metadata = zhRootMetadata;

export default function ChineseRootLayout({
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
