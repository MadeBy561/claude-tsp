/** `/release-notes`: the part of Claude Code's changelog worth showing in a sheet. */

/**
 * The newest sections of a changelog, cut to a readable length. The installed
 * version's section is marked, and kept even when the ones above it fill the
 * space: the newest come first, then a gap, then the installed one.
 */
export function releaseNotes(changelog: string, installed: string, limit = 60_000): string {
  const sections = changelog.split(/^(?=## )/m).filter(section => section.startsWith("## "));
  if (!sections.length) return changelog.slice(0, limit);
  const version = (section: string): string => section.match(/^## \[?([\w.-]+)/)?.[1] ?? "";
  const mark = (section: string): string => (installed && version(section) === installed ? section.replace(/^## .*$/m, line => `${line}  (installed)`) : section).trimEnd();
  const mine = installed ? sections.find(section => version(section) === installed) : undefined;
  // Room is kept for the installed section, unless it alone would take everything.
  const reserve = mine && mine.length < limit / 2 ? mine.length : 0;
  let text = "";
  let cut = false;
  let shown = false;
  for (const section of sections) {
    if (text && text.length + section.length > limit - (shown || section === mine ? 0 : reserve)) {
      cut = true;
      break;
    }
    if (section === mine) shown = true;
    text += `${mark(section)}\n\n`;
  }
  if (cut && mine && !shown && reserve) text += `…\n\n${mark(mine)}\n\n`;
  return text.trimEnd();
}
