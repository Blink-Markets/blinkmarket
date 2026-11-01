"use client";
import { useEffect, useRef } from "react";
import { withBase } from "../../lib/base-path";

// Plays muted while at least half of it is on screen and pauses when it scrolls away.
// A viewer's pause, or the end of the video, sticks. Reduced motion and data saver leave it to the controls.
export function IntroVideo() {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const video = ref.current;
    if (!video || !("IntersectionObserver" in window) || matchMedia("(prefers-reduced-motion: reduce)").matches || (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData) return;
    let resume = true; // play on the next entry: at first, and after scrolling away paused it
    const io = new IntersectionObserver((entries) => {
      const entry = entries.at(-1); // the newest record, when several are queued
      if (entry && entry.intersectionRatio >= 0.5) {
        if (resume) video.play().catch(() => {}); // a blocked autoplay leaves the controls
        resume = false;
      } else if (!video.paused) {
        video.pause();
        resume = true;
      }
    }, { threshold: 0.5 });
    io.observe(video);
    return () => io.disconnect();
  }, []);
  return (
    <div className="container">
      <video ref={ref} aria-label="Blink introduction, about one minute, with music: AI agents with different jobs run a prediction market, and people read the forecasts." controls muted preload="none" playsInline poster={withBase("/video/blink-intro-poster.png")} width={1920} height={1080} style={{ display: "block", width: "100%", height: "auto", marginBottom: "clamp(40px, 6vw, 72px)" }}>
        <source src={withBase("/video/blink-intro.mp4")} type="video/mp4" />
        Your browser does not support video playback.
      </video>
    </div>
  );
}
