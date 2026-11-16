/**
 * Claude's identity on a Tern surface. The identity is form and motion: the
 * spark that moves with what Claude is doing, Clawd on the start screen, a
 * serif for Claude's own words. The colours are the Tern theme's, so light,
 * dark and custom themes all keep working; Claude's clay is an accent the
 * user can switch on over any of them.
 */

/** Claude's clay, a little deeper on light pages so text set in it stays readable. */
export const CLAY = "#D97757";

import { SPRITE, SPRITE_COLOURS, SPRITE_FRAMES } from "./sprites.js";

/**
 * A serif for Claude's own words (the greeting). Faces are named for each platform, the best first: Tern's
 * generic `serif` and `ui-serif` both come out as a sans on Linux.
 */
const SERIF = `"Iowan Old Style", "Palatino Linotype", "Source Serif 4", "Source Serif Pro", "Noto Serif", Georgia, Cambria, "Liberation Serif", "DejaVu Serif", serif`;

/**
 * The spark's twelve rays: how far each reaches (percent of the radius), how
 * wide it is and how far it leans off its place on the clock. The unevenness
 * is the mark's hand-drawn look.
 */
const RAY_SHAPES: readonly [reach: number, width: number, lean: number][] = [
  [100, 15, -3], [80, 13, 4], [94, 14, -2], [86, 15, 5], [98, 13, -4], [78, 14, 2],
  [96, 15, -5], [84, 13, 3], [100, 14, -1], [82, 15, 4], [92, 13, -3], [88, 14, 2],
];

/** The gold of a powered-up Claude, and Ultracode's own violet (both fixed: they are the joke). */
const GOLD = "#f5cf14";
const ULTRA = "#6b2bf5";

/** How many of the gauge's twelve rays each effort level lights. */
const GAUGE_LIT: Readonly<Record<string, number>> = { off: 0, low: 3, medium: 5, high: 8, xhigh: 10, max: 12, auto: 6 };

/**
 * The living spark (`view/spark.ts`). Each ray is a node, drawn as a petal
 * that is pointed at the centre and blunt at its tip; the theme colours it and
 * what Claude is doing moves it. Only `scale`, `rotate` and `opacity` are
 * animated, so the compositor does the work.
 */
