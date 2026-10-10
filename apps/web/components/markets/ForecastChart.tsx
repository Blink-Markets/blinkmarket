"use client";

import { useRef, useState, type PointerEvent } from "react";
import { chartAriaLabel, platformForecast, yAxisBounds, type ForecastWindow } from "../../content/sample-markets";
import styles from "./ForecastChart.module.css";

const W = 1000;
const L = 52;
const R = 150;
const T = 16;
const B = 300;
const MONO = "var(--font-mono), ui-monospace, monospace";

export function ForecastChart({ windows }: { windows: readonly ForecastWindow[] }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [showTable, setShowTable] = useState(false);

  const { lo, hi, ticks } = yAxisBounds(windows);
  const last = windows.length - 1;
  const lastWindow = windows[last];
  if (!lastWindow) return null;
  const x = (i: number) => (last === 0 ? L : L + (i * (W - L - R)) / last);
  const y = (v: number) => T + ((hi - v) / (hi - lo)) * (B - T);
  const path = (vals: number[]) => vals.map((v, i) => `${i ? "L" : "M"}${x(i)} ${y(v)}`).join(" ");
  const avg = windows.map(platformForecast);
  const avgLast = platformForecast(lastWindow);
  const avgY = y(avgLast);
  const baseY = y(lastWindow.baseline);
  // Keep the two direct labels apart when the end points nearly coincide.
  const baseLabelY = Math.abs(baseY - avgY) < 18 ? (baseY >= avgY ? avgY + 18 : avgY - 18) : baseY;

  function onMove(e: PointerEvent<SVGRectElement>) {
    const svg = svgRef.current;
    if (!svg) return;
    const box = svg.getBoundingClientRect();
    const vx = ((e.clientX - box.left) / box.width) * W;
    const i = last === 0 ? 0 : Math.round((vx - L) / ((W - L - R) / last));
    setHover(Math.max(0, Math.min(last, i)));
  }

  const hw = hover === null ? null : windows[hover];
  let tipStyle: { left: number; top: number } | null = null;
  if (hover !== null && hw && svgRef.current) {
    const sx = svgRef.current.getBoundingClientRect().width / W;
    let left = x(hover) * sx + 14;
    if (left + 200 > W * sx) left = x(hover) * sx - 214;
    tipStyle = { left: Math.max(0, left), top: Math.max(0, y(platformForecast(hw)) * sx - 20) };
  }

  return (
    <div>
      <div className={styles.head}>
        <div>
          <h2 id="fc-h" className={styles.title}>Forecast history</h2>
          <p className={styles.lede}>Probability of YES at each daily forecast window (sample data). The axis shows {lo}–{hi}%.</p>
        </div>
        <button
          className={styles.toggle}
          type="button"
          aria-controls="forecast-table"
          aria-expanded={showTable}
          onClick={() => setShowTable((v) => !v)}
        >
          {showTable ? "Hide table" : "Show table"}
        </button>
      </div>
      <div className={styles.legend} aria-hidden="true">
        <span><i className={styles.sw} />Platform forecast</span>
        <span><i className={`${styles.sw} ${styles.base}`} />Baseline (single model)</span>
        <span><i className={`${styles.sw} ${styles.ctx}`} />Forecasters A and B</span>
      </div>
      <div className={styles.wrap}>
        <svg ref={svgRef} viewBox="0 0 1000 340" role="img" aria-label={chartAriaLabel(windows)}>
          {ticks.map((v) => (
            <g key={v}>
              <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} stroke="#24232126" strokeWidth={1} />
              <text x={L - 10} y={y(v) + 4} textAnchor="end" fontSize={12} fill="#242321b3" fontFamily={MONO}>{v}%</text>
            </g>
          ))}
          {windows.map((w, i) => (
            <text key={w.date} x={x(i)} y={B + 24} textAnchor="middle" fontSize={12} fill="#242321b3" fontFamily={MONO}>{w.date.slice(5)}</text>
          ))}
          <path d={path(windows.map((w) => w.a))} fill="none" stroke="#2148b84d" strokeWidth={1} />
          <path d={path(windows.map((w) => w.b))} fill="none" stroke="#2148b84d" strokeWidth={1} />
          <path d={path(windows.map((w) => w.baseline))} fill="none" stroke="#242321" strokeWidth={2} strokeDasharray="6 5" strokeLinejoin="round" />
          <path d={path(avg)} fill="none" stroke="#2148B8" strokeWidth={2} strokeLinejoin="round" />
          <circle cx={x(last)} cy={avgY} r={4.5} fill="#2148B8" stroke="#fafaf7" strokeWidth={2} />
          <circle cx={x(last)} cy={baseY} r={4} fill="#242321" stroke="#fafaf7" strokeWidth={2} />
          <text x={x(last) + 12} y={avgY + 4} fontSize={14} fill="#242321" fontWeight={600}>Platform {avgLast.toFixed(1)}%</text>
          <text x={x(last) + 12} y={baseLabelY + 4} fontSize={14} fill="#242321">Baseline {lastWindow.baseline.toFixed(1)}%</text>
          {hover !== null && (
            <line x1={x(hover)} x2={x(hover)} y1={T} y2={B} stroke="#242321" strokeWidth={1} opacity={0.35} />
          )}
          <rect
            className={styles.hit}
            data-testid="chart-hit"
            x={L - 20}
            y={0}
            width={W - L - R + 40}
            height={B + 10}
            fill="transparent"
            onPointerMove={onMove}
            onPointerLeave={() => setHover(null)}
          />
        </svg>
        {hw && tipStyle && (
          <div className={styles.tip} style={tipStyle} data-testid="chart-tip">
            <span className={`mono ${styles.when}`}>{hw.date}</span>
            <div><span>Platform</span><b>{platformForecast(hw).toFixed(1)}%</b></div>
            <div><span>Baseline</span><span>{hw.baseline.toFixed(1)}%</span></div>
            <div><span>A / B</span><span>{hw.a.toFixed(1)} / {hw.b.toFixed(1)}%</span></div>
          </div>
        )}
      </div>
      <div className={styles.tableWrap} id="forecast-table" hidden={!showTable}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Window</th>
              <th className={styles.num}>Forecaster A</th>
              <th className={styles.num}>Forecaster B</th>
              <th className={styles.num}>Platform forecast</th>
              <th className={styles.num}>Baseline</th>
            </tr>
          </thead>
          <tbody>
            {windows.map((w) => (
              <tr key={w.date}>
                <td>{w.date}</td>
                <td className={styles.num}>{w.a.toFixed(1)}%</td>
                <td className={styles.num}>{w.b.toFixed(1)}%</td>
                <td className={styles.num}><b>{platformForecast(w).toFixed(1)}%</b></td>
                <td className={styles.num}>{w.baseline.toFixed(1)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className={styles.note}>
        The platform forecast is the plain average of two forecasters run by the same operator, so they are not
        independent. The baseline is one separate model and is never averaged in. One forecast per agent per
        window; withdrawn forecasts stay on the record.
      </p>
    </div>
  );
}
