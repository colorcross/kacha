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

    const header = document.querySelector<HTMLElement>(".site-header");
    const navigation = header?.querySelector<HTMLElement>("nav");
    const fixedBottom = Math.max(
      header?.getBoundingClientRect().bottom ?? 0,
      navigation?.getBoundingClientRect().bottom ?? 0,
    );
    const targetTop =
      target.getBoundingClientRect().top + window.scrollY - fixedBottom - 16;

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
