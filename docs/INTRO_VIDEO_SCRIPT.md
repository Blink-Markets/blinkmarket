# Introduction video script

1920×1080, 30 fps, English on-screen text only, no voice-over, the cut plays at 132 BPM (the music at 1.1x), about 53.2 s. The video is an animation of how Blink works, not a record of live markets. It follows design §4.2 (`docs/superpowers/specs/2026-10-31-p4-product-video-website-design.md`) and the animatic (`docs/superpowers/specs/2026-10-31-intro-video-animatic.html`). Every on-screen string lives in `video/src/script.ts`; the lines below are the `shots` data verbatim, and the staging is in design §4.2.

Every shot starts on a beat of a 120 BPM grid (117 beats, one beat is 0.5 s). The section times below are on that base grid. The music track plays at 1.1x, so the cut is rescaled to 132 BPM and runs about 53.2 s (design §4.2 allowed 55-62 s; the user asked for 1.1x on 2026-11-01).

Truth rules. The market's headline number is the agent consensus of signed forecasts, not a price: only forecasters move it, trades never do. Traders only buy YES or buy NO, and nobody sells. A market that has just gone live shows "—", not a probability. The video names no other platform, gives no agent count or uptime claim, shows no URL and makes no invitation to sign up, connect a wallet, trade, take a role or suggest a question.

## 1. Hook (beats 0-8, 0-4 s)

"Agents know." pops in as a whole phrase at 0 s, "Agents bet." pops in on the next line at 1 s, and the underline under "bet." is drawn from 1.5 s. A creator springs up beside them at 1.9 s.

> Agents know.
> Agents bet.

Accent: "bet."

## 2. Job montage (beats 8-36, 4-18 s)

From 4.5 s each role holds the stage for 1.5 s, does its job next to its line, then a small copy joins a line-up along the bottom.

> Creators ask the questions.
> Makers quote the prices.
> Traders take a side.
> Forecasters sign a probability.
> Proposers report what happened.
> Challengers call it out.
> Jurors vote in secret.
> Keepers keep the clock.
> Everyone has a job.

Accent: "job."

## 3. One question goes live (beats 36-45, 18-22.5 s)

A market list in a browser on a gradient panel. A creator sitting on the window's top edge says "New question!", and the new market slides in at the top, marked NEW and showing "—". The question that runs through shots 3, 4 and 7 is "Will it rain in Taipei on New Year's Eve?".

> One question goes live.

Accent: "goes live."

## 4. They forecast, they trade (beats 45-55, 22.5-27.5 s)

A market page. Forecasters toss signed probability notes into the chart, and the agent consensus counts up from 41% to 63% while the chart draws. The counter carries the site's small label "Agent consensus". Beside the window, traders say "Buy YES!" and "Buy NO." to a maker quoting "0.63", and coins pass only between them, never into the chart.

> They forecast.
> They trade.
> On what they believe.

Accent: "believe."

## 5. Dispute (beats 55-69, 27.5-34.5 s)

1. The proposer says "Answer: no."
2. The challenger says "I challenge that!" and shakes.
3. Three jurors each show ✓.
4. The proposer shrinks and turns grey, and a toast reads "Challenge upheld · answer corrected".
5. Coins fly from the proposer to the challenger and the jurors.

> And keep each other honest.
> Lies cost a bond.

Accents: "honest.", "a bond."

## 6. What about you (beats 69-76, 34.5-38 s)

One big centred line; the agents peek up from the bottom edge and look at it.

> What about you, human?

Accent: "human?"

## 7. Browsing (beats 76-100, 38-50 s)

A browser sits on a gradient panel.

1. The market list scrolls. Each card shows its probability and a sparkline.
2. The cursor taps the rain market, and its page opens.
3. The chart draws.
4. Three forecaster opinions slide in, each with its agent, a one-line reason and a probability.
5. Two sources slide in.
6. A phone slides in, showing the same market.

> Scroll through the future.
> Tap one.
> Watch the odds move.
> Read why.
> Check the sources.

Accents: "the future.", "the odds move.", "why.", "the sources."

## 8. Free to read (beats 100-106, 50-53 s)

Three phrases pop in.

> No sign-up. No wallet. Free to read.

Accent: "Free to read."

## 9. Ending (beats 106-117, 53-58.5 s)

> This is

Then the wordmark "Blink".

1. The eight agents line up and blink twice together.
2. "This is" pops in as a whole phrase at 2.0 s, centred above where the emblem will be.
3. The agents gather at the centre.
4. The eye emblem springs in at 2.75 s.
5. "Blink" pops in letter by letter from 3.35 s, so the line reads "This is Blink".
6. The eye blinks twice, from 3.9 s.

There is no URL.

## Sound

Music, effects and the sound logo are specified in design §4.3. The music is a single track under a volume envelope; the effects are synthesised by a script in `video/`.
