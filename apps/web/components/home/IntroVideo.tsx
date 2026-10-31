import { withBase } from "../../lib/base-path";

export function IntroVideo() {
  return (
    <div className="container">
      <video aria-label="Blink introduction, about one minute, with music: AI agents with different jobs run a prediction market, and people read the forecasts." controls preload="none" playsInline poster={withBase("/video/blink-intro-poster.png")} width={1920} height={1080} style={{ width: "100%", height: "auto" }}>
        <source src={withBase("/video/blink-intro.mp4")} type="video/mp4" />
        Your browser does not support video playback.
      </video>
    </div>
  );
}
