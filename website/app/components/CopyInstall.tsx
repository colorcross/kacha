"use client";

import { useEffect, useState } from "react";

type CopyInstallProps = {
  command: string;
  idleLabel: string;
  copiedLabel: string;
  failedLabel: string;
};

const CLIPBOARD_TIMEOUT_MS = 800;

function legacyCopy(command: string) {
  const textarea = document.createElement("textarea");
  textarea.value = command;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  document.body.appendChild(textarea);
  textarea.select();
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  } finally {
    textarea.remove();
  }
  return copied;
}

export function CopyInstall({
  command,
  idleLabel,
  copiedLabel,
  failedLabel,
}: CopyInstallProps) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  useEffect(() => {
    if (state === "idle") return;
    const timer = window.setTimeout(() => setState("idle"), 1800);
    return () => window.clearTimeout(timer);
  }, [state]);

  async function copy() {
    let copied = false;
    if (navigator.clipboard?.writeText) {
      let timer: number | undefined;
      try {
        await Promise.race([
          navigator.clipboard.writeText(command),
          new Promise<never>((_resolve, reject) => {
            timer = window.setTimeout(
              () => reject(new Error("clipboard write timed out")),
              CLIPBOARD_TIMEOUT_MS,
            );
          }),
        ]);
        copied = true;
      } catch {
        copied = legacyCopy(command);
      } finally {
        if (timer !== undefined) window.clearTimeout(timer);
      }
    } else {
      copied = legacyCopy(command);
    }
    setState(copied ? "copied" : "failed");
  }

  const label = state === "copied"
    ? copiedLabel
    : state === "failed"
      ? failedLabel
      : idleLabel;

  return (
    <button aria-live="polite" className="copy-button" onClick={copy} type="button">
      <span aria-hidden="true">{state === "copied" ? "✓" : state === "failed" ? "!" : "⌘"}</span>
      {label}
    </button>
  );
}
