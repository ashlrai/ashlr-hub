/**
 * routes/verse/shell/section-modules.ts — every `sections/*Section.tsx` that
 * exists at build time, lazily (unit C1).
 *
 * The rail's surfaces are written by other owners and land at different
 * times (C7's Command/Fleet/Growth/Mind, C6's Apps). A glob yields real
 * per-section code splitting for a module that is present and a missing KEY
 * — not an unresolved import — for one that is not, so the shell builds and
 * runs at every stage of the landing.
 *
 * Lives here rather than in VerseApp.tsx so the framework-free ui store can
 * ask "has Command landed?" (for the first-launch-of-the-day rule) without
 * importing the shell component. Keys are re-based to `./sections/<Module>.tsx`
 * — relative to routes/verse, the form VerseApp and VerseConsoleApp's
 * first-paint preload have always used.
 *
 * THE COST OF A GLOB, paid once: a finished section outside `sections/` is
 * invisible, with nothing failing to say so (MCP shipped that way for a
 * release). VerseApp.test.tsx walks this map for every VERSE_SECTIONS entry.
 */
type Importer = () => Promise<unknown>;

const RAW: Record<string, Importer> = import.meta.glob('../sections/*Section.tsx');

export const SECTION_MODULES: Record<string, Importer> = Object.fromEntries(
  Object.entries(RAW).map(([key, load]) => [key.replace(/^\.\.\//, './'), load]),
);

/** The importer for one module name (`ChatSection`), or undefined when it has not landed. */
export function sectionImporter(module: string, modules: Record<string, Importer> = SECTION_MODULES): Importer | undefined {
  return modules[`./sections/${module}.tsx`];
}
