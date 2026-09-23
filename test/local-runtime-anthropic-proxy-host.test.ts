/**
 * The Anthropic proxy as a supervised process: invocation resolution, the
 * environment channel, the launch agent's generated files, and a real bind.
 *
 * The first describe block is a REGRESSION SUITE. `verse-detached-proxy-wip`
 * (c7853f0a) resolved the proxy child from `process.argv[1]`, which works from
 * the CLI and fails from every other caller — including the Verse server, the
 * long-lived host the feature exists for. These tests fail if that assumption
 * comes back.
 */

import { describe, expect, it } from 'vitest';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  ANTHROPIC_PROXY_HOST_FLAG,
  anthropicProxyHostArgv,
  anthropicProxyHostEnvironment,
  anthropicProxyHostInvocation,
} from '../src/core/local-runtime/llama/proxy-invocation.js';
import {
  buildAnthropicProxyPlist,
  buildAnthropicProxyShim,
} from '../src/core/local-runtime/llama/proxy-launchd.js';
import type { AnthropicProxyAgentSpec } from '../src/core/local-runtime/llama/proxy-launchd.js';
import { startAnthropicProxyHost } from '../src/core/local-runtime/llama/anthropic-proxy-host.js';

/** The real on-disk URL of the invocation module, for the dev/tsx branch. */
const REAL_MODULE_URL = pathToFileURL(
  fileURLToPath(new URL('../src/core/local-runtime/llama/proxy-invocation.ts', import.meta.url)),
).href;

describe('anthropicProxyHostArgv — never resolves the child from argv[1]', () => {
  // THE defect. The child must be derived from the MODULE's location, which is
  // a property of the code, not from how the parent process was launched.
  it('does not contain process.argv[1] in any runtime', () => {
    const entry = process.argv[1];
    expect(typeof entry).toBe('string');
    for (const moduleUrl of [
      REAL_MODULE_URL,
      'file:///$bunfs/root/ashlr',
      'file:///opt/app/dist/core/local-runtime/llama/proxy-invocation.js',
    ]) {
      const argv = anthropicProxyHostArgv(moduleUrl);
      expect(argv).not.toContain(entry);
    }
  });

  it('resolves identically no matter what argv[1] says', () => {
    const moduleUrl = 'file:///opt/app/dist/core/local-runtime/llama/proxy-invocation.js';
    const before = anthropicProxyHostArgv(moduleUrl);
    const saved = process.argv[1];
    try {
      // Simulate being called by something that is NOT the ashlr CLI — a test
      // harness, or the Verse server. The WIP branch changed its answer here.
      process.argv[1] = '/some/other/program/server.js';
      expect(anthropicProxyHostArgv(moduleUrl)).toEqual(before);
      process.argv[1] = '/$bunfs/root/_entry.js';
      expect(anthropicProxyHostArgv(moduleUrl)).toEqual(before);
    } finally {
      process.argv[1] = saved as string;
    }
  });

  it('runs the sibling .js on disk for compiled output', () => {
    const argv = anthropicProxyHostArgv(
      'file:///opt/app/dist/core/local-runtime/llama/proxy-invocation.js',
    );
    expect(argv[0]).toBe(process.execPath);
    expect(argv[1]).toBe('/opt/app/dist/core/local-runtime/llama/anthropic-proxy-process.js');
  });

  it('re-enters the binary on a fixed flag inside a single-file bundle', () => {
    // No sibling file exists inside the bundle, so a path spelling would
    // resolve to something unspawnable. This is the Bun case the repo has
    // shipped broken three times.
    expect(anthropicProxyHostArgv('file:///$bunfs/root/ashlr')).toEqual([
      process.execPath,
      ANTHROPIC_PROXY_HOST_FLAG,
    ]);
  });

  it('registers tsx and imports the sibling .ts when running from source', () => {
    const argv = anthropicProxyHostArgv(REAL_MODULE_URL);
    expect(argv[0]).toBe(process.execPath);
    expect(argv).toContain('--input-type=module');
    expect(argv).toContain('--eval');
    const script = argv[argv.length - 1] as string;
    expect(script).toContain('register()');
    expect(script).toContain('anthropic-proxy-process.ts');
  });

  it('keeps the re-entry flag operand-free', () => {
    // The CLI matches it only when it is the ENTIRE argv, so an operand here
    // would make the branch unreachable.
    expect(ANTHROPIC_PROXY_HOST_FLAG.includes(' ')).toBe(false);
    expect(anthropicProxyHostArgv('file:///$bunfs/root/ashlr')).toHaveLength(2);
  });
});

