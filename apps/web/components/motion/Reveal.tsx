"use client";
import { useEffect } from "react";

// Fallback for browsers without scroll-driven animations. Content stays visible
// unless this runs, so no-JS and reduced-motion users always see everything.
export function RevealObserver() {
  useEffect(() => {
    if (CSS.supports("animation-timeline: view()")) return;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (!("IntersectionObserver" in window)) return;
    const root = document.documentElement;
    root.classList.add("reveal-fallback");
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.setAttribute("data-visible", "");
          io.unobserve(entry.target);
        }
      },
      { rootMargin: "0px 0px -10% 0px" },
    );
    const observe = () =>
      document
        .querySelectorAll("[data-reveal]:not([data-visible]), [data-draw-scope]:not([data-visible]), [data-aperture]:not([data-visible])")
        .forEach((el) => io.observe(el));
    observe();
    const mo = new MutationObserver(observe);
    mo.observe(document.body, { childList: true, subtree: true });
    return () => {
      io.disconnect();
      mo.disconnect();
      root.classList.remove("reveal-fallback");
    };
  }, []);
  return null;
}
