"use client";

import type { MouseEvent, ReactNode } from "react";

type ScrollLinkProps = {
  targetId: string;
  className?: string;
  ariaLabel?: string;
  children: ReactNode;
};

export function ScrollLink({
  targetId,
  className,
  ariaLabel,
  children,
}: ScrollLinkProps) {
  function navigateToAnchor(event: MouseEvent<HTMLAnchorElement>) {
    if (
      event.button !== 0
      || event.metaKey
      || event.ctrlKey
      || event.shiftKey
      || event.altKey
    ) {
      return;
    }

    const target = document.getElementById(targetId);
    if (!target) return;

    event.preventDefault();
    event.stopPropagation();

    const targetTop = target.getBoundingClientRect().top + window.scrollY;

    window.history.pushState(null, "", `#${targetId}`);
    window.scrollTo({
      top: Math.max(0, targetTop),
      behavior: "auto",
    });
  }

  return (
    <a
      aria-label={ariaLabel}
      className={className}
      href={`#${targetId}`}
      onClick={navigateToAnchor}
    >
      {children}
    </a>
  );
}