function sparkCss(): string {
  const ray = `[data-role^="claude.ray."]`;
  const any = `[data-role^="claude.spark."]`;
  const at = (state: string): string => `[data-role="claude.spark.${state}"]`;
  return `
@keyframes claude-breathe { 0%, 100% { scale: 1 1; } 50% { scale: 1 0.52; } }
@keyframes claude-sway { 0%, 100% { scale: 1 1; } 50% { scale: 1 0.78; } }
@keyframes claude-turn { to { rotate: 360deg; } }
@keyframes claude-hold { 0%, 100% { opacity: 1; scale: 1; } 50% { opacity: 0.45; scale: 0.86; } }
@keyframes claude-aura { 0%, 100% { opacity: 0.55; scale: 0.9; } 50% { opacity: 1; scale: 1.2; } }
@keyframes claude-arrive { from { opacity: 0; scale: 0.4; rotate: -90deg; } }
${any} { position: relative !important; display: block !important; flex: none !important; width: var(--spark, 15px) !important; height: var(--spark, 15px) !important; min-width: 0 !important; padding: 0 !important; margin: 0 !important; gap: 0 !important; overflow: visible !important; color: var(--claude); animation: claude-arrive 0.5s cubic-bezier(0.2, 0.9, 0.3, 1.2) backwards; }
${ray} { position: absolute !important; display: block !important; left: 50% !important; bottom: 50% !important; top: auto !important; min-width: 0 !important; min-height: 0 !important; padding: 0 !important; overflow: hidden !important; font-size: 0 !important; line-height: 0 !important; transform-origin: 50% 100%; background: currentColor; border-radius: 50% 50% 50% 50% / 14% 14% 86% 86%; }
${RAY_SHAPES.map(([reach, width, lean], index) => `[data-role="claude.ray.${index}"] { height: ${reach / 2}% !important; width: ${width}% !important; margin: 0 0 0 -${width / 2}% !important; rotate: ${index * 30 + lean}deg; animation-delay: ${(-index * 0.14).toFixed(2)}s !important; }`).join("\n")}
${at("think")} ${ray} { animation: claude-breathe 1.7s ease-in-out infinite; }
${at("work")} { animation: claude-turn 5s linear infinite; }
${at("work")} ${ray} { animation: claude-sway 1.7s ease-in-out infinite; }
${at("wait")} { animation: claude-hold 2.4s ease-in-out infinite; }
${at("warn")} { color: var(--warn); }
${at("warn")} ${ray} { animation: claude-sway 2.4s ease-in-out infinite; }
/* Ultracode: the spark burns gold and fast, inside a halo. */
${at("flare")} { color: ${GOLD}; animation: claude-turn 3.2s linear infinite; filter: drop-shadow(0 0 3px ${GOLD}); }
${at("flare")} ${ray} { animation: claude-breathe 0.85s ease-in-out infinite; }
/* The effort gauge in the model chip: the same spark, as many rays lit as the level reaches. At max it all burns. */
[data-role^="claude.gauge."] { position: relative !important; display: block !important; flex: none !important; width: 14px !important; height: 14px !important; min-width: 0 !important; padding: 0 !important; margin: 0 !important; overflow: visible !important; color: var(--t3); cursor: pointer; transition: scale 0.2s ease; }
[data-role^="claude.gauge."] ${ray} { transition: opacity 0.25s ease, background-color 0.25s ease; }
${Object.entries(GAUGE_LIT).map(([level, lit]) => `${Array.from({ length: RAY_SHAPES.length - lit }, (_, index) => `[data-role="claude.gauge.${level}"] [data-role="claude.ray.${lit + index}"]`).join(", ") || `[data-role="claude.gauge.none"]`} { opacity: 0.22; }\n${lit ? `${Array.from({ length: lit }, (_, index) => `[data-role="claude.gauge.${level}"] [data-role="claude.ray.${index}"]`).join(", ")} { background: var(--claude); }` : ""}`).join("\n")}
[data-role="claude.gauge.max"] { filter: drop-shadow(0 0 2.5px color-mix(in oklab, var(--claude) 80%, transparent)); }
[data-role="claude.gauge.max"] ${ray} { animation: claude-breathe 1.2s ease-in-out infinite; }
[data-role="omp.composer.model.effort"] { cursor: pointer; border-radius: 50%; }
[data-role="omp.composer.model.effort"]:hover [data-role^="claude.gauge."] { scale: 1.18; }
@media (prefers-reduced-motion: reduce) {
  ${any}, ${ray} { animation: none !important; }
}`;
}

/**
 * Clawd, the creature on Claude Code's own start screen, pixel for pixel: the
 * terminal draws it from quarter-block characters, two to a cell, so its
 * pixels are twice as tall as they are wide. Here every pixel is a shadow of
 * one small box, in the theme's colour, and the eyes are the gaps.
 */
const CLAWD: readonly string[] = [
  "...############...",
  "...##.######.##...",
  ".################.",
  "...############...",
  "....#.#....#.#....",
];
const CLAWD_EYES: readonly [x: number, y: number][] = [[5, 1], [12, 1]];

