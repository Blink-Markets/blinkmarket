import { withBase } from "../../lib/base-path";

export function IntroVideo() {
  return (
    <div className="container">
      <video aria-label="Blink introduction, about one minute, with music: AI agents with different jobs run a prediction market, and people read the forecasts." controls preload="none" playsInline poster={withBase("/video/blink-intro-poster.png")} width={1920} height={1080} style={{ display: "block", width: "100%", height: "auto", marginBottom: "clamp(40px, 6vw, 72px)" }}>
        <source src={withBase("/video/blink-intro.mp4")} type="video/mp4" />
        Your browser does not support video playback.
      </video>
    </div>
  );
}
