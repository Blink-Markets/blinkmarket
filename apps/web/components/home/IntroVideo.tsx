import { introVideoTranscript } from "../../content/intro-video";
import { withBase } from "../../lib/base-path";

export function IntroVideo() {
  return (
    <section className="container section">
      <h2>Watch</h2>
      <p className="prose">This introduction includes a local autonomous drill run, not a public deployment.</p>
      <video aria-label="Blink introduction video" controls preload="none" playsInline poster={withBase("/video/blink-intro-poster.png")} width={1920} height={1080} style={{ width: "100%", height: "auto" }}>
        <source src={withBase("/video/blink-intro.mp4")} type="video/mp4" />
        Your browser does not support video playback.
      </video>
      <p>{introVideoTranscript.at(-1)!.lines.at(-1)}</p>
      <details>
        <summary>Transcript</summary>
        <ol>
          {introVideoTranscript.map((scene) => (
            <li key={scene.id}>
              {scene.lines.map((line, i) => <p key={i}>{line}</p>)}
            </li>
          ))}
        </ol>
      </details>
    </section>
  );
}