function clawdCss(): string {
  const px = (x: number, y: number): string => `calc(var(--u) * ${x}) calc(var(--u) * ${y * 2}) 0 0 currentColor`;
  const body = CLAWD.flatMap((row, y) => [...row].flatMap((cell, x) => (cell === "#" ? [px(x, y)] : []))).join(", ");
  const eyes = CLAWD_EYES.map(([x, y]) => px(x, y)).join(", ");
  const me = `[data-role="claude.clawd"]`;
  return `
@keyframes claude-blink { 0%, 93%, 100% { scale: 1 1; } 95%, 98% { scale: 1 0.15; } }
@keyframes claude-hop { 0%, 100% { translate: 0 0; } 40% { translate: 0 calc(var(--u) * -2); } 70% { translate: 0 0; } 85% { translate: 0 calc(var(--u) * -1); } }
@keyframes claude-rise { from { opacity: 0; translate: 0 10px; } }
${me} { --u: 6px; position: relative !important; display: block !important; flex: none !important; width: calc(var(--u) * ${CLAWD[0]!.length}) !important; height: calc(var(--u) * ${CLAWD.length * 2}) !important; padding: 0 !important; margin: 0 !important; overflow: visible !important; font-size: 0 !important; line-height: 0 !important; color: var(--claude); animation: claude-hop 0.9s cubic-bezier(0.3, 0, 0.3, 1) 0.15s backwards; }
${me}::before, ${me}::after { content: ""; position: absolute; left: 0; top: 0; width: var(--u); height: calc(var(--u) * 2); }
${me}::before { box-shadow: ${body}; }
/* The eyes are dark on any page, as on Claude Code's own start screen, and close for a blink. */
${me}::after { box-shadow: ${eyes}; color: #141413; transform-origin: 50% calc(var(--u) * 4); animation: claude-blink 5.5s steps(1) 1.5s infinite; }
/* The stage Clawd stands on, and the sun behind it: Claude's spark as light, twelve rays turning slowly in the theme's colour. */
@keyframes claude-sun { to { rotate: 360deg; } }
@keyframes claude-dawn { from { opacity: 0; scale: 0.7; } }
[data-role^="claude.hero.stage"] { position: relative !important; flex: none !important; width: ${STAGE.width}px !important; height: ${STAGE.rest}px; padding: 0 !important; margin: 0 auto -6px !important; overflow: visible !important; isolation: isolate; --sun: var(--claude); transition: height 0.4s cubic-bezier(0.3, 0.7, 0.2, 1); }
/* Clawd stands at the same spot in every state of the stage, so nothing jumps when the power comes or goes. */
[data-role^="claude.hero.stage"] [data-role="claude.clawd"] { position: absolute !important; left: ${STAGE.clawdLeft}px !important; bottom: ${STAGE.floor}px !important; top: auto !important; }
[data-role="claude.hero.stage.rest"] [data-role="claude.clawd"] { animation: none; }
[data-role^="claude.hero.stage"]::before { content: ""; position: absolute; left: 50%; bottom: ${STAGE.floor + 30 - 320}px; z-index: -1; width: 640px; height: 640px; margin: 0 0 0 -320px; border-radius: 50%; pointer-events: none;
  background: radial-gradient(closest-side, color-mix(in oklab, var(--sun) 16%, transparent) 0%, color-mix(in oklab, var(--sun) 6%, transparent) 34%, transparent 72%), repeating-conic-gradient(from 0deg, color-mix(in oklab, var(--sun) 11%, transparent) 0deg 3deg, transparent 3deg 30deg);
  mask-image: radial-gradient(closest-side, #000 12%, rgb(0 0 0 / 0.55) 42%, transparent 80%);
  animation: claude-sun 240s linear infinite; will-change: transform; }
[data-role^="claude.hero.stage"]::after { content: ""; position: absolute; inset: 0; z-index: -1; pointer-events: none; animation: claude-dawn 1.2s ease-out backwards; }
/* What Tern draws behind a fresh composer (a dot grid under a violet glow) gives way to a low glow in the theme's colour. */
[data-role="omp.welcome"] > :empty::before { background-image: radial-gradient(560px 110px at 50% 100%, color-mix(in oklab, var(--claude) 11%, transparent), transparent) !important; background-size: 100% 100% !important; background-repeat: no-repeat !important; }
@media (prefers-reduced-motion: reduce) { [data-role^="claude.hero.stage"]::before { animation: none !important; } }
/* The start screen: Clawd, a greeting in Claude's serif, and one quiet line of facts. */
[data-role="claude.hero"], [data-role="claude.hero.past"] { align-items: center !important; gap: 14px !important; padding: 6px 0 2px; }
/* Above a conversation the start screen is only its head: the sun sets and nothing there keeps moving while it is scrolled away. */
[data-role="claude.hero.past"] [data-role^="claude.hero.stage"]::before { display: none; }
[data-role="claude.hero.past"] [data-role="claude.clawd"], [data-role="claude.hero.past"] [data-role="claude.clawd"]::after , [data-role="claude.hero.past"] [data-role^="claude.ssj."] { animation: none !important; }
[data-role="claude.hero.greeting"] { font: 500 30px/1.15 ${SERIF} !important; letter-spacing: -0.015em !important; color: var(--t1); text-align: center; animation: claude-rise 0.6s ease-out 0.2s backwards; }
[data-role="claude.hero.facts"] { font: 11.5px/1.3 var(--tv-font, var(--mono)) !important; color: var(--t4); text-align: center; max-width: 100%; text-wrap: balance; animation: claude-rise 0.6s ease-out 0.35s backwards; }
`;
}

