/**
 * cli/plugins.ts — `ashlr plugins list|info|enable|disable` + `ashlr x <name>` (M33).
 *
 * Trust posture (CONTRACT-M33 / docs/PLUGINS.md):
 *   - `list` / `info` are DISCOVERY ONLY — they read manifest.json files and
 *     NEVER import plugin code.
 *   - `enable` is the consent gate: shows declared capabilities + a trust
 *     warning, requires interactive confirmation (or --yes), and pins the
 *     entry file's sha256 into ~/.ashlr/config.json (tamper evidence).
 *   - `disable` removes the name from plugins.enabled (pin kept for re-enable).
 *   - `ashlr x <name> [...]` runs an enabled plugin's command through the
 *     wrapped (audited, exit-code-safe) runner.
 *
 * Exit codes: 0 success · 1 runtime error · 2 bad usage.
 */

import { createInterface } from 'node:readline';
import { join, basename } from 'node:path';

import { loadConfig, saveConfig } from '../core/config.js';
import { makeColors, isTty, pad } from './ui.js';

const c = makeColors(isTty());

async function importRegistry() {
  return import('../core/plugins/registry.js');
}

async function importIntegrity() {
  return import('../core/plugins/integrity.js');
}

function printPluginsHelp(): void {
  console.log('');
  console.log(c.bold('  ashlr plugins') + c.dim(' — manage the plugin layer (default-off)'));
  console.log('');
  console.log(`    ${c.cyan('ashlr plugins init <name> [--capability k]')} ${c.dim('scaffold a working plugin skeleton')}`);
  console.log(`    ${c.cyan('ashlr plugins list [--json]')}        ${c.dim('discover plugins (manifests only — runs NO plugin code)')}`);
  console.log(`    ${c.cyan('ashlr plugins info <name>')}          ${c.dim('manifest detail for one plugin')}`);
  console.log(`    ${c.cyan('ashlr plugins enable <name> [--yes]')} ${c.dim('consent gate: confirm + integrity-pin + enable')}`);
  console.log(`    ${c.cyan('ashlr plugins disable <name>')}       ${c.dim('remove from plugins.enabled')}`);
  console.log(`    ${c.cyan('ashlr x <name> [args...]')}           ${c.dim("run an enabled plugin's command")}`);
  console.log('');
  console.log('  ' + c.dim('Plugins live in ~/.ashlr/plugins/<name>/ — see docs/PLUGINS.md for the trust model.'));
  console.log('');
}