describe('anthropicProxyHostEnvironment', () => {
  // Configuration travels in the environment because `node --eval` rejects a
  // trailing operand tail outright (`node: bad option: --port`) and the three
  // runtimes put operands at different argv offsets.
  it('sets exactly the three names config.ts already reads', () => {
    const env = anthropicProxyHostEnvironment(
      { host: '127.0.0.1', port: 8081, upstreamPort: 8080 },
      {},
    );
    expect(env['ASHLR_LOCAL_RUNTIME_HOST']).toBe('127.0.0.1');
    expect(env['ASHLR_LOCAL_RUNTIME_ANTHROPIC_PORT']).toBe('8081');
    expect(env['ASHLR_LOCAL_RUNTIME_PORT']).toBe('8080');
  });

  it('leaves unspecified fields to config resolution', () => {
    expect(anthropicProxyHostEnvironment({}, {})).toEqual({});
  });

  it('inherits the base environment', () => {
    const env = anthropicProxyHostEnvironment({ port: 9 }, { EXISTING: 'kept' });
    expect(env['EXISTING']).toBe('kept');
  });

  it('carries the environment on the full invocation', () => {
    const invocation = anthropicProxyHostInvocation(
      { port: 8081 },
      'file:///opt/app/dist/core/local-runtime/llama/proxy-invocation.js',
    );
    expect(invocation.command).toBe(process.execPath);
    expect(invocation.env['ASHLR_LOCAL_RUNTIME_ANTHROPIC_PORT']).toBe('8081');
  });
});

const SPEC: AnthropicProxyAgentSpec = {
  command: '/usr/bin/node',
  args: ['/opt/app/dist/core/local-runtime/llama/anthropic-proxy-process.js'],
  host: '127.0.0.1',
  port: 8081,
  upstreamPort: 8080,
  workingDirectory: '/Users/someone',
  stdoutLog: '/Users/someone/.ashlr/logs/anthropic-proxy.out.log',
  stderrLog: '/Users/someone/.ashlr/logs/anthropic-proxy.err.log',
};

describe('the proxy launch agent files', () => {
  it('exports the environment the host resolves from and execs the argv', () => {
    const shim = buildAnthropicProxyShim(SPEC);
    expect(shim).toContain("ASHLR_LOCAL_RUNTIME_ANTHROPIC_PORT='8081'");
    expect(shim).toContain("ASHLR_LOCAL_RUNTIME_PORT='8080'");
    expect(shim).toContain("ASHLR_LOCAL_RUNTIME_HOST='127.0.0.1'");
    expect(shim).toContain('export ASHLR_LOCAL_RUNTIME_HOST');
    // `exec` so launchd supervises the host's own pid, not a shell wrapper.
    expect(shim).toContain(
      "exec '/usr/bin/node' '/opt/app/dist/core/local-runtime/llama/anthropic-proxy-process.js'",
    );
  });

  it('single-quotes every interpolated value', () => {
    const shim = buildAnthropicProxyShim({
      ...SPEC,
      command: "/opt/we're/node",
      args: ['--eval', 'import "x"; $(touch /tmp/pwned)'],
    });
    // The embedded quote is closed, escaped and reopened; the command
    // substitution never becomes shell syntax.
    expect(shim).toContain("'/opt/we'\\''re/node'");
    // The whole argument is ONE single-quoted word, so the command
    // substitution is inert text rather than shell syntax.
    expect(shim).toContain(`'import "x"; $(touch /tmp/pwned)'`);
  });

  it('is a KeepAlive background job under its own label', () => {
    const plist = buildAnthropicProxyPlist(SPEC, '/Users/someone/.ashlr/local-runtime/p.sh');
    expect(plist).toContain('<string>ai.ashlr.anthropic-proxy</string>');
    expect(plist).toContain('<key>KeepAlive</key>\n    <true/>');
    expect(plist).toContain('<key>RunAtLoad</key>\n    <true/>');
    expect(plist).toContain('<string>Background</string>');
    // launchd runs the shim, never the resolved argv directly.
    expect(plist).toContain('<string>/bin/sh</string>');
    expect(plist).toContain('<string>/Users/someone/.ashlr/local-runtime/p.sh</string>');
  });

  it('escapes XML in paths', () => {
    const plist = buildAnthropicProxyPlist({ ...SPEC, workingDirectory: '/a&b/<c>' });
    expect(plist).toContain('/a&amp;b/&lt;c&gt;');
  });
});

describe('startAnthropicProxyHost', () => {
  it('binds the port the environment names and forwards to the upstream port', async () => {
    // A port high enough not to collide with a real runtime on this machine.
    const port = 28_411;
    const saved = {
      proxy: process.env['ASHLR_LOCAL_RUNTIME_ANTHROPIC_PORT'],
      upstream: process.env['ASHLR_LOCAL_RUNTIME_PORT'],
      host: process.env['ASHLR_LOCAL_RUNTIME_HOST'],
    };
    process.env['ASHLR_LOCAL_RUNTIME_ANTHROPIC_PORT'] = String(port);
    process.env['ASHLR_LOCAL_RUNTIME_PORT'] = '28412';
    process.env['ASHLR_LOCAL_RUNTIME_HOST'] = '127.0.0.1';
    try {
      const handle = await startAnthropicProxyHost();
      try {
        expect(handle.port).toBe(port);
        expect(handle.host).toBe('127.0.0.1');
        expect(handle.upstreamOrigin).toBe('http://127.0.0.1:28412');
        expect(handle.baseUrl).toBe(`http://127.0.0.1:${port}/v1`);
      } finally {
        await handle.close();
      }
    } finally {
      for (const [key, value] of [
        ['ASHLR_LOCAL_RUNTIME_ANTHROPIC_PORT', saved.proxy],
        ['ASHLR_LOCAL_RUNTIME_PORT', saved.upstream],
        ['ASHLR_LOCAL_RUNTIME_HOST', saved.host],
      ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
