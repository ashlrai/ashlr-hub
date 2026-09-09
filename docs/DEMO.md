# Run the Universe demo

Watch a local engineering loop reject incorrect code, retain different useful
approaches and improve them in a second generation. The demonstration executes
real candidate programs and a separate evaluator. Its transformations are
predefined scripts, not model-generated ideas or a productivity benchmark.

## Recorded example

![Parent-linked demo results: compact 274 to 47 bytes, readable 317 to 210 bytes, seven correctness cases for every retained trial, and broken sort rejected in both generations.](https://raw.githubusercontent.com/ashlrai/ashlr-hub/master/docs/images/universe-demo.png)

This graphic renders the sanitized result captured on 2026-09-09 from source
`914ebd1f566c0dc4f0a95479d9c4f464289e736e`:

| Retained niche | Generation one | Generation two | Correctness |
|----------------|----------------|----------------|-------------|
| Compact | 274 bytes | 47 bytes | 7/7 fixed cases in each generation |
| Readable | 317 bytes | 210 bytes | 7/7 fixed cases in each generation |

The broken sorting variant was rejected in both generations. These are measurements
of this deterministic fixture, not model productivity or accepted engineering yield.
Inspect the [public JSON](https://raw.githubusercontent.com/ashlrai/ashlr-hub/master/docs/images/universe-demo.json)
or [accessible SVG](https://raw.githubusercontent.com/ashlrai/ashlr-hub/master/docs/images/universe-demo.svg).

## Before you start

Use a trusted source checkout with Git, Node.js 24+ and macOS `sandbox-exec`.
The package's general Node minimum is 22.15; Node 24 is the verified development
path used here. Universe experiment execution currently requires macOS isolation;
Linux and Windows are not supported for this experiment path.

The demo does not call a model provider, require account credentials, consume a
subscription quota, enroll a project, start a daemon or publish changes. It does
create a private Git seed, candidate files, evaluator processes and durable local
records. Installing dependencies requires registry access; the experiment itself
uses local execution. Check the [source quickstart](QUICKSTART.md#run-the-current-universe-kernel)
if you have an older globally installed `ashlr`.

## Run and inspect

1. From the repository root, install the locked dependencies and build. These
   commands execute trusted repository scripts locally:

   ```sh
   npm ci
   npm run build
   node bin/ashlr universe help
   ```

2. Create a fresh private store, then authorize the demo's bounded local work in
   that store. Keep this shell open so later commands use the same root:

   ```sh
   ASHLR_DEMO_ROOT="$(mktemp -d /private/tmp/ashlr-universe-demo.XXXXXX)"
   node bin/ashlr universe demo --root "$ASHLR_DEMO_ROOT" --json
   ```

   Expect exit code `0`, `measurementScope: "local-experiment"`, `verified: true`
   and every member of `checks` set to `true`. Record the generated `universeId`
   if this store contains multiple experiments. Temporary storage is suitable for
   exploration; use a new absolute private root outside your checkout for records
   you intend to retain. Do not rerun a failed command just to hide its first result.

3. Read the saved outcomes without executing another generation:

   ```sh
   node bin/ashlr universe status --root "$ASHLR_DEMO_ROOT" --json
   node bin/ashlr universe archive --root "$ASHLR_DEMO_ROOT" --json
   ```

4. Open the foreground observation console:

   ```sh
   node bin/ashlr universe console --root "$ASHLR_DEMO_ROOT"
   ```

   Open the printed loopback URL and enter its private read token. Inspect the two
   generations, trial results, archived artifacts and parent relationships. Keep
   the console terminal running; Ctrl-C stops this observer, not an independently
   running campaign. Opening the console does not start experiments.

Startup tokens and raw records may contain private authority or filesystem paths.
Do not publish them. The [scoped console guide](ASHLR-UNIVERSE.md#observe-one-universe-store)
explains the read session and explicit store boundary.

## What is evaluated

The task is stable deduplication: remove duplicate values while preserving their
first-occurrence order and leaving the input unchanged. The evaluator runs the
candidate in a child process, checks its returned values independently, and only
then reports the size of `solution.mjs` in bytes. Lower byte count is the objective;
it is not a measure of product usefulness, speed or readability.

The seven fixed input cases are:

| Input | What it exercises |
|-------|-------------------|
| `[]` | Empty input |
| `[3, 1, 3, 2, 1]` | Numeric duplicates and preserved order |
| `['z', 'a', 'z']` | String duplicates and preserved order |
| `[0, false, '', null, 0, false]` | Distinct falsy values |
| `[NaN, 1, NaN, 1]` | Repeated `NaN` values |
| `[2, '2', 2, '2']` | Numeric and string values remain distinct |
| 1,000 values cycling through integers 0–72 | Repeated values over a larger input |

Every case also checks that the input was not mutated. These cases are deliberately
small and fixed; passing them does not prove correctness for every possible input.

## Follow the two generations

Generation one starts all three variants from the pinned seed:

- `compact` and `readable` produce correct, deliberately verbose initial modules.
- `broken` deduplicates and then sorts. That changes order, so the evaluator rejects
  it; it must never enter the archive despite its short code.

The archive retains a passing elite in each declared niche, `compact` and
`readable`. Niches are labels from the manifest, not evaluator judgments about
human readability. They preserve separate approaches instead of letting one
global file-size winner erase the other.

Generation two records each prior same-niche winner as the trial's parent. The
scripted worker detects that a parent exists and writes its predefined smaller
implementation: a Set expression for `compact`, an explicit loop for `readable`.
It does not invent a new strategy or analyze the parent's source. Both selected
trials must pass again, have lower byte counts and record positive improvement
against their parents. The sorting variant must fail again.

The demo's final checks require two completed generations, rejection of the broken
variant, retention of both niches, same-niche parent reuse and measured improvement.
Trial receipts retain the artifact identity, comparator identity and result; the
original seed's `solution.mjs` remains unchanged.

## If a check fails

Keep the failed result and use `universe status` against the same root. A nonzero
exit, incomplete run or `verified: false` is not a successful demo. Check the
recorded failure and your macOS sandbox, Git and Node prerequisites before a new
attempt. Do not disable isolation to turn a refusal into a pass.

If the console looks empty, compare its displayed root with `ASHLR_DEMO_ROOT`.
Do not create another store to repair a root mismatch. Use a fresh root for an
intentional independent repeat; retain the original records for diagnosis. The
demo has no remote release to roll back and does not edit your source checkout.

## Generate a shareable evidence graphic

The source checkout includes a bounded exporter and SVG renderer. They write
local files only; they do not publish a page or upload private records. Use them
after installing the locked dependencies. The exporter below runs a new demo and
checks that the selected Git revision and runtime source/dependency declarations
are unchanged before and after execution. Commit runtime changes first, or select
an explicit clean source checkout with `--source-root /absolute/checkout`.

From the trusted repository root:

```sh
ASHLR_SHOWCASE_DIR="$(mktemp -d /private/tmp/ashlr-showcase.XXXXXX)"
ASHLR_SHOWCASE_REVISION="$(git rev-parse HEAD)"
node scripts/generate-universe-showcase.mjs \
  --root "$ASHLR_SHOWCASE_DIR/experiment" \
  --output "$ASHLR_SHOWCASE_DIR/public-demo.json" \
  --source-revision "$ASHLR_SHOWCASE_REVISION"
node scripts/render-universe-showcase.mjs \
  --input "$ASHLR_SHOWCASE_DIR/public-demo.json" \
  --output "$ASHLR_SHOWCASE_DIR/public-demo.svg"
```

The demo root and output files must not already exist. Their parent directories
must exist, be physical canonical directories owned by the current user, and not
be group- or world-writable. These commands refuse overwrite. On failure, retain
the generated records for diagnosis and choose fresh targets for an intentional
repeat; do not replace the original evidence to make a failed run look successful.

The JSON projection retains fixed demo checks, per-generation outcomes, remapped
trial/parent IDs and measured bytes/cases/deltas. It excludes private roots, raw
trial IDs, prompts, process output and authentication data. The SVG renderer accepts
only that public schema. It produces SVG, not PNG. Inspect the resulting public
files before separately deciding where to publish them.

For an existing private `universe demo --json` result, replace `--root` with
`--input /absolute/private/demo-result.json` and choose a new output file. That
mode does not execute the demo or independently re-read its artifacts. If you
provide `--source-revision` in input mode, it is a caller-supplied label, not a
verified checkout identity. Structural validation and a public graphic are not
an independent audit of arbitrary input evidence.

## What this establishes—and what comes next

A successful run demonstrates candidate execution, independent fixed evaluation,
rejection, archive selection and parent-linked improvement in this local fixture.
Token and dollar fields remain unmeasured (`null`), not invented zero-cost metrics.
It does not establish provider connectivity, general model intelligence, accepted
engineering yield or unattended production reliability.

Next, [define your own experiment](ASHLR-UNIVERSE.md),
[commission an explicit native or local worker](RESOURCE-POOLS.md#commission-native-accounts-and-local-capacity),
or read the [North Star](NORTH-STAR.md). Keep the evaluator and acceptance criteria
stronger than the candidate's claim about its own success.
