# Ashlrverse public observatory

A static, credential-free landing page, field guide and interactive replay of a
real local Universe experiment, with a selectable lineage graph and measured comparisons.
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

## Documentation and discovery

`app/data/documentation.json` is the authored task map used by `/docs/` and the
generated `public/agent-guide.md`, `agent-map.json` and `llms.txt` files. It links
canonical repository guides instead of duplicating full execution procedures.
After editing the map, run `npm run generate:discovery`; tests reject stale
generated files and build regenerates them. These documents contain no provider
connections, secrets or private runtime state. `llms.txt` is a convenience index,
not an execution API, industry-wide capability standard or ranking guarantee.

The actual selected binary's `ashlr docs --agent --json` is the authority for its
command discovery. Installed releases may predate current source documentation.

## Search and publication policy

`app/site-config.json` is the single origin and indexing-policy source. The current
owner-private publication intentionally sets `indexable: false`: both HTML pages
carry `noindex`, its sitemap is empty, and robots permits crawling so the directive
is visible if access later permits it. Access control—not robots or metadata—is
the privacy boundary. Never insert account data into this static site.

Before a public launch, confirm the requested audience and verify the canonical
domain and TLS. Set `origin` to that exact working HTTPS origin, set `indexable`
to true, regenerate resources, review metadata, test, build and publish the exact
source. Verify the host's audience and HTTP indexing headers separately. The
public sitemap then contains only `/` and `/docs/`, without invented modification
dates. The pending `verse.ashlr.ai` domain is deliberately not canonical yet.

Metadata includes route-specific titles, descriptions, canonical URLs, text-only
Open Graph/X fields, and factual SoftwareSourceCode JSON-LD. No social image or
review/rating claim is fabricated. Search indexing and rich results are not
guaranteed. See [Google indexing controls](https://developers.google.com/search/docs/crawling-indexing/block-indexing),
[AI search guidance](https://developers.google.com/search/docs/appearance/ai-features),
and [SoftwareSourceCode](https://schema.org/SoftwareSourceCode).

## Provider representation

The logo section describes source capabilities, not live connection health.
Codex and Claude Code support independently authenticated native profiles;
Grok Build is profile/usage monitoring only, not an execution worker. Ollama
provides candidate generation through an explicit running loopback endpoint,
not native file/desktop tools. Named local-model families link to Ollama's
catalog and require calibration for the exact model and hardware. Logos do not
prove endorsement, provider activation or unrestricted multi-account routing.

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