/**
 * The surface's own styles. Everything is scoped to the surface and built on
 * Tern's theme variables; `accent` is the one thing replaced, and only while
 * the Claude accent is on.
 */
export function stylesheet(clay: boolean): string {
  // Tern scopes a surface's sheet to what is inside its regions, so the
  // variables are set on the nodes themselves rather than on the region.
  const accent = clay
    ? `
* {
  --claude: light-dark(#C2603F, #E08A6B);
  --claude-fill: light-dark(#D97757, #C96A4A);
  --claude-wash: color-mix(in oklab, var(--claude) 12%, transparent);
  --accent: var(--claude);
  --accent-ink: var(--claude);
  --accent-fill: var(--claude-fill);
  --a1: var(--claude);
  --a2: light-dark(#E3A06B, #D9925F);
  --live: var(--claude);
  --grad: linear-gradient(135deg, light-dark(#D97757, #C96A4A), light-dark(#C2603F, #B45A3C));
  --grad-ink: #FFFBF7;
}`
    : `
* {
  --claude: var(--accent);
  --claude-fill: var(--accent-fill, var(--accent));
  --claude-wash: color-mix(in oklab, var(--accent) 12%, transparent);
}`;
  return `${accent}
${sparkCss()}
${clawdCss()}
[data-role="omp.working"] [data-role^="claude.spark."] { --spark: 15px; }
/* The composer. Tern's aurora (four hues smeared across the card's lower edge) is put out; in its place light of one
   colour pools under the card, never over it, and swells while Claude works. */
@keyframes claude-horizon { 0%, 100% { scale: 0.16 1; opacity: 0.3; } 50% { scale: 1 1; opacity: 1; } }
@keyframes claude-pool { 0%, 100% { scale: 0.72 0.8; opacity: 0.55; } 50% { scale: 1 1.15; opacity: 1; } }
[data-role^="omp.editor"] { position: relative; --rd-aurora: transparent, transparent; --beam: var(--claude); }
[data-role^="omp.editor"]:has([data-role="claude.composer.ultracode"]) { --beam: ${GOLD}; }
[data-role="claude.composer.glow"] { position: absolute !important; left: 9% !important; right: 9% !important; top: 100% !important; bottom: auto !important; width: auto !important; height: 38px !important; min-height: 0 !important; padding: 0 !important; margin: 0 !important; font-size: 0 !important; line-height: 0 !important; pointer-events: none; transform-origin: 50% 0; background: radial-gradient(50% 100% at 50% 0, color-mix(in oklab, var(--beam) 30%, transparent), color-mix(in oklab, var(--beam) 9%, transparent) 55%, transparent); opacity: 0.6; }
[data-role^="omp.editor"]:has([data-role="omp.composer.stop"]) [data-role="claude.composer.glow"] { animation: claude-pool 2.6s ease-in-out infinite; }
/* While Claude works, light gathers and spreads along the composer's lower edge. (A node of its own: the
   composer's pseudo-elements are Tern's, its border ring and the fresh aurora.) */
[data-role="claude.composer.beam"] { position: absolute !important; left: 34px !important; right: 34px !important; bottom: 0 !important; top: auto !important; width: auto !important; height: 2px !important; min-height: 0 !important; padding: 0 !important; margin: 0 !important; font-size: 0 !important; line-height: 0 !important; overflow: visible !important; border-radius: 2px; pointer-events: none; background: linear-gradient(90deg, transparent, var(--beam) 26%, color-mix(in oklab, var(--beam), white 45%) 50%, var(--beam) 74%, transparent); animation: claude-horizon 2.6s ease-in-out infinite; }
/* Send is Claude's own: a disc of the accent once there is something to send. */
[data-role="omp.composer.send"][data-tone="accent"] * { background: var(--claude-fill) !important; color: #fffbf7 !important; box-shadow: none !important; }
[data-role="claude.composer.ultracode"] { background: color-mix(in oklab, ${ULTRA} 16%, transparent) !important; }
[data-role="claude.composer.ultracode"] * { color: light-dark(${ULTRA}, #b99cff) !important; }
@media (prefers-reduced-motion: reduce) { [data-role="claude.composer.beam"], [data-role="claude.composer.glow"] { animation: none !important; } }
/* The light that runs over the working line is the spark's colour. */
[data-role="omp.working.label"], [data-role="omp.working.label"] * { --sh-hi: var(--claude) !important; }
[data-role="claude.composer.agents"] [data-role^="claude.spark."] { --spark: 12px; }
/* The group Claude's chips sit in is only a group: none of the pill Tern draws for that role, but its height and
   type, so each chip stands as tall as the model's and follows it when the composer folds. */
[data-role="omp.composer.effort"] { background: none !important; box-shadow: none !important; padding: 0 !important; scale: 1 !important; align-self: center !important; align-items: stretch !important; }
[data-role="omp.composer.effort"] > [data-role] { align-self: stretch !important; }
/* On a narrow composer Tern drops a whole item that does not fit. The mode is not one to lose: the group stays and
   the model's name shortens instead. */
[data-role="omp.composer.effort"][data-role][data-role][data-role] { display: flex !important; flex: none !important; }
/* Tern lines the bar up on text baselines, and a group of chips has none of its own: both sit on the bar's middle. */
[data-role="omp.composer.model"] { align-self: center !important; }
[data-role="claude.composer.mode"] { border-radius: 999px; padding: 0 0.6em; cursor: pointer; background: var(--l1); }
[data-role="claude.composer.mode"][data-tone="accent"] { background: var(--claude-wash); }
[data-role="claude.composer.agents"] { border-radius: 999px; padding: 0 0.6em; cursor: pointer; background: var(--l1); }
[data-role="claude.agents.tile"] { border-radius: 14px; padding: 0.6em 0.7em; cursor: pointer; background: var(--l1); }
[data-role="claude.agents.tile"][data-tone="info"] { background: color-mix(in oklab, var(--live, var(--accent)) 7%, transparent); box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--live, var(--accent)) 22%, transparent); }
[data-role="claude.agents.tile"][data-tone="error"] { box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--err, #d33) 30%, transparent); }
[data-role="claude.agents.nav"] { position: sticky; top: 0; z-index: 2; }
/* The effort track names its stops under it: the number beside it says nothing. */
[data-role="claude.effort.slider"] > span { display: none; }
[data-role="claude.effort.label"] { cursor: pointer; }
[data-role="claude.composer.ultracode"] { border-radius: 999px; padding: 0 0.6em; cursor: pointer; background: var(--claude-wash); }
[data-role="claude.composer.mode"][data-tone="info"] { background: color-mix(in oklab, var(--live, var(--accent)) 14%, transparent); }
[data-role="claude.composer.mode"][data-tone="success"] { background: color-mix(in oklab, var(--ok) 14%, transparent); }
[data-role="claude.composer.mode"][data-tone="warning"] { background: color-mix(in oklab, var(--warn) 16%, transparent); }
[data-role="claude.composer.mode"][data-tone="error"] { background: color-mix(in oklab, var(--bad) 16%, transparent); }
[data-role="claude.composer.mode"][data-tone="accent"] * { color: var(--claude); }
.pf-mark { background: var(--claude-fill); }
.pf-mark svg { display: none; }
.pf-mark::after { content: "✻"; color: #FBF6F1; font-size: 15px; line-height: 1; }
/* Tern's reading column is 880px wide and its composer 736px: a reply then starts left of the composer and the page looks lopsided. The column takes the composer's width. */
* { --rd-measure: 736px; }
/* Panels of the dock (the error banner, a text dialog) take the composer's width, as the approval panel does. */
[data-role="omp.errorBanner"], [data-role="omp.overlay.hook-input"], [data-role="omp.overlay.hook-editor"] { width: 100%; max-width: 736px; margin-left: auto; margin-right: auto; box-sizing: border-box; align-self: center; }
[data-role="claude.plugin.band"] { border-left: 2px solid var(--claude); padding: 0.3em 0.9em; margin: 0 auto 0.4em; width: 100%; max-width: 737px; box-sizing: border-box; align-self: center; }
[data-role="claude.plan"] { border-left: 2px solid var(--claude); padding-left: 0.9em; }
[data-role="claude.approval.preview"] { border-radius: var(--r-ctl, 8px); }
[data-role="claude.welcome.account"] { opacity: 0.85; }
`;
}

