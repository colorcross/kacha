"use client";

import { useEffect, useState } from "react";

type CopyInstallProps = {
  command: string;
  idleLabel: string;
  copiedLabel: string;
};

export function CopyInstall({
  command,
  idleLabel,
  copiedLabel,
}: CopyInstallProps) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1800);
    return () => window.clearTimeout(timer);
  }, [copied]);

  async function copy() {
    await navigator.clipboard.writeText(command);
    setCopied(true);
  }

  return (
    <button className="copy-button" onClick={copy} type="button">
      <span aria-hidden="true">{copied ? "✓" : "⌘"}</span>
      {copied ? copiedLabel : idleLabel}
    </button>
  );
}
