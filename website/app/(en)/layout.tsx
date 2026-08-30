import "../globals.css";
import { enRootMetadata } from "../site-metadata";

export const metadata = enRootMetadata;

export default function EnglishRootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
