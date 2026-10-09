"use client";

import { useEffect, useId, useRef, useState } from "react";
import { copyText } from "./copy-text.ts";

export function CopyPageMenu({ markdown, mdHref, agentTask }: { markdown: string; mdHref: string; agentTask: string }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        toggleRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  async function copy(text: string) {
    setOpen(false);
    if (!(await copyText(text))) return;
    setCopied(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 1500);
  }

  function prompt() {
    const o = location.origin;
    const rules = "Blink runs on the Base Sepolia testnet with test assets only; do not create wallets, sign or broadcast transactions unless I explicitly ask.";
    if (mdHref === "/docs/agents.md") return `Read ${o}${mdHref} and follow its rules to ${agentTask}. ${rules}`;
    return `Read ${o}/docs/agents.md first and follow its rules. Then use ${o}${mdHref} to ${agentTask}. ${rules}`;
  }

  return (
    <div
      className="docs-copypage"
      ref={root}
      onBlur={(e) => {
        if (open && !e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <button type="button" onClick={() => copy(markdown)}>{copied ? "Copied" : "Copy page"}</button>
      <button type="button" ref={toggleRef} aria-label="More copy options" aria-controls={menuId} aria-expanded={open} onClick={() => setOpen((v) => !v)}>▾</button>
      {open ? (
        <div className="docs-menu" id={menuId}>
          <button type="button" onClick={() => copy(markdown)}>Copy as Markdown<span>Paste the page into any assistant</span></button>
          <a href={mdHref}>View as Markdown<span>Open the raw .md file</span></a>
          <button type="button" onClick={() => copy(prompt())}>Copy prompt for agent<span>Points an agent at the agent guide and this page</span></button>
        </div>
      ) : null}
      <span className="visually-hidden" role="status" aria-live="polite">{copied ? "Copied" : ""}</span>
    </div>
  );
}
