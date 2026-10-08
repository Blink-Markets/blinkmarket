"use client";

import { useEffect, useState } from "react";

type Theme = "light" | "dark";

function effectiveTheme(): Theme {
  const set = document.documentElement.dataset.theme;
  if (set === "light" || set === "dark") return set;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme | null>(null);

  useEffect(() => {
    setTheme(effectiveTheme());
  }, []);

  function toggle() {
    const next: Theme = (theme ?? effectiveTheme()) === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("blink-theme", next);
    } catch {}
    setTheme(next);
  }

  return (
    <button type="button" className="docs-theme" aria-pressed={theme === "dark"} aria-label="Dark theme" onClick={toggle}>
      {theme === "dark" ? "Light" : "Dark"}
    </button>
  );
}
