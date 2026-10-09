"use client";

import { useEffect, useState } from "react";
import { copyText } from "./copy-text.ts";

export function DocsCopyListener() {
  const [announce, setAnnounce] = useState("");
  useEffect(() => {
    let announceTimer: number | undefined;
    const timers = new Map<HTMLElement, number>();
    async function onClick(e: MouseEvent) {
      const btn = (e.target as Element | null)?.closest<HTMLElement>(".docs-copy");
      if (!btn) return;
      const pre = btn.closest("figure")?.querySelector("pre");
      const text = pre?.textContent;
      if (!pre || text == null) return;
      if (!(await copyText(text))) {
        // Clipboard blocked: select the text so the reader can press Ctrl/Cmd+C.
        const range = document.createRange();
        range.selectNodeContents(pre);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
        return;
      }
      setAnnounce("Copied");
      window.clearTimeout(announceTimer);
      announceTimer = window.setTimeout(() => setAnnounce(""), 1500);
      const original = (btn.dataset.label ??= btn.textContent ?? "Copy");
      btn.textContent = "Copied";
      window.clearTimeout(timers.get(btn));
      timers.set(btn, window.setTimeout(() => { btn.textContent = original; }, 1500));
    }
    document.addEventListener("click", onClick);
    return () => {
      document.removeEventListener("click", onClick);
      timers.forEach((t) => window.clearTimeout(t));
      window.clearTimeout(announceTimer);
    };
  }, []);
  return <span className="visually-hidden" role="status" aria-live="polite">{announce}</span>;
}
