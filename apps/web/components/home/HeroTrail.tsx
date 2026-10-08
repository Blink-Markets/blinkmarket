"use client";
import { useEffect, useRef, useState } from "react";
import styles from "./Hero.module.css";
import { trailPath, trailWaypoints, type Point } from "./trail-geometry";

type Geometry = { w: number; h: number; d: string };

export function HeroTrail() {
  const svgRef = useRef<SVGSVGElement>(null);
  const [geo, setGeo] = useState<Geometry | null>(null);

  useEffect(() => {
    const svg = svgRef.current;
    const box = svg?.parentElement;
    if (!svg || !box) return;
    // Start drawing once the underline has formed (3.6s after navigation), or immediately if hydration was late.
    svg.style.setProperty("--draw-delay", `${Math.max(0, 3600 - performance.now())}ms`);

    const measure = () => {
      const origin = box.getBoundingClientRect();
      const rel = (x: number, y: number): Point => ({ x: x - origin.left, y: y - origin.top });
      const word = box.querySelector<HTMLElement>("[data-trail-start]");
      const avoid = box.querySelector<HTMLElement>("[data-trail-avoid]");
      const band = box.querySelector<HTMLElement>("[data-trail-band]");
      const nodes = [...box.querySelectorAll<HTMLElement>("[data-trail-node]")];
      if (!word || !band || nodes.length === 0) return;
      const w = word.getBoundingClientRect();
      const em = parseFloat(getComputedStyle(word).fontSize);
      const points = trailWaypoints({
        // Mask has 0.08em bottom padding; the underline sits about 0.08em above the word box bottom.
        start: rel(w.right + 0.04 * em, w.bottom - 0.16 * em),
        avoidRight: avoid ? avoid.getBoundingClientRect().right - origin.left : null,
        bandTop: band.getBoundingClientRect().top - origin.top,
        width: origin.width,
        nodes: nodes.map((n) => {
          const r = (n.querySelector("svg") ?? n).getBoundingClientRect();
          return rel(r.left + r.width / 2, r.top + r.height / 2);
        }),
      });
      setGeo({ w: origin.width, h: origin.height, d: trailPath(points) });
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    void document.fonts?.ready.then(measure);
    return () => ro.disconnect();
  }, []);

  return (
    <svg
      ref={svgRef}
      className={styles.trailSvg}
      aria-hidden="true"
      fill="none"
      viewBox={geo ? `0 0 ${geo.w} ${geo.h}` : undefined}
      data-ready={geo ? "" : undefined}
    >
      {geo && <path className={styles.trailPath} pathLength={1} d={geo.d} />}
    </svg>
  );
}