/** y/N prompt (TTY only; non-TTY refuses unless --yes). */
function promptConfirm(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    rl.question(`${question} [y/N] `, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

async function cmdPluginsList(jsonMode: boolean): Promise<number> {
  const { discoverPlugins } = await importRegistry();
  const cfg = loadConfig();
  const enabled = new Set(cfg.plugins?.enabled ?? []);
  const found = discoverPlugins();

  if (jsonMode) {
    process.stdout.write(
      JSON.stringify(
        found.map((p) => ({
          dir: p.dir,
          name: p.manifest?.name ?? basename(p.dir),
          ok: p.ok,
          reason: p.reason,
          enabled: p.manifest ? enabled.has(p.manifest.name) : false,
          capabilities: p.manifest?.capabilities ?? [],
          version: p.manifest?.version,
        })),
        null,
        2,
      ) + '\n',
    );
    return 0;
  }

  console.log('');
  console.log(c.bold('  ashlr plugins') + c.dim(`  — ${found.length} discovered (discovery never runs plugin code)`));
  console.log('');
  if (found.length === 0) {
    console.log(c.dim('  none — drop a plugin under ~/.ashlr/plugins/<name>/ (see docs/PLUGINS.md)'));
    console.log('');
    return 0;
  }
  for (const p of found) {
    const name = p.manifest?.name ?? basename(p.dir);
    const state = !p.ok
      ? c.red(`invalid (${p.reason ?? 'bad manifest'})`)
      : enabled.has(name)
        ? c.green('enabled')
        : c.dim('disabled');
    const caps = p.manifest?.capabilities.join(',') ?? '—';
    console.log(`    ${c.cyan(pad(name, 24))}  ${pad(state, 24)}  ${c.dim(`[${caps}] v${p.manifest?.version ?? '?'}`)}`);
  }
  console.log('');
  console.log(c.dim('  enable with: ashlr plugins enable <name>'));
  console.log('');
  return 0;
}

async function cmdPluginsInfo(name: string | undefined, jsonMode: boolean): Promise<number> {
  if (!name) {
    process.stderr.write('error: usage: ashlr plugins info <name>\n');
    return 2;
  }
  const { discoverPlugins } = await importRegistry();
  const found = discoverPlugins().find((p) => p.manifest?.name === name || basename(p.dir) === name);
  if (!found) {
    process.stderr.write(`error: plugin not found under ~/.ashlr/plugins/: ${name}\n`);
    return 1;
  }
  if (jsonMode) {
    process.stdout.write(JSON.stringify(found, null, 2) + '\n');
    return 0;
  }
  const cfg = loadConfig();
  console.log('');
  console.log(c.bold(`  ${name}`) + (found.ok ? '' : c.red('  (invalid manifest)')));
  if (found.manifest) {
    console.log(`    version       ${c.cyan(found.manifest.version)}`);
    console.log(`    apiVersion    ${c.cyan(found.manifest.apiVersion)}`);
    console.log(`    capabilities  ${c.cyan(found.manifest.capabilities.join(', ') || '(none)')}`);
    console.log(`    entry         ${c.dim(join(found.dir, found.manifest.entry))}`);
    if (found.manifest.description) console.log(`    description   ${found.manifest.description}`);
    console.log(`    enabled       ${(cfg.plugins?.enabled ?? []).includes(name) ? c.green('yes') : c.dim('no')}`);
    console.log(`    integrity     ${cfg.plugins?.integrity?.[name] ? c.green('pinned') : c.dim('not pinned')}`);
  } else if (found.reason) {
    console.log(`    ${c.red(found.reason)}`);
  }
  console.log('');
  return 0;
}

async function cmdPluginsEnable(name: string | undefined, yes: boolean, jsonMode: boolean): Promise<number> {
  if (!name) {
    process.stderr.write('error: usage: ashlr plugins enable <name> [--yes]\n');
    return 2;
  }
  const { discoverPlugins } = await importRegistry();
  const { hashEntry } = await importIntegrity();

  const found = discoverPlugins().find((p) => p.manifest?.name === name);
  if (!found?.ok || !found.manifest) {
    process.stderr.write(`error: no valid plugin named "${name}" under ~/.ashlr/plugins/` +
      (found?.reason ? ` (${found.reason})` : '') + '\n');
    return 1;
  }

  // ── The consent gate ──────────────────────────────────────────────────────
  if (!yes) {
    if (!isTty()) {
      process.stderr.write('error: enabling a plugin requires confirmation — re-run with --yes in non-TTY contexts.\n');
      return 1;
    }
    console.log('');
    console.log(c.bold(`  Enable plugin "${name}" v${found.manifest.version}?`));
    console.log(`    capabilities: ${c.cyan(found.manifest.capabilities.join(', ') || '(none)')}`);
    console.log('');
    console.log(c.yellow('  ⚠ An enabled plugin runs IN-PROCESS with the same OS privileges as ashlr.'));
    console.log(c.yellow('    Only enable plugins whose source you have read or whose author you trust.'));
    console.log('');
    const confirmed = await promptConfirm('  Enable?');
    if (!confirmed) {
      console.log(c.dim('  Aborted — plugin remains disabled.'));
      return 0;
    }
  }

  // ── Integrity pin + config write ─────────────────────────────────────────
  const entryPath = join(found.dir, found.manifest.entry);
  const hash = hashEntry(entryPath);
  if (!hash) {
    process.stderr.write(`error: could not hash entry file ${entryPath} — does it exist?\n`);
    return 1;
  }

  const cfg = loadConfig();
  const plugins = cfg.plugins ?? { enabled: [], settings: {}, integrity: {} };
  if (!plugins.enabled.includes(name)) plugins.enabled.push(name);
  plugins.integrity[name] = hash;
  cfg.plugins = plugins;
  saveConfig(cfg);

  if (jsonMode) {
    process.stdout.write(JSON.stringify({ enabled: true, name, integrity: hash }, null, 2) + '\n');
  } else {
    console.log(c.green(`  ✓ enabled ${name}`) + c.dim(` (entry pinned ${hash.slice(0, 18)}…)`));
    console.log('');
  }
  return 0;
}

async function cmdPluginsDisable(name: string | undefined, jsonMode: boolean): Promise<number> {
  if (!name) {
    process.stderr.write('error: usage: ashlr plugins disable <name>\n');
    return 2;
  }
  const cfg = loadConfig();
  const enabled = cfg.plugins?.enabled ?? [];
  if (!enabled.includes(name)) {
    process.stderr.write(`error: plugin "${name}" is not enabled\n`);
    return 1;
  }
  cfg.plugins = {
    enabled: enabled.filter((n) => n !== name),
    settings: cfg.plugins?.settings ?? {},
    integrity: cfg.plugins?.integrity ?? {},
  };
  saveConfig(cfg);
  if (jsonMode) {
    process.stdout.write(JSON.stringify({ enabled: false, name }, null, 2) + '\n');
  } else {
    console.log(c.green(`  ✓ disabled ${name}`));
  }
  return 0;
}

// ---------------------------------------------------------------------------
// plugins init — scaffold a working plugin skeleton
// ---------------------------------------------------------------------------

const INIT_CAPABILITIES = ['scanner', 'template', 'provider', 'command'] as const;
type InitCapability = (typeof INIT_CAPABILITIES)[number];

/** Entry-file skeleton per capability (plain ESM; works without a build step). */
function initEntrySource(name: string, capability: InitCapability): string {
  const header =
    `// ${name} — an ashlr plugin (capability: ${capability}).\n` +
    `// Typed authoring: npm i -D @ashlr/hub, then import { definePlugin } from '@ashlr/hub/plugin'.\n` +
    `// Docs + trust model: docs/PLUGINS.md in the ashlr-hub repo.\n\n`;
  switch (capability) {
    case 'scanner':
      return header + `export default {
  activate(host) {
    host.log('activated');
    return {
      scanners: [{
        id: 'example',
        // Return WorkItem-shaped objects. The hub wraps this: 15s timeout,
        // 100-item cap, value/effort clamped 1..5, score recomputed,
        // title/detail secret-scrubbed, ids namespaced.
        async scan(repo) {
          return [{
            id: 'demo', repo, source: 'plugin',
            title: 'Example finding from ${name}',
            detail: 'Replace scan() with real discovery logic.',
            value: 3, effort: 2, score: 0, tags: [], ts: new Date().toISOString(),
          }];
        },
      }],
    };
  },
};\n`;
    case 'template':
      return header + `export default {
  activate() {
    return {
      templates: [{
        id: 'starter', // exposed as '${name}:starter' in \`ashlr new --list\`
        title: 'Example starter',
        description: 'Scaffolded by the ${name} plugin.',
        files: ({ name: projectName }) => [
          { path: 'README.md', content: '# ' + projectName + '\\n' },
        ],
      }],
    };
  },
};\n`;
    case 'provider':
      return header + `export default {
  activate() {
    return {
      providers: [{
        id: '${name}-model',
        tier: 'local', // 'cloud' providers require --allow-cloud + envKeys presence
        async probe() { return { up: false }; },
        async createClient({ model }) {
          return {
            id: '${name}-model', supportsTools: false,
            async chat(messages) {
              return { text: 'not implemented', toolCalls: [], usage: { tokensIn: 0, tokensOut: 0 } };
            },
          };
        },
      }],
    };
  },
};\n`;
    case 'command':
      return header + `export default {
  activate() {
    return {
      commands: [{
        name: 'hello', // invoked as: ashlr x hello
        description: 'Example command from ${name}',
        async run(args, host) {
          host.log('hello ' + (args[0] ?? 'world'));
          return 0;
        },
      }],
    };
  },
};\n`;
  }
}

async function cmdPluginsInit(args: string[], jsonMode: boolean): Promise<number> {
  const name = args.find((a) => !a.startsWith('--'));
  const capIdx = args.indexOf('--capability');
  const capability = (capIdx !== -1 ? args[capIdx + 1] : 'scanner') as InitCapability;

  if (!name) {
    process.stderr.write('error: usage: ashlr plugins init <name> [--capability scanner|template|provider|command]\n');
    return 2;
  }
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(name)) {
    process.stderr.write(`error: plugin name must match ^[a-z][a-z0-9-]{0,39}$ — got "${name}"\n`);
    return 2;
  }
  if (!INIT_CAPABILITIES.includes(capability)) {
    process.stderr.write(`error: --capability must be one of: ${INIT_CAPABILITIES.join(', ')}\n`);
    return 2;
  }

  const { homedir } = await import('node:os');
  const { mkdirSync, writeFileSync, existsSync } = await import('node:fs');
  const dir = join(homedir(), '.ashlr', 'plugins', name);
  if (existsSync(join(dir, 'manifest.json'))) {
    process.stderr.write(`error: ${dir} already has a manifest.json — refusing to overwrite\n`);
    return 1;
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify(
      {
        name,
        version: '0.1.0',
        apiVersion: '^1.0.0',
        description: `An ashlr ${capability} plugin.`,
        entry: './index.mjs',
        capabilities: [capability],
      },
      null,
      2,
    ) + '\n',
  );
  writeFileSync(join(dir, 'index.mjs'), initEntrySource(name, capability));

  if (jsonMode) {
    process.stdout.write(JSON.stringify({ created: true, name, capability, dir }, null, 2) + '\n');
  } else {
    console.log('');
    console.log(c.green(`  ✓ scaffolded ${name}`) + c.dim(` (${capability}) at ${dir}`));
    console.log('');
    console.log('  Next steps:');
    console.log(`    1. Edit ${c.cyan(join(dir, 'index.mjs'))}`);
    console.log(`    2. ${c.cyan(`ashlr plugins enable ${name}`)}   ${c.dim('(confirm + integrity pin)')}`);
    if (capability === 'scanner') console.log(`    3. ${c.cyan('ashlr backlog refresh')}        ${c.dim('items appear tagged [plugin]')}`);
    if (capability === 'command') console.log(`    3. ${c.cyan('ashlr x hello')}`);
    if (capability === 'template') console.log(`    3. ${c.cyan('ashlr new --list')}             ${c.dim(`shows ${name}:starter`)}`);
    console.log('');
  }
  return 0;
}

export async function cmdPlugins(args: string[]): Promise<number> {
  const sub = args[0];
  const jsonMode = args.includes('--json');
  const yes = args.includes('--yes');

  if (!sub || sub === '--help' || sub === '-h' || sub === 'help') {
    printPluginsHelp();
    return 0;
  }
  if (sub === 'list') return cmdPluginsList(jsonMode);
  if (sub === 'info') return cmdPluginsInfo(args[1], jsonMode);
  if (sub === 'init') return cmdPluginsInit(args.slice(1), jsonMode);
  if (sub === 'enable') return cmdPluginsEnable(args[1], yes, jsonMode);
  if (sub === 'disable') return cmdPluginsDisable(args[1], jsonMode);

  process.stderr.write(`error: unknown plugins subcommand: ${sub}\n`);
  printPluginsHelp();
  return 2;
}

/**
 * `ashlr x <name> [args...]` — run an enabled plugin's command (wrapped:
 * audited invocation + exit code; builtin shadowing rejected at load).
 */
export async function cmdX(args: string[]): Promise<number> {
  const name = args[0];
  if (!name || name === '--help' || name === '-h' || name === 'help') {
    console.log('');
    console.log(c.bold('  ashlr x') + c.dim(" — run an enabled plugin's command"));
    console.log(`    ${c.cyan('ashlr x <name> [args...]')}`);
    console.log('  ' + c.dim('Available commands come from enabled plugins — see `ashlr plugins list`.'));
    console.log('');
    return name ? 0 : 2;
  }

  const { loadEnabledPlugins } = await importRegistry();
  const { buildHostApi } = await import('../core/plugins/host-api.js');
  const { wrapCommand } = await import('../core/plugins/wrappers.js');
  const cfg = loadConfig();

  for (const p of await loadEnabledPlugins(cfg)) {
    const command = (p.contributions.commands ?? []).find((cmd) => cmd.name === name);
    if (command) {
      // The wrapper audits the invocation + exit code and never throws.
      const host = buildHostApi(p.manifest, cfg);
      return wrapCommand(p.name, command).run(args.slice(1), host);
    }
  }

  process.stderr.write(
    `error: no enabled plugin provides the command "${name}". ` +
    'Run `ashlr plugins list` to see enabled plugins.\n',
  );
  return 1;
}