/** The powered-up scene's cell, in pixels: half of one of Clawd's own. */
const CELL = 3;

/** Clawd's stage, in pixels: as wide as the powered-up scene, as tall as Clawd at rest and as the scene when it burns. */
const STAGE = {
  width: SPRITE.width * CELL,
  tall: SPRITE.height * CELL,
  floor: (SPRITE.height - SPRITE.ground) * CELL,
  rest: (SPRITE.ground - SPRITE.clawdY) * CELL + (SPRITE.height - SPRITE.ground) * CELL,
  clawdLeft: SPRITE.clawdX * CELL,
} as const;

/** One frame of pixel art as CSS backgrounds: a hard-edged gradient for every row that holds something. */
function sprite(name: string, cell: number): string {
  const images: string[] = [];
  const places: string[] = [];
  (SPRITE_FRAMES[name] ?? []).forEach((runs, row) => {
    if (!runs.length) return;
    let x = 0;
    const stops = runs.map(([colour, length]) => {
      x += length;
      // `0` as a stop's start means "where the last one ended": the edge stays hard and the rule short.
      return `${colour < 0 ? "#0000" : SPRITE_COLOURS[colour]} 0 ${x * cell}px`;
    });
    images.push(`linear-gradient(90deg,${stops.join(",")},#0000 0)`);
    places.push(`0 ${row * cell}px`);
  });
  // Each row is a hair taller than its cell, so no page shows between two rows wherever the sprite lands.
  return `background-image: ${images.join(",")}; background-position: ${places.join(",")}; background-size: 100% ${cell + 0.4}px; background-repeat: no-repeat;`;
}

