/**
 * Claude's identity on a Tern surface: the mark, and a stylesheet that tints
 * the surface with Claude's clay while every other color stays the theme's,
 * so light, dark and custom Tern themes all keep working.
 */

/** Claude's spark, drawn as twelve tapered rays so no font or raster is needed. */
function spark(fill: string): string {
  const rays = Array.from({ length: 12 }, (_, index) => {
    const long = index % 3 === 0 ? 52 : index % 3 === 1 ? 44 : 48;
    return `<path d="M61.6 58 L64 ${64 - long} L66.4 58 Z" transform="rotate(${index * 30 + (index % 2 ? 4 : -3)} 64 64)"/>`;
  }).join("");
  return `<g fill="${fill}" stroke="${fill}" stroke-width="5" stroke-linejoin="round">${rays}</g><circle cx="64" cy="64" r="9" fill="${fill}"/>`;
}

/** The mark on a clay tile (the welcome lockup). */
export const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect width="128" height="128" rx="28" fill="#D97757"/>${spark("#FBF6F1")}</svg>`;

/** Claude's clay, a little deeper on light pages so text set in it stays readable. */
export const CLAY = "#D97757";

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
[data-role="omp.welcome.wordmark"] { font-family: ui-serif, "Iowan Old Style", "Palatino Linotype", Georgia, serif; letter-spacing: -0.01em; }
[data-role="claude.composer.mode"] { border-radius: 999px; padding: 0 0.6em; cursor: pointer; background: var(--l1); }
[data-role="claude.composer.mode"][data-tone="accent"] { background: var(--claude-wash); }
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
/* A narrow pane: the lockup wraps and Tern clips what wrapped, so the mark gives way instead and its small line shortens. */
[data-role="omp.welcome.mark"] { min-width: 0; max-width: calc(100% - 66px); }
[data-role="omp.welcome.version"] { max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
`;
}
