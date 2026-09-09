# Ashlrverse public observatory

A static, credential-free landing page and interactive replay of a real local
Universe experiment, with a selectable lineage graph and measured comparisons.
Ashlrverse is the public brand; existing Universe commands and evidence stay
compatible. This is not an operational dashboard. It never reads the
operator's accounts, private experiment stores or session tokens.

## Develop and verify

With Node.js 24+, run `npm ci`, then `npm run dev`. For verification run
`npm test`, `npm run typecheck`, `npm run lint`, and `npm run build`.
The lint command covers authored code; generated Shadcn components retain their
upstream source. Components are imported directly and styled at the call site.

The static export is `dist/client/`; do not publish `dist/server/` or private
tool state. `.openai/hosting.json` selects static-only hosting. No Worker, API,
database, cookies, provider requests, analytics or local-storage state is used
by this authored page. Tabs and selection are presentation-only React state.
Copying setup commands requires an explicit click and handles denied clipboard
access. Motion is limited to one entrance and selection transitions; reduced
motion renders the same final states without movement. The graph's bounded
scroll region is keyboard-focusable and keeps labels readable at narrow widths.

## Update the evidence

The source repository's `scripts/generate-universe-showcase.mjs` produces the
allowlisted data in `public/evidence/demo.json`. Keep `app/data/demo.json` byte
identical. Regenerate SVG with `scripts/render-universe-showcase.mjs`; the PNG is
an ordinary raster rendering of that SVG, not a screenshot of a live fleet.

The committed example was recorded on source
`914ebd1f566c0dc4f0a95479d9c4f464289e736e`. Competing workers are predefined
scripts. Reported bytes, seven-case correctness and parent lineage come from the
actual experiment. This does not measure model capability or accepted product
yield. Never replace these inputs with raw console/startup JSON.

Fonts are bundled from Hub: Space Grotesk and IBM Plex Sans. Their OFL licenses
are in `public/licenses/`. The favicon is a code-native geometric mark.
The original orbital concept art and its generation prompt are documented in
[asset provenance](ASSETS.md). It is artwork, not evidence of a running fleet.

## Dependency notes

The initial Sites scaffold's dependency pins were updated to patched compatible
versions. `sharp` is overridden to 0.35.4 to patch its build-tool transitive
dependency. Deployment contains static browser output only, not these build tools.
Recheck `npm audit` when changing dependencies; never use `--force` to conceal
incompatible peer requirements.

## Publication

The source snapshot is also maintained in Hub's `examples/universe-site/`.
Keep account/runtime configuration out of this project. Site publication does
not publish the npm package or commission an autonomous provider fleet.