/**
 * Ultracode, on the start screen: Clawd goes Super Saiyan. Dust rises while it
 * charges, a flash, and then the aura burns as three frames of pixel art
 * around a glow, with hair to match and a bolt of lightning now and then. Only
 * opacity, scale and translate move. The sheet is installed while Ultracode is
 * on and removed after, so nobody else carries the art.
 */
export function flareCss(): string {
  const stage = `[data-role="claude.hero.stage.flare"]`;
  const cool = `[data-role="claude.hero.stage.cool"]`;
  const layer = `[data-role^="claude.ssj."]`;
  const frames = (prefix: string, count: number, each: number): string =>
    Array.from({ length: count }, (_, index) => `[data-role="claude.ssj.${prefix}${index}"] { ${sprite(`${prefix}${index}`, CELL)} opacity: ${index ? 0 : 1}; animation: claude-frame${count} ${(count * each).toFixed(2)}s steps(1) ${(index ? -(count - index) * each : 0).toFixed(2)}s infinite; }`).join("\n");
  return `
@keyframes claude-frame3 { 0% { opacity: 1; } 33.34%, 100% { opacity: 0; } }
@keyframes claude-bolt { 0%, 9%, 100% { opacity: 0; } 2%, 4%, 7% { opacity: 1; } 3%, 5.5% { opacity: 0.15; } }
@keyframes claude-power { 0% { scale: 0.15; opacity: 0; } 55% { scale: 1.1; opacity: 1; } 78% { scale: 0.97; } 100% { scale: 1; opacity: 1; } }
@keyframes claude-charge { 0% { opacity: 1; translate: 0 0; } 12% { translate: -2px 1px; } 25% { translate: 2px -1px; } 37% { translate: -2px 0; } 50% { translate: 2px 1px; } 62% { translate: -1px -1px; } 75% { translate: 2px 0; } 87% { opacity: 1; translate: -2px 1px; } 100% { opacity: 0; translate: 0 0; } }
@keyframes claude-dust { 0% { opacity: 0; scale: 0.7 0.6; } 25% { opacity: 1; } 100% { opacity: 0; scale: 1.35 1.15; translate: 0 -6px; } }
@keyframes claude-drain { 0% { opacity: 1; scale: 1; } 100% { opacity: 0; scale: 0.92 0.35; } }
@keyframes claude-return { from { opacity: 0; } to { opacity: 1; } }
@keyframes claude-settle { from { height: ${STAGE.tall}px; } to { height: ${STAGE.rest}px; } }
@keyframes claude-flash { 0% { opacity: 0; scale: 0.15; } 30% { opacity: 1; } 100% { opacity: 0; scale: 1.8; } }
${stage}[data-role] { height: ${STAGE.tall}px; --sun: ${GOLD}; }
${stage}::before { animation-duration: 16s; }
${layer} { position: absolute !important; inset: auto 0 0 0 !important; display: block !important; width: auto !important; height: ${STAGE.tall}px !important; padding: 0 !important; margin: 0 !important; font-size: 0 !important; line-height: 0 !important; pointer-events: none; image-rendering: pixelated; }
/* Everything that arrives with the power pops out of the flash. After that only the frames change: pixel art is never scaled. */
[data-role="claude.ssj.power"] { transform-origin: 50% ${Math.round((SPRITE.ground / SPRITE.height) * 100)}%; animation: claude-power 0.5s cubic-bezier(0.2, 0.8, 0.3, 1) 0.72s backwards; }
${frames("aura", 3, 0.12)}
[data-role="claude.ssj.core"] { ${sprite("core", CELL)} }
[data-role="claude.ssj.hair"] { ${sprite("hair", CELL)} }
[data-role="claude.ssj.clawd"] { ${sprite("clawd", CELL)} }
[data-role="claude.ssj.bolt0"] { ${sprite("bolt0", CELL)} opacity: 0; animation: claude-bolt 2.9s linear 1.4s infinite; }
[data-role="claude.ssj.bolt1"] { ${sprite("bolt1", CELL)} opacity: 0; animation: claude-bolt 4.3s linear 2.6s infinite; }
[data-role="claude.ssj.dust"] { ${sprite("dust", CELL)} opacity: 0; transform-origin: 50% 93%; animation: claude-dust 0.85s ease-out both; }
[data-role="claude.ssj.flash"] { inset: auto !important; left: 50% !important; bottom: ${Math.round(STAGE.tall * 0.38) - 110}px !important; width: 220px !important; height: 220px !important; margin: 0 0 0 -110px !important; border-radius: 50%; background: radial-gradient(closest-side, #fff 0%, #fff7b8 38%, rgb(255 240 150 / 0.5) 58%, transparent 74%); opacity: 0; animation: claude-flash 0.55s ease-out 0.62s backwards; }
/* Clawd as it was, shaking while the power gathers, until the flash takes it. */
${stage} [data-role="claude.clawd"] { opacity: 0; animation: claude-charge 0.78s linear both; }
${stage} [data-role="claude.clawd"]::after { animation: none; }
/* Ultracode switched off: the aura sinks into the ground where it stood, steam rises, Clawd is itself again, and
   then the stage settles to its resting height. */
${cool} { animation: claude-settle 0.5s cubic-bezier(0.4, 0, 0.2, 1) 0.6s both; }
${cool} [data-role="claude.ssj.power"] { animation: claude-drain 0.6s cubic-bezier(0.5, 0, 0.9, 0.5) both; }
${cool} [data-role="claude.ssj.aura0"] { opacity: 1; animation: none; }
${cool} [data-role="claude.ssj.dust"] { animation: claude-dust 0.95s ease-out 0.12s both; }
${cool} [data-role="claude.clawd"] { animation: claude-return 0.5s ease-out 0.1s both; }
@media (prefers-reduced-motion: reduce) {
  ${layer}, ${stage} [data-role="claude.clawd"], ${cool}, ${cool} [data-role="claude.clawd"] { animation: none !important; }
  ${cool} [data-role="claude.ssj.power"] { opacity: 0; }
}`;
}

