/**
 * The supervised llama-server serving runtime (src/core/local-runtime/llama/**).
 *
 * Everything here is PURE or temp-directory bound: no process is spawned, no
 * socket is bound, no real llama-server is contacted. The parts that genuinely
 * need a live server (does `start` actually produce four concurrent slots?)
 * are verified by running the CLI against the machine, not here — a test that
 * loads a 27 GB model is not a test anybody will run.
 *
 * What IS pinned here is every rule that would be dangerous or invisible if it
 * drifted:
 *
 *   - the pid-recycling guard (a recycled pid must never become a kill),
 *   - slot capacity never falling back to the flag we requested,
 *   - the GGUF digest being derived from the manifest rather than assumed,
 *   - the ownership record's shape carrying nothing that could be a secret,
 *   - the launch agent's plist actually asking launchd for 24/7.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  blobBasenameForDigest,
  parseOllamaModelRef,
  resolveOllamaModelBlob,
  selectModelLayer,
  resolveOllamaRefForBlobPath,
} from '../src/core/local-runtime/llama/ollama-blob.js';
import {
  argvBindsPort,
  argvMatchesRecord,
  isLlamaServerArgv,
  modelPathFromArgv,
  processAlive,
  shouldReclaim,
} from '../src/core/local-runtime/llama/process.js';
import { parseOwnershipRecord } from '../src/core/local-runtime/llama/record.js';
import {
  baseUrlFromRecord,
  buildLlamaServerArgs,
  isLoopbackHost,
  NO_LOCAL_AGENT_DEFAULTS,
  resolveLocalAgentDefaults,
  originFor,
  resolveLlamaRuntimeConfig,
  resolveLlamaServerBaseUrl,
  resolveLocalAnthropicBaseUrl,
} from '../src/core/local-runtime/llama/config.js';
import {
  composeSnapshot,
  deriveSlotCapacity,
  fleetConcurrencyLimit,
  identifyRuntime,
  interpretHealth,
  probeLlamaRuntime,
  type EndpointReading,
  type FetchLike,
} from '../src/core/local-runtime/llama/health.js';
import {
  buildLaunchAgentPlist,
  buildLaunchAgentShim,
  escapeXml,
  shQuote,
} from '../src/core/local-runtime/llama/launchd.js';
import type { LlamaOwnershipRecord } from '../src/core/local-runtime/llama/types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MODEL_DIGEST = 'sha256:2bb22714289826d7b9e0ba376c3ce47d08bce39abe598745857c44d88c09bdbf';
const PROJECTOR_DIGEST = 'sha256:ac3714bfdddeca31351f2752bf1a63f266f4df87c0b68c895e44945ca704448e';

function sampleRecord(over: Partial<LlamaOwnershipRecord> = {}): LlamaOwnershipRecord {
  return {
    schemaVersion: 1,
    pid: 4242,
    port: 8080,
    host: '127.0.0.1',
    binPath: '/opt/homebrew/bin/llama-server',
    modelPath: '/Users/x/.ollama/models/blobs/sha256-2bb2',
    modelRef: 'qwen3.8:27b-ctx64k',
    args: ['-m', '/Users/x/.ollama/models/blobs/sha256-2bb2', '--port', '8080'],
    requestedSlots: 4,
    requestedContext: 65_536,
    startedAt: '2026-09-21T01:07:00.000Z',
    owner: 'cli',
    ...over,
  };
}

function reading(over: Partial<EndpointReading> = {}): EndpointReading {
  return { httpStatus: 200, body: null, error: null, ...over };
}

const tempDirs: string[] = [];
function tempStore(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ashlr-ollama-store-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// GGUF resolution — the digest must be DERIVED, never assumed
// ---------------------------------------------------------------------------

describe('Ollama model reference parsing', () => {
  it('defaults the registry, namespace and tag', () => {
    expect(parseOllamaModelRef('qwen3.8:27b-ctx64k')).toEqual({
      registry: 'registry.ollama.ai',
      namespace: 'library',
      name: 'qwen3.8',
      tag: '27b-ctx64k',
      canonical: 'qwen3.8:27b-ctx64k',
    });
    expect(parseOllamaModelRef('bge-m3')?.tag).toBe('latest');
    expect(parseOllamaModelRef('someone/model:v1')?.namespace).toBe('someone');
    expect(parseOllamaModelRef('reg.example.com/ns/model:v1')?.registry).toBe('reg.example.com');
  });

  it('refuses anything that could escape the model store', () => {
    // Each of these would otherwise become a path segment.
    for (const bad of ['../etc/passwd', 'ns/../../x', 'a/b/c/d', '', '   ', '.hidden', 'x:y:z']) {
      expect(parseOllamaModelRef(bad)).toBeNull();
    }
    expect(parseOllamaModelRef('model:../tag')).toBeNull();
  });
});

describe('manifest layer selection', () => {
  it('selects by media type, not by size or position', () => {
    // The projector layer comes FIRST in a real qwen3.8 manifest. Picking the
    // first layer, or the biggest, would both be wrong in some manifest.
    const manifest = {
      layers: [
        { mediaType: 'application/vnd.ollama.image.projector', digest: PROJECTOR_DIGEST, size: 931_146_016 },
        { mediaType: 'application/vnd.ollama.image.model', digest: MODEL_DIGEST, size: 29_047_084_384 },
        { mediaType: 'application/vnd.ollama.image.license', digest: 'sha256:aa', size: 11_345 },
      ],
    };
    expect(selectModelLayer(manifest)).toEqual({ digest: MODEL_DIGEST, size: 29_047_084_384 });
  });

  it('returns null rather than guessing when there is no model layer', () => {
    expect(selectModelLayer({ layers: [{ mediaType: 'x', digest: 'sha256:aa' }] })).toBeNull();
    expect(selectModelLayer({ layers: 'not-an-array' })).toBeNull();
    expect(selectModelLayer(null)).toBeNull();
    expect(selectModelLayer('nonsense')).toBeNull();
  });

  it('converts a digest to its on-disk basename, and refuses a malformed one', () => {
    expect(blobBasenameForDigest(MODEL_DIGEST)).toBe(MODEL_DIGEST.replace(':', '-'));
    expect(blobBasenameForDigest('sha512:abc')).toBeNull();
    expect(blobBasenameForDigest('sha256:NOTHEX')).toBeNull();
    expect(blobBasenameForDigest('../../etc/passwd')).toBeNull();
  });
});

describe('resolving the GGUF out of an Ollama store', () => {
  function seedStore(opts: { withBlob: boolean }): string {
    const root = tempStore();
    const manifestDir = join(root, 'manifests', 'registry.ollama.ai', 'library', 'qwen3.8');
    mkdirSync(manifestDir, { recursive: true });
    writeFileSync(
      join(manifestDir, '27b-ctx64k'),
      JSON.stringify({
        layers: [
          { mediaType: 'application/vnd.ollama.image.projector', digest: PROJECTOR_DIGEST, size: 1 },
          { mediaType: 'application/vnd.ollama.image.model', digest: MODEL_DIGEST, size: 29_047_084_384 },
        ],
      }),
    );
    if (opts.withBlob) {
      mkdirSync(join(root, 'blobs'), { recursive: true });
      writeFileSync(join(root, 'blobs', MODEL_DIGEST.replace(':', '-')), 'gguf');
    }
    return root;
  }

  it('derives the blob path from the manifest digest', () => {
    const root = seedStore({ withBlob: true });
    const resolved = resolveOllamaModelBlob('qwen3.8:27b-ctx64k', root);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.digest).toBe(MODEL_DIGEST);
    expect(resolved.blobPath).toBe(join(root, 'blobs', MODEL_DIGEST.replace(':', '-')));
    expect(resolved.sizeBytes).toBe(29_047_084_384);
  });

  it('recovers the REFERENCE from a blob digest, so an adopted runtime has a name', () => {
    // llama-server reports its `model_path`, which for a GGUF out of Ollama's
    // content-addressed store is `sha256-…` — a digest that names this
    // machine's storage layout and nothing else. A runtime the operator
    // started by hand has no `modelRef` in its ownership record, so without
    // this reverse lookup every surface could only say "unknown".
    const root = seedStore({ withBlob: true });
    const blob = join(root, 'blobs', MODEL_DIGEST.replace(':', '-'));
    expect(resolveOllamaRefForBlobPath(blob, root)).toBe('qwen3.8:27b-ctx64k');
  });

  it('returns null rather than guessing when the digest matches no manifest', () => {
    const root = seedStore({ withBlob: true });
    expect(resolveOllamaRefForBlobPath(
      join(root, 'blobs', `sha256-${'0'.repeat(64)}`), root,
    )).toBeNull();
    // And a path that is not a blob at all is not searched for.
    expect(resolveOllamaRefForBlobPath('/models/qwen3.8-27b-q8_0.gguf', root)).toBeNull();
    expect(resolveOllamaRefForBlobPath('../../etc/passwd', root)).toBeNull();
  });

  it('reports a manifest that names a blob which is not there', () => {
    // Handing llama-server a missing path fails far less legibly than this.
    const root = seedStore({ withBlob: false });
    const resolved = resolveOllamaModelBlob('qwen3.8:27b-ctx64k', root);
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.reason).toContain('blob is missing');
    expect(resolved.reason).toContain('ollama pull qwen3.8:27b-ctx64k');
  });

  it('never throws for a missing manifest, and says how to fix it', () => {
    const resolved = resolveOllamaModelBlob('not-pulled:latest', tempStore());
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.reason).toContain('ollama pull not-pulled:latest');
  });
});

// ---------------------------------------------------------------------------
// Ownership — the pid-recycling guard
// ---------------------------------------------------------------------------

describe('reclaim decision', () => {
  const OURS = { processAlive: true, argvMatches: true };

  it('reclaims an orphan of ours', () => {
    expect(shouldReclaim(sampleRecord(), 8080, OURS)).toBe(true);
  });

  it('never kills a recycled pid', () => {
    // The owner is gone and the pid is alive, but it now belongs to some other
    // program — argv does not match. This is the whole point of the guard.
    expect(shouldReclaim(sampleRecord(), 8080, { ...OURS, argvMatches: false })).toBe(false);
  });

  it('does not act on a dead pid, or a record for another port', () => {
    expect(shouldReclaim(sampleRecord(), 8080, { processAlive: false, argvMatches: false })).toBe(false);
    expect(shouldReclaim(sampleRecord(), 8081, OURS)).toBe(false);
  });

  it('never treats pid 1 or below as a candidate', () => {
    for (const pid of [-1, 0, 1]) {
      expect(shouldReclaim(sampleRecord({ pid }), 8080, OURS)).toBe(false);
    }
  });

  it('liveness excludes pid 0 and pid 1 by policy', () => {
    expect(processAlive(process.pid)).toBe(true);
    expect(processAlive(0)).toBe(false);
    expect(processAlive(1)).toBe(false);
  });
});

describe('argv ownership matching', () => {
  const record = sampleRecord();

  it('requires the binary, the model AND the port', () => {
    const full = `${record.binPath} -m ${record.modelPath} --host 127.0.0.1 --port 8080 --parallel 4`;
    expect(argvMatchesRecord(full, record)).toBe(true);

    // Right binary, right port, WRONG model — a second llama-server serving
    // something else must not be mistaken for ours.
    expect(argvMatchesRecord(`${record.binPath} -m /other/blob --port 8080`, record)).toBe(false);
    // Right binary and model, wrong port.
    expect(argvMatchesRecord(`${record.binPath} -m ${record.modelPath} --port 8081`, record)).toBe(false);
    // Our path as a SUBSTRING rather than the command — a prefix match would
    // let /usr/bin/strace impersonate us.
    expect(argvMatchesRecord(`/usr/bin/strace ${record.binPath} -m ${record.modelPath} --port 8080`, record)).toBe(false);
    expect(argvMatchesRecord('', record)).toBe(false);
  });

  it('matches a port exactly, in either spelling', () => {
    expect(argvBindsPort('llama-server --port 8080', 8080)).toBe(true);
    expect(argvBindsPort('llama-server --port=8080', 8080)).toBe(true);
    // 80801 must not satisfy a search for 8080.
    expect(argvBindsPort('llama-server --port 80801', 8080)).toBe(false);
    expect(argvBindsPort('llama-server --port 8080', 808)).toBe(false);
  });

  it('recognises llama-server by its argv[0] basename, not a substring', () => {
    expect(isLlamaServerArgv('/opt/homebrew/bin/llama-server --port 8080')).toBe(true);
    expect(isLlamaServerArgv('llama-server')).toBe(true);
    // A grep FOR llama-server is not a llama-server.
    expect(isLlamaServerArgv('grep llama-server')).toBe(false);
    expect(isLlamaServerArgv('/usr/bin/llama-server-wrapper')).toBe(false);
  });

  it('recovers the model path from either flag spelling', () => {
    expect(modelPathFromArgv('llama-server -m /blob --port 8080')).toBe('/blob');
    expect(modelPathFromArgv('llama-server --model /blob')).toBe('/blob');
    expect(modelPathFromArgv('llama-server --model=/blob')).toBe('/blob');
    expect(modelPathFromArgv('llama-server --port 8080')).toBeNull();
    expect(modelPathFromArgv('llama-server -m')).toBeNull();
  });
});

describe('the ownership record', () => {
  it('round-trips and carries nothing that could be a secret', () => {
    const json = JSON.stringify(sampleRecord());
    expect(parseOwnershipRecord(JSON.parse(json))).toEqual(sampleRecord());
    // Two pids, a port, some paths, an argv and a timestamp. A token could not
    // hide in here even if the spawn path regressed.
    expect(json).not.toMatch(/token|secret|bearer|key/i);
  });

  it('discards anything it cannot fully validate', () => {
    // A discarded record can never become a kill decision, which is why this
    // rejects rather than repairs.
    expect(parseOwnershipRecord(null)).toBeNull();
    expect(parseOwnershipRecord('nope')).toBeNull();
    expect(parseOwnershipRecord({})).toBeNull();
    expect(parseOwnershipRecord({ ...sampleRecord(), schemaVersion: 2 })).toBeNull();
    expect(parseOwnershipRecord({ ...sampleRecord(), pid: 1 })).toBeNull();
    expect(parseOwnershipRecord({ ...sampleRecord(), pid: 'x' })).toBeNull();
    expect(parseOwnershipRecord({ ...sampleRecord(), port: 0 })).toBeNull();
    expect(parseOwnershipRecord({ ...sampleRecord(), port: 70_000 })).toBeNull();
    expect(parseOwnershipRecord({ ...sampleRecord(), binPath: '' })).toBeNull();
    expect(parseOwnershipRecord({ ...sampleRecord(), owner: 'root' })).toBeNull();
    expect(parseOwnershipRecord({ ...sampleRecord(), startedAt: 'never' })).toBeNull();
    expect(parseOwnershipRecord({ ...sampleRecord(), args: [1, 2] })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Launch argv and endpoint resolution
// ---------------------------------------------------------------------------

describe('llama-server launch argv', () => {
  it('is exactly the measured configuration', () => {
    expect(
      buildLlamaServerArgs(
        { host: '127.0.0.1', port: 8080, slots: 4, context: 65_536, extraArgs: [] },
        '/blobs/sha256-2bb2',
      ),
    ).toEqual([
      '-m', '/blobs/sha256-2bb2',
      '--host', '127.0.0.1',
      '--port', '8080',
      '--parallel', '4',
      '-c', '65536',
      '--cont-batching',
      '--cache-prompt',
      '--metrics',
    ]);
  });

  // Regression: a runtime launched without `--metrics` answers 501 on
  // /metrics ("Start it with `--metrics`", llama-server's own words) while
  // /props and /slots answer normally — so the gap is invisible until someone
  // tries to read cumulative token counters.
  it('enables the metrics endpoint', () => {
    expect(
      buildLlamaServerArgs(
        { host: '127.0.0.1', port: 8080, slots: 4, context: 65_536, extraArgs: [] },
        '/blob',
      ),
    ).toContain('--metrics');
  });

  // The asymmetry is deliberate and worth pinning: `--metrics` exposes
  // read-only counters, `--props` would let anything that reaches the port
  // rewrite sampling on a live launchd-managed server via POST /props.
  it('does NOT enable POST /props', () => {
    expect(
      buildLlamaServerArgs(
        { host: '127.0.0.1', port: 8080, slots: 4, context: 65_536, extraArgs: [] },
        '/blob',
      ),
    ).not.toContain('--props');
  });

  it('appends operator extras verbatim, after the managed flags', () => {
    const args = buildLlamaServerArgs(
      { host: '127.0.0.1', port: 8081, slots: 2, context: 8_192, extraArgs: ['--flash-attn'] },
      '/blob',
    );
    expect(args.at(-1)).toBe('--flash-attn');
    expect(args).toContain('--parallel');
  });
});

describe('endpoint resolution', () => {
  const ENV = 'LLAMA_SERVER_BASE_URL';
  afterEach(() => { delete process.env[ENV]; });

  it('lets config beat the environment', () => {
    process.env[ENV] = 'http://env-host:8080/v1';
    const cfg = { models: { llamaServer: { baseUrl: 'http://cfg-host:8080/v1' } } } as never;
    expect(resolveLlamaServerBaseUrl(cfg)).toBe('http://cfg-host:8080/v1');
  });

  it('uses the environment when there is no config override', () => {
    process.env[ENV] = 'http://env-host:9090/v1';
    expect(resolveLlamaServerBaseUrl(undefined)).toBe('http://env-host:9090/v1');
  });

  it('keeps the Anthropic lane on its own precedence chain', () => {
    const ANTHROPIC_ENV = 'LLAMA_SERVER_ANTHROPIC_BASE_URL';
    try {
      // The OpenAI env var must not steer the Anthropic lane, and vice versa:
      // they are two different endpoints (llama-server, and the normalising
      // proxy in front of it), and one variable moving both is how a lane
      // silently loses its normalisation.
      process.env[ENV] = 'http://env-host:9090/v1';
      expect(resolveLocalAnthropicBaseUrl(undefined)).toBe('http://127.0.0.1:8081/v1');

      process.env[ANTHROPIC_ENV] = 'http://env-host:7000/v1';
      expect(resolveLocalAnthropicBaseUrl(undefined)).toBe('http://env-host:7000/v1');
      expect(resolveLlamaServerBaseUrl(undefined)).toBe('http://env-host:9090/v1');

      // Config still beats the environment, exactly as it does for the
      // OpenAI lane.
      const cfg = { models: { llamaServer: { anthropicBaseUrl: 'http://cfg:6000/v1' } } } as never;
      expect(resolveLocalAnthropicBaseUrl(cfg)).toBe('http://cfg:6000/v1');
    } finally {
      delete process.env[ANTHROPIC_ENV];
    }
  });

  it('defers to a record only when the default would miss it', () => {
    // loopback:8080 is exactly where the default already points, so rewriting
    // the published default spelling would change a name for no gain.
    expect(baseUrlFromRecord({ host: '127.0.0.1', port: 8080 })).toBeNull();
    expect(baseUrlFromRecord({ host: 'localhost', port: 8080 })).toBeNull();
    expect(baseUrlFromRecord({ host: '127.0.0.1', port: 8081 })).toBe('http://127.0.0.1:8081/v1');
    expect(baseUrlFromRecord({ host: '10.0.0.4', port: 8080 })).toBe('http://10.0.0.4:8080/v1');
    expect(baseUrlFromRecord(null)).toBeNull();
  });

  it('brackets an IPv6 authority', () => {
    expect(originFor('::1', 8080)).toBe('http://[::1]:8080');
    expect(originFor('127.0.0.1', 8080)).toBe('http://127.0.0.1:8080');
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('10.0.0.4')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Health and capacity
// ---------------------------------------------------------------------------

describe('health interpretation', () => {
  it('distinguishes loading from down', () => {
    // A 27 GB model takes minutes to map on a cold cache. Calling that "down"
    // makes an operator kill a runtime that was about to work.
    expect(interpretHealth(reading({ httpStatus: 200, body: { status: 'ok' } }))).toBe('up');
    expect(interpretHealth(reading({ httpStatus: 503, body: { status: 'loading model' } }))).toBe('loading');
    expect(interpretHealth(reading({ httpStatus: null, error: 'connect ECONNREFUSED 127.0.0.1:8080' }))).toBe('down');
    expect(interpretHealth(reading({ httpStatus: null, error: 'fetch failed' }))).toBe('down');
  });

  it('reports an unreadable answer as unknown rather than guessing', () => {
    expect(interpretHealth(reading({ httpStatus: null, error: 'timed out after 2000ms' }))).toBe('unknown');
    expect(interpretHealth(reading({ httpStatus: 500, body: null }))).toBe('unknown');
  });
});

describe('slot capacity', () => {
  it('prefers what the server says it built', () => {
    const capacity = deriveSlotCapacity(
      reading({ body: { total_slots: 4 } }),
      reading({ body: [{ is_processing: true }, { is_processing: false }, { is_processing: false }, { is_processing: false }] }),
    );
    expect(capacity).toEqual({ configured: 4, busy: 1, idle: 3, source: 'props' });
  });

  it('falls back to the length of /slots, not to the flag we asked for', () => {
    const capacity = deriveSlotCapacity(
      reading({ httpStatus: 501, body: null }),
      reading({ body: [{ is_processing: false }, { is_processing: false }] }),
    );
    expect(capacity.configured).toBe(2);
    expect(capacity.source).toBe('slots');
  });

  it('is null — never a number — when the server cannot be read', () => {
    // This is the invariant the whole design turns on: a fleet configured from
    // a guessed slot count queues invisibly.
    const capacity = deriveSlotCapacity(reading({ httpStatus: null, error: 'down' }), reading({ httpStatus: null, error: 'down' }));
    expect(capacity).toEqual({ configured: null, busy: null, idle: null, source: 'unknown' });
  });

  it('counts a numeric slot state as busy when is_processing is absent', () => {
    const capacity = deriveSlotCapacity(reading({ body: { total_slots: 2 } }), reading({ body: [{ state: 1 }, { state: 0 }] }));
    expect(capacity.busy).toBe(1);
  });
});

describe('snapshot composition', () => {
  const readings = {
    health: reading({ body: { status: 'ok' } }),
    props: reading({
      body: {
        total_slots: 4,
        model_path: '/blobs/sha256-2bb2',
        model_ftype: 'Q8_0',
        default_generation_settings: { n_ctx: 16_384 },
      },
    }),
    slots: reading({ body: [{ is_processing: false }, { is_processing: false }, { is_processing: false }, { is_processing: false }] }),
  };

  it('derives total context from what the server actually built', () => {
    const snapshot = composeSnapshot({
      origin: 'http://127.0.0.1:8080',
      baseUrl: 'http://127.0.0.1:8080/v1',
      host: '127.0.0.1',
      port: 8080,
      readings,
      record: sampleRecord(),
      ownershipVerified: true,
      launchAgent: false,
      killSwitch: false,
      now: Date.parse('2026-09-21T02:07:00.000Z'),
    });
    expect(snapshot.state).toBe('up');
    expect(snapshot.contextPerSlot).toBe(16_384);
    expect(snapshot.contextTotal).toBe(65_536);
    expect(snapshot.quant).toBe('Q8_0');
    expect(snapshot.modelName).toBe('qwen3.8:27b-ctx64k');
    expect(snapshot.pid).toBe(4242);
    expect(snapshot.managed).toBe(true);
    expect(snapshot.uptimeMs).toBe(3_600_000);
  });

  it('refuses to claim a server it could not prove is ours', () => {
    // A record exists, but the live process did not match it. Reporting its pid
    // would invite `stop` to kill a stranger.
    const snapshot = composeSnapshot({
      origin: 'http://127.0.0.1:8080',
      baseUrl: 'http://127.0.0.1:8080/v1',
      host: '127.0.0.1',
      port: 8080,
      readings,
      record: sampleRecord(),
      ownershipVerified: false,
      launchAgent: false,
      killSwitch: false,
    });
    expect(snapshot.managed).toBe(false);
    expect(snapshot.pid).toBeNull();
    expect(snapshot.owner).toBeNull();
    expect(snapshot.uptimeMs).toBeNull();
  });

  it('reports the kill switch and the launch agent without acting on either', () => {
    const snapshot = composeSnapshot({
      origin: 'http://127.0.0.1:8080',
      baseUrl: 'http://127.0.0.1:8080/v1',
      host: '127.0.0.1',
      port: 8080,
      readings,
      record: null,
      ownershipVerified: false,
      launchAgent: true,
      killSwitch: true,
    });
    expect(snapshot.killSwitchEngaged).toBe(true);
    expect(snapshot.launchAgentInstalled).toBe(true);
  });
});

describe('fleet concurrency', () => {
  function snapshotWith(state: 'up' | 'down', configured: number | null) {
    return composeSnapshot({
      origin: 'http://127.0.0.1:8080',
      baseUrl: 'http://127.0.0.1:8080/v1',
      host: '127.0.0.1',
      port: 8080,
      readings: {
        health: state === 'up'
          ? reading({ body: { status: 'ok' } })
          : reading({ httpStatus: null, error: 'ECONNREFUSED' }),
        props: configured === null ? reading({ httpStatus: null, error: 'down' }) : reading({ body: { total_slots: configured } }),
        slots: reading({ httpStatus: null, error: 'down' }),
      },
      record: null,
      ownershipVerified: false,
      launchAgent: false,
      killSwitch: false,
    });
  }

  it('is the server-reported slot count when the server is up', () => {
    expect(fleetConcurrencyLimit(snapshotWith('up', 4))).toBe(4);
  });

  it('is null — not a default — whenever it cannot be known', () => {
    expect(fleetConcurrencyLimit(snapshotWith('down', 4))).toBeNull();
    expect(fleetConcurrencyLimit(snapshotWith('up', null))).toBeNull();
  });
});

describe('probing with an injected transport', () => {
  it('builds a full snapshot without touching a real server', async () => {
    const seen: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      seen.push(url);
      if (url.endsWith('/health')) return { ok: true, status: 200, json: async () => ({ status: 'ok' }) };
      if (url.endsWith('/props')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ total_slots: 4, model_path: '/blob', default_generation_settings: { n_ctx: 16_384 } }),
        };
      }
      return { ok: true, status: 200, json: async () => [{ is_processing: false }] };
    };

    const snapshot = await probeLlamaRuntime({
      origin: 'http://127.0.0.1:8080',
      baseUrl: 'http://127.0.0.1:8080/v1',
      fetchImpl,
      record: null,
    });

    expect(seen.sort()).toEqual([
      'http://127.0.0.1:8080/health',
      'http://127.0.0.1:8080/props',
      'http://127.0.0.1:8080/slots',
    ]);
    expect(snapshot.state).toBe('up');
    expect(snapshot.slots.configured).toBe(4);
    expect(snapshot.port).toBe(8080);
  });

  it('degrades to a down snapshot instead of throwing', async () => {
    const fetchImpl: FetchLike = async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:8080'); };
    const snapshot = await probeLlamaRuntime({
      origin: 'http://127.0.0.1:8080',
      fetchImpl,
      record: null,
    });
    expect(snapshot.state).toBe('down');
    expect(snapshot.slots.configured).toBeNull();
    expect(snapshot.lastError).toContain('ECONNREFUSED');
  });
});

// ---------------------------------------------------------------------------
// The launch agent
// ---------------------------------------------------------------------------

describe('identifying WHICH runtime answered', () => {
  const none: EndpointReading = { httpStatus: null, body: null, error: 'fetch failed' };
  const reading = (body: unknown, status = 200): EndpointReading =>
    ({ httpStatus: status, body, error: null });

  it('a readable slot count is proof of llama-server', () => {
    const slots = deriveSlotCapacity(reading({ total_slots: 4 }), none);
    expect(identifyRuntime(
      { health: reading({ status: 'ok' }), props: reading({ total_slots: 4 }), slots: none },
      slots,
      'up',
    )).toBe('llama-server');
  });

  it('identifies Ollama when /props is absent and /api/version answers', () => {
    // `models.llamaServer.baseUrl` is a string an operator can point anywhere.
    // Pointed at Ollama's /v1 it keeps the engine routable (Ollama serves
    // /v1/models) while 404ing /health and /props — and Ollama SERIALISES this
    // model architecture, so every agent past the first queues invisibly.
    // Reporting that as "llama-server, state unknown" hides the one fact that
    // matters.
    const slots = deriveSlotCapacity(reading({}, 404), none);
    expect(identifyRuntime(
      {
        health: reading({}, 404),
        props: reading({}, 404),
        slots: none,
        ollamaVersion: reading({ version: '0.33.3' }),
      },
      slots,
      'unknown',
    )).toBe('ollama');
  });

  it('an unreachable endpoint is honestly unknown, not asserted', () => {
    const slots = deriveSlotCapacity(none, none);
    expect(identifyRuntime({ health: none, props: none, slots: none }, slots, 'down'))
      .toBe('unknown');
  });

  it('carries Ollama\'s parallel refusal as evidence on the snapshot', () => {
    const snapshot = composeSnapshot({
      origin: 'http://127.0.0.1:11434',
      baseUrl: 'http://127.0.0.1:11434/v1',
      host: '127.0.0.1',
      port: 11434,
      readings: {
        health: reading({}, 404),
        props: reading({}, 404),
        slots: none,
        ollamaVersion: reading({ version: '0.33.3' }),
      },
      record: null,
      ownershipVerified: false,
      launchAgent: false,
      killSwitch: false,
      now: 0,
    });
    expect(snapshot.runtimeKind).toBe('ollama');
    expect(snapshot.parallelRefusal).toMatch(/does not currently support parallel requests/);
  });
});

describe('the bind host is loopback unless the operator persisted otherwise', () => {
  const HOST_ENV = 'ASHLR_LOCAL_RUNTIME_HOST';
  afterEach(() => { delete process.env[HOST_ENV]; });

  function cfgWith(section: Record<string, unknown>): Record<string, unknown> {
    return { models: { llamaServer: section } };
  }

  it('defaults to 127.0.0.1', () => {
    const runtime = resolveLlamaRuntimeConfig();
    expect(runtime.host).toBe('127.0.0.1');
    expect(runtime.hostDowngradedFrom).toBeNull();
  });

  it('REFUSES a non-loopback host from the environment, and says it did', () => {
    // llama-server has no authentication of any kind: whoever reaches the port
    // can run inference and read every slot's prompt. One environment variable
    // must not be able to put that on the LAN — least of all via `install`,
    // which bakes the argv into a KeepAlive launchd job that returns at login.
    process.env[HOST_ENV] = '0.0.0.0';
    const runtime = resolveLlamaRuntimeConfig();
    expect(runtime.host).toBe('127.0.0.1');
    expect(runtime.hostDowngradedFrom).toBe('0.0.0.0');
  });

  it('REFUSES a non-loopback host from config without the explicit opt-in', () => {
    const runtime = resolveLlamaRuntimeConfig(
      cfgWith({ host: '192.168.1.40' }) as never,
    );
    expect(runtime.host).toBe('127.0.0.1');
    expect(runtime.hostDowngradedFrom).toBe('192.168.1.40');
  });

  it('honours a non-loopback host ONLY behind the persisted opt-in', () => {
    const runtime = resolveLlamaRuntimeConfig(
      cfgWith({ host: '192.168.1.40', allowNonLoopback: true }) as never,
    );
    expect(runtime.host).toBe('192.168.1.40');
    expect(runtime.hostDowngradedFrom).toBeNull();
  });

  it('still accepts every loopback spelling without an opt-in', () => {
    for (const host of ['localhost', '127.0.0.1', '::1']) {
      const runtime = resolveLlamaRuntimeConfig(cfgWith({ host }) as never);
      expect(runtime.host).toBe(host);
      expect(runtime.hostDowngradedFrom).toBeNull();
      expect(isLoopbackHost(host)).toBe(true);
    }
  });
});

describe('launch agent plist', () => {
  const spec = {
    binPath: '/opt/homebrew/bin/llama-server',
    args: ['-m', '/blobs/sha256-2bb2', '--port', '8080', '--parallel', '4'],
    stdoutLog: '/Users/x/.ashlr/logs/local-runtime.out.log',
    stderrLog: '/Users/x/.ashlr/logs/local-runtime.err.log',
    workingDirectory: '/Users/x',
  };

  it('actually asks launchd for 24/7', () => {
    const plist = buildLaunchAgentPlist(spec);
    expect(plist).toContain('<key>RunAtLoad</key>\n    <true/>');
    expect(plist).toContain('<key>KeepAlive</key>\n    <true/>');
    expect(plist).toContain('<string>ai.ashlr.local-runtime</string>');
    expect(plist).toContain('<string>Background</string>');
  });

  it('runs the shim, so launchd supervises a re-resolved model', () => {
    // Ollama's blob store is content-addressed: a frozen sha256 path in the
    // plist is garbage-collected by the next `ollama pull`, at which point
    // KeepAlive respawns llama-server against a missing file every ten seconds
    // forever while every surface reports only `state: 'down'`. The plist runs
    // the shim instead; the shim re-resolves and `exec`s, so launchd still
    // supervises llama-server's own pid.
    const plist = buildLaunchAgentPlist(spec, '/Users/x/.ashlr/local-runtime/llama-server-launch.sh');
    const argv = [...plist.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]);
    const start = argv.indexOf('/bin/sh');
    expect(start).toBeGreaterThanOrEqual(0);
    expect(argv.slice(start, start + 2)).toEqual([
      '/bin/sh', '/Users/x/.ashlr/local-runtime/llama-server-launch.sh',
    ]);
  });

  describe('the launcher shim', () => {
    it('uses the frozen blob when it is still there, and re-resolves when it is not', () => {
      const shim = buildLaunchAgentShim({
        ...spec,
        modelRef: 'qwen3.8:27b-ctx64k',
        resolverCommand: ['/usr/local/bin/ashlr', 'local-runtime', 'resolve-model'],
      });
      expect(shim.startsWith('#!/bin/sh')).toBe(true);
      expect(shim).toContain(`MODEL='/blobs/sha256-2bb2'`);
      expect(shim).toContain('if [ ! -f "$MODEL" ]; then');
      expect(shim).toContain(`'/usr/local/bin/ashlr' 'local-runtime' 'resolve-model' --model "$REF"`);
      // `exec` replaces the shell so launchd supervises llama-server itself.
      expect(shim).toContain(`exec '/opt/homebrew/bin/llama-server' -m "$MODEL"`);
      expect(shim).toContain(`'--port' '8080' '--parallel' '4'`);
      // The `-m` pair is carried by the MODEL variable, never duplicated.
      expect(shim.match(/-m /g)?.length).toBe(1);
    });

    it('does not second-guess an explicit model path', () => {
      const shim = buildLaunchAgentShim({ ...spec, modelRef: null, resolverCommand: null });
      expect(shim).not.toContain('RESOLVED=');
      expect(shim).toContain('configured model file is missing');
    });

    it('quotes every interpolated value so a path cannot become shell syntax', () => {
      expect(shQuote("/Users/it's/a path")).toBe(`'/Users/it'\\''s/a path'`);
      const shim = buildLaunchAgentShim({
        ...spec,
        binPath: "/opt/wei'rd; rm -rf ~/llama-server",
        modelRef: '$(touch /tmp/pwned)',
        resolverCommand: ['/usr/local/bin/ashlr', 'local-runtime', 'resolve-model'],
      });
      // Every dangerous value appears ONLY inside a single-quoted literal,
      // where sh performs no expansion at all — the embedded quote is closed,
      // escaped and reopened rather than terminating the literal.
      expect(shim).toContain(shQuote("/opt/wei'rd; rm -rf ~/llama-server"));
      expect(shim).toContain(`REF=${shQuote('$(touch /tmp/pwned)')}`);
      // Never as bare shell syntax.
      expect(shim).not.toContain('exec /opt/wei');
      expect(shim).not.toMatch(/[^']\$\(touch/);
      // Single quotes balance on every line the values land on, which is the
      // structural property that makes the escaping correct. (A `sh -n` syntax
      // check would prove it directly, but spawning a shell would move this
      // whole file into the real-io lane for one assertion.)
      // With the `'\''` escapes removed, every remaining quote must pair up:
      // that is exactly the property that keeps an embedded quote from ending
      // the literal and letting the rest be read as shell syntax.
      for (const line of shim.split('\n')) {
        const withoutEscapes = line.split("'\\''").join('');
        expect((withoutEscapes.match(/'/g) ?? []).length % 2).toBe(0);
      }
    });
  });

  it('logs where the operator is told they are', () => {
    const plist = buildLaunchAgentPlist(spec);
    expect(plist).toContain(spec.stdoutLog);
    expect(plist).toContain(spec.stderrLog);
  });

  it('escapes a path that would otherwise break the XML', () => {
    expect(escapeXml('/Users/a&b/<x>')).toBe('/Users/a&amp;b/&lt;x&gt;');
    const plist = buildLaunchAgentPlist(spec, '/Users/a&b/launch.sh');
    expect(plist).toContain('/Users/a&amp;b/launch.sh');
    expect(plist).not.toContain('/Users/a&b/launch.sh');
  });
});

// ---------------------------------------------------------------------------
// Local agent request defaults
// ---------------------------------------------------------------------------

describe('resolveLocalAgentDefaults', () => {
  const cfg = (agentDefaults: unknown) =>
    ({ models: { llamaServer: { agentDefaults } } }) as never;

  it('changes nothing when the operator configured nothing', () => {
    expect(resolveLocalAgentDefaults(undefined)).toEqual(NO_LOCAL_AGENT_DEFAULTS);
    expect(resolveLocalAgentDefaults(cfg(undefined))).toEqual(NO_LOCAL_AGENT_DEFAULTS);
  });

  it('accepts the three efforts the chat template actually implements', () => {
    for (const effort of ['low', 'medium', 'xhigh'] as const) {
      expect(resolveLocalAgentDefaults(cfg({ reasoningEffort: effort })).reasoningEffort)
        .toBe(effort);
    }
  });

  // THE trap, and the reason this is a closed list rather than a passthrough:
  // 'high' is the spelling every other vendor uses and the one Claude Code
  // itself sends, and Qwen3.8's template answers it with a 500 raised BEFORE
  // inference — a dead turn with no partial output. 'bogus' is the control:
  // if it were accepted, this test would prove nothing about 'high'.
  it('refuses the fatal "high", exactly as it refuses junk', () => {
    expect(resolveLocalAgentDefaults(cfg({ reasoningEffort: 'high' })).reasoningEffort).toBeNull();
    expect(resolveLocalAgentDefaults(cfg({ reasoningEffort: 'bogus' })).reasoningEffort).toBeNull();
    expect(resolveLocalAgentDefaults(cfg({ reasoningEffort: 42 })).reasoningEffort).toBeNull();
  });

  it('range-gates sampling and drops anything out of bounds', () => {
    expect(resolveLocalAgentDefaults(cfg({ temperature: 0.2, topP: 0.9, topK: 20 })))
      .toEqual({ reasoningEffort: null, temperature: 0.2, topP: 0.9, topK: 20 });
    expect(resolveLocalAgentDefaults(cfg({ temperature: 99, topP: 4, topK: 0 })))
      .toEqual(NO_LOCAL_AGENT_DEFAULTS);
  });

  it('survives junk in the config without throwing', () => {
    for (const junk of ['string', 42, [], null]) {
      expect(resolveLocalAgentDefaults(cfg(junk))).toEqual(NO_LOCAL_AGENT_DEFAULTS);
    }
  });
});
