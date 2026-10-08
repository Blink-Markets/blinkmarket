"use client";

import { useEffect } from "react";
import { copyText } from "./copy-text.ts";

export function DocsCopyListener() {
  useEffect(() => {
    const timers = new Map<HTMLElement, number>();
    async function onClick(e: MouseEvent) {
      const btn = (e.target as Element | null)?.closest<HTMLElement>(".docs-copy");
      if (!btn) return;
      const text = btn.closest("figure")?.querySelector("pre")?.textContent;
      if (text == null || !(await copyText(text))) return;
      const original = (btn.dataset.label ??= btn.textContent ?? "Copy");
      btn.textContent = "Copied";
      window.clearTimeout(timers.get(btn));
      timers.set(btn, window.setTimeout(() => { btn.textContent = original; }, 1500));
    }
    document.addEventListener("click", onClick);
    return () => {
      document.removeEventListener("click", onClick);
      timers.forEach((t) => window.clearTimeout(t));
    };
  }, []);
  return null;
}