/**
 * The stylesheet in force while a pane is open.
 *
 * Beside the conversation: every top-level block of the conversation, the
 * dock and the dialogs leaves the pane its `beside` pixels and centres in
 * what is left, at the `measure` that fits. (A region's root cannot be
 * styled, only what is in it; the composer and the rows above it have widths
 * of their own in Tern's sheet.)
 *
 * Under a finger: the pane's buttons and rows get targets a finger can hit.
 */
export function paneCss(layout: { beside: number; measure: number; touch: boolean }): string {
  const rules: string[] = [];
  if (layout.beside) {
    const top = `:not([data-role] [data-role])`;
    // What Tern centres with automatic margins (the composer and the rows above it) would slide to the pane's edge.
    const docked = [`[data-role^="omp.editor"]`, `[data-role^="omp.hud"]`, `[data-role="omp.queue"]`, `[data-role="omp.track"]`].map(role => `${role}${top}`).join(", ");
    rules.push(
      `* { --rd-measure: ${layout.measure}px; }`,
      // Only the margin: a dialog keeps the layer's height, and so its own scrolling.
      `[data-role]${top}:not([data-role="claude.agents"]) { margin-right: ${layout.beside}px !important; }`,
      `${docked} { margin-left: 0 !important; align-self: center !important; }`,
      `[data-role^="omp.editor"]${top} { max-width: ${layout.measure}px !important; }`,
      `[data-role^="omp.hud"]${top}, [data-role="omp.queue"]${top} { max-width: ${layout.measure - 16}px !important; }`,
    );
  }
  if (layout.touch) {
    rules.push(
      `[data-role="claude.agents"] [data-role="claude.agents.btn"] { min-height: 40px; min-width: 40px; padding-left: 14px; padding-right: 14px; }`,
      `[data-role="claude.agents"] [data-role="claude.agents.tile"] { padding: 0.8em 0.9em; }`,
    );
  }
  return rules.join("\n");
}
