/**
 * `ashlr models` — local model management CLI.
 *
 * Subcommands:
 *   (none)           List local models (Ollama + LM Studio) with provider,
 *                    name, size, and active marker.
 *   pull <name>      Confirm then pull a model via `ollama pull` (EXPLICIT
 *                    only — large download; honors --yes to skip prompt).
 *   start            Best-effort start a locally-installed Ollama daemon.
 *
 * Flags (all subcommands):
 *   --json           Emit machine-readable JSON instead of human output.
 *   --yes            Skip interactive confirmation prompts (pull only).
 *
 * Returns process exit code: 0 success, 1 error, 2 bad usage.
 *
 * Guardrails:
 *   - `pull` NEVER runs automatically; only from this explicit path + confirm.
 *   - `start` NEVER auto-runs; only from the explicit `models start` path.
 *   - No secrets in output; no cloud interaction here.
 */

import { createInterface } from 'node:readline';
import type { AshlrConfig, LocalModelInfo } from '../core/types.js';
import { C, pad, makeColors, isTty } from './ui.js';
import { BUILTIN_ENGINE_REGISTRY } from '../core/run/engine-registry.js';
import { probeApiModelEngine } from '../core/providers.js';
import type { ApiModelReadiness } from '../core/providers.js';

const { bold, dim, green, yellow, cyan, gray } = makeColors(isTty());

// ---------------------------------------------------------------------------
// Lazy imports (graceful degradation if model-manager not yet built)
// ---------------------------------------------------------------------------

type ListLocalModelsFn = (cfg: AshlrConfig) => Promise<LocalModelInfo[]>;
type OllamaInstalledFn = () => boolean;
type PullModelFn = (name: string) => Promise<{ ok: boolean; detail: string }>;
type StartOllamaFn = () => Promise<{ ok: boolean; detail: string }>;

let _listLocalModels: ListLocalModelsFn | null | undefined = undefined;
let _ollamaInstalled: OllamaInstalledFn | null | undefined = undefined;
let _pullModel: PullModelFn | null | undefined = undefined;
let _startOllama: StartOllamaFn | null | undefined = undefined;

async function loadModelManager(): Promise<{
  listLocalModels: ListLocalModelsFn;
  ollamaInstalled: OllamaInstalledFn;
  pullModel: PullModelFn;
  startOllama: StartOllamaFn;
} | null> {
  if (_listLocalModels === undefined) {
    try {
      const mod = await import('../core/run/model-manager.js') as {
        listLocalModels: ListLocalModelsFn;
        ollamaInstalled: OllamaInstalledFn;
        pullModel: PullModelFn;
        startOllama: StartOllamaFn;
      };
      _listLocalModels = mod.listLocalModels;
      _ollamaInstalled = mod.ollamaInstalled;
      _pullModel = mod.pullModel;
      _startOllama = mod.startOllama;
    } catch {
      _listLocalModels = null;
      _ollamaInstalled = null;
      _pullModel = null;
      _startOllama = null;
    }
  }
  if (
    _listLocalModels === null ||
    _ollamaInstalled === null ||
    _pullModel === null ||
    _startOllama === null
  ) {
    return null;
  }
  return {
    listLocalModels: _listLocalModels!,
    ollamaInstalled: _ollamaInstalled!,
    pullModel: _pullModel!,
    startOllama: _startOllama!,
  };
}

async function loadConfig(): Promise<AshlrConfig> {
  const mod = await import('../core/config.js') as { loadConfig: () => AshlrConfig };
  return mod.loadConfig();
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

interface ParsedModelsArgs {
  subcommand: 'list' | 'pull' | 'start';
  pullName?: string;
  json: boolean;
  yes: boolean;
  usageError?: string;
}

function parseModelsArgs(args: string[]): ParsedModelsArgs {
  const result: ParsedModelsArgs = {
    subcommand: 'list',
    json: false,
    yes: false,
  };

  // Strip flags first
  const positional: string[] = [];
  let i = 0;
  while (i < args.length) {
    const arg = args[i]!;
    if (arg === '--json') {
      result.json = true;
    } else if (arg === '--yes' || arg === '-y') {
      result.yes = true;
    } else if (arg === '--help' || arg === '-h') {
      // handled upstream via help check
    } else if (arg.startsWith('--')) {
      result.usageError = `unknown flag: ${arg}`;
      return result;
    } else {
      positional.push(arg);
    }
    i++;
  }

  const sub = positional[0];
  if (!sub || sub === 'list') {
    result.subcommand = 'list';
  } else if (sub === 'pull') {
    result.subcommand = 'pull';
    const name = positional[1];
    if (!name) {
      result.usageError = 'pull requires a model name: ashlr models pull <name>';
      return result;
    }
    result.pullName = name;
  } else if (sub === 'start') {
    result.subcommand = 'start';
  } else {
    result.usageError = `unknown subcommand: ${sub}. Use list, pull <name>, or start.`;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Interactive confirmation (readline, non-TTY safe)
// ---------------------------------------------------------------------------

async function confirm(prompt: string): Promise<boolean> {
  // Non-TTY (piped / scripted): default to no to avoid silent large downloads.
  if (!process.stdin.isTTY) return false;

  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes');
    });
  });
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function providerLabel(provider: 'ollama' | 'lmstudio'): string {
  return provider === 'ollama' ? cyan('ollama') : cyan('lmstudio');
}

function activeMarker(active: boolean): string {
  return active ? green('●') : dim('○');
}

// ---------------------------------------------------------------------------
// Subcommand: list
// ---------------------------------------------------------------------------

async function cmdModelsList(
  cfg: AshlrConfig,
  mm: Awaited<ReturnType<typeof loadModelManager>>,
  json: boolean,
): Promise<number> {
  if (!mm) {
    process.stderr.write(
      `${C.red}error:${C.reset} models command requires src/core/run/model-manager.ts (M15 module not yet built).\n`,
    );
    return 1;
  }

  let models: LocalModelInfo[];
  try {
    models = await mm.listLocalModels(cfg);
  } catch (err) {
    process.stderr.write(
      `${C.red}error:${C.reset} failed to list local models: ` +
        (err instanceof Error ? err.message : String(err)) + '\n',
    );
    return 1;
  }

  // Probe api-model engines from the builtin registry (nim, kimi, openai-compat)
  const apiEngines = Object.values(BUILTIN_ENGINE_REGISTRY).filter(
    (e) => e.kind === 'api-model' && e.api,
  );
  const apiReadiness: ApiModelReadiness[] = await Promise.all(
    apiEngines.map((e) => probeApiModelEngine(e.id, e.api!)),
  );

  if (json) {
    process.stdout.write(JSON.stringify({ local: models, apiEngines: apiReadiness }, null, 2) + '\n');
    return 0;
  }

  console.log('');
  console.log(bold('  ashlr models') + gray(' — local models (Ollama + LM Studio) + API engines'));
  console.log('');

  if (models.length === 0) {
    console.log(`  ${dim('No local models found. Is Ollama or LM Studio running?')}`);
    console.log('');
    const installed = mm.ollamaInstalled();
    if (!installed) {
      console.log(`  ${yellow('Tip:')} Ollama is not installed. Visit https://ollama.com to install.`);
    } else {
      console.log(`  ${yellow('Tip:')} Start Ollama with ${bold('ashlr models start')}, then pull a model:`);
      console.log(`         ${cyan('ashlr models pull llama3.2')}`);
    }
    console.log('');
    return 0;
  }

  // Table layout
  const provW  = 10;
  const nameW  = Math.min(50, Math.max(10, ...models.map(m => m.name.length)));
  const sizeW  = 10;

  console.log(
    `  ${bold(pad('', 2))}` +
    `${bold(pad('Provider', provW))}  ` +
    `${bold(pad('Model', nameW))}  ` +
    `${bold(pad('Size', sizeW))}`,
  );
  console.log(
    `  ${'─'.repeat(2)}` +
    `${'─'.repeat(provW)}  ` +
    `${'─'.repeat(nameW)}  ` +
    `${'─'.repeat(sizeW)}`,
  );

  for (const m of models) {
    const marker  = activeMarker(m.active);
    const size    = m.sizeLabel ? gray(pad(m.sizeLabel, sizeW)) : dim(pad('—', sizeW));
    const nameFmt = m.active ? bold(cyan(pad(m.name, nameW))) : pad(m.name, nameW);

    console.log(
      `  ${marker} ` +
      `${pad(providerLabel(m.provider), provW)}  ` +
      `${nameFmt}  ` +
      size,
    );
  }

  console.log('');

  const activeCount = models.filter(m => m.active).length;
  const ollamaCount = models.filter(m => m.provider === 'ollama').length;
  const lmsCount    = models.filter(m => m.provider === 'lmstudio').length;

  const parts: string[] = [];
  if (ollamaCount > 0) parts.push(`${ollamaCount} ollama`);
  if (lmsCount > 0)    parts.push(`${lmsCount} lmstudio`);
  console.log(
    `  ${dim(parts.join(', '))}` +
    (activeCount > 0 ? `  ${dim('·')}  ${green(`${activeCount} active`)}` : ''),
  );
  console.log('');

  console.log(
    `  ${dim('Pull a model:')} ${cyan('ashlr models pull <name>')}  ` +
    `${dim('Start Ollama:')} ${cyan('ashlr models start')}`,
  );
  console.log('');

  // ---------------------------------------------------------------------------
  // API engines section (nim, kimi, openai-compat)
  // ---------------------------------------------------------------------------
  if (apiReadiness.length > 0) {
    console.log(bold('  API engines') + gray(' — OpenAI-compatible cloud backends (opt-in)'));
    console.log('');

    const idW    = Math.max(12, ...apiReadiness.map((r) => r.engineId.length));
    const statusW = 12;
    const modelW = 36;

    console.log(
      `  ${bold(pad('', 2))}` +
      `${bold(pad('Engine', idW))}  ` +
      `${bold(pad('Status', statusW))}  ` +
      `${bold(pad('Default model', modelW))}`,
    );
    console.log(
      `  ${'─'.repeat(2)}` +
      `${'─'.repeat(idW)}  ` +
      `${'─'.repeat(statusW)}  ` +
      `${'─'.repeat(modelW)}`,
    );

    for (const r of apiReadiness) {
      const spec = BUILTIN_ENGINE_REGISTRY[r.engineId];
      const defaultModel = spec?.api?.defaultModel ?? '—';
      let statusStr: string;
      if (!r.keyPresent) {
        statusStr = yellow(pad('no key', statusW));
      } else if (r.reachable) {
        statusStr = green(pad('ready', statusW));
      } else {
        statusStr = yellow(pad('key, unreachable', statusW));
      }
      const marker = r.keyPresent && r.reachable ? green('●') : dim('○');
      console.log(
        `  ${marker} ` +
        `${pad(r.engineId, idW)}  ` +
        `${statusStr}  ` +
        `${dim(pad(defaultModel, modelW))}`,
      );
      if (r.error) {
        console.log(`    ${dim(r.error)}`);
      }
    }

    console.log('');
    console.log(
      `  ${dim('Enable an API engine:')} add its id to ${cyan('foundry.allowedBackends')} in ${cyan('~/.ashlr/config.json')}`,
    );
    console.log(
      `  ${dim('Set key via phantom:')} ${cyan('phantom add NVIDIA_NIM_API_KEY')}`,
    );
    console.log('');
  }

  return 0;
}

// ---------------------------------------------------------------------------
// Subcommand: pull <name>
// ---------------------------------------------------------------------------

async function cmdModelsPull(
  name: string,
  mm: Awaited<ReturnType<typeof loadModelManager>>,
  opts: { json: boolean; yes: boolean },
): Promise<number> {
  if (!mm) {
    process.stderr.write(
      `${C.red}error:${C.reset} models command requires src/core/run/model-manager.ts (M15 module not yet built).\n`,
    );
    return 1;
  }

  if (!mm.ollamaInstalled()) {
    if (opts.json) {
      process.stdout.write(JSON.stringify({ ok: false, detail: 'ollama is not installed' }) + '\n');
    } else {
      console.error(
        `${C.red}error:${C.reset} ollama is not installed. ` +
        `Visit https://ollama.com to install it, then retry.`,
      );
    }
    return 1;
  }

  // Confirm: pulling is potentially a multi-GB download — always require opt-in.
  if (!opts.yes) {
    const ok = await confirm(
      `\n  Pull model ${bold(name)} via ollama?\n` +
      `  ${yellow('Warning:')} This may download several gigabytes.\n\n` +
      `  Continue? [y/N] `,
    );
    if (!ok) {
      if (!opts.json) {
        console.log('');
        console.log(`  ${dim('Pull cancelled.')}`);
        console.log('');
      }
      return 0;
    }
  }

  if (!opts.json) {
    console.log('');
    console.log(`  Pulling ${bold(name)} via ollama…`);
    console.log(`  ${dim('This may take a few minutes depending on model size.')}`);
    console.log('');
  }

  let result: { ok: boolean; detail: string };
  try {
    result = await mm.pullModel(name);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (opts.json) {
      process.stdout.write(JSON.stringify({ ok: false, detail }) + '\n');
    } else {
      console.error(`${C.red}error:${C.reset} pull failed: ${detail}`);
    }
    return 1;
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify(result) + '\n');
    return result.ok ? 0 : 1;
  }

  if (result.ok) {
    console.log(`  ${green('✓')} Pulled ${bold(name)} successfully.`);
    if (result.detail) console.log(`  ${dim(result.detail)}`);
    console.log('');
    console.log(`  ${dim('Run')} ${cyan('ashlr models')} ${dim('to see updated model list.')}`);
  } else {
    console.error(`  ${C.red}error:${C.reset} pull failed: ${result.detail}`);
  }
  console.log('');

  return result.ok ? 0 : 1;
}

// ---------------------------------------------------------------------------
// Subcommand: start
// ---------------------------------------------------------------------------

async function cmdModelsStart(
  mm: Awaited<ReturnType<typeof loadModelManager>>,
  json: boolean,
): Promise<number> {
  if (!mm) {
    process.stderr.write(
      `${C.red}error:${C.reset} models command requires src/core/run/model-manager.ts (M15 module not yet built).\n`,
    );
    return 1;
  }

  if (!mm.ollamaInstalled()) {
    if (json) {
      process.stdout.write(JSON.stringify({ ok: false, detail: 'ollama is not installed' }) + '\n');
    } else {
      console.error(
        `${C.red}error:${C.reset} ollama is not installed. ` +
        `Visit https://ollama.com to install it first.`,
      );
    }
    return 1;
  }

  if (!json) {
    console.log('');
    console.log(`  Starting Ollama… ${dim('(best-effort, local install only)')}`);
  }

  let result: { ok: boolean; detail: string };
  try {
    result = await mm.startOllama();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (json) {
      process.stdout.write(JSON.stringify({ ok: false, detail }) + '\n');
    } else {
      console.error(`\n${C.red}error:${C.reset} failed to start Ollama: ${detail}`);
    }
    return 1;
  }

  if (json) {
    process.stdout.write(JSON.stringify(result) + '\n');
    return result.ok ? 0 : 1;
  }

  if (result.ok) {
    console.log(`  ${green('✓')} Ollama started.`);
    if (result.detail) console.log(`  ${dim(result.detail)}`);
    console.log('');
    console.log(`  ${dim('Run')} ${cyan('ashlr models')} ${dim('to list available models.')}`);
  } else {
    console.log(`  ${yellow('!')} ${result.detail}`);
  }
  console.log('');

  return result.ok ? 0 : 1;
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

function printModelsHelp(): void {
  console.log('');
  console.log(bold('  ashlr models') + dim(' — local model management (Ollama + LM Studio)'));
  console.log('');
  console.log('  ' + bold('Usage:'));
  console.log('');
  console.log(`    ashlr models [subcommand] [flags]`);
  console.log('');
  console.log('  ' + bold('Subcommands:'));
  console.log('');

  const subs: [string, string][] = [
    ['(none) / list',    'List all local models across Ollama and LM Studio.'],
    ['pull <name>',      'Pull a model by name via `ollama pull` (confirms first; large download).'],
    ['start',            'Best-effort start a locally-installed Ollama daemon.'],
  ];
  const subW = Math.max(...subs.map(([s]) => s.length));
  for (const [sub, desc] of subs) {
    console.log(`    ${cyan(pad(sub, subW))}  ${desc}`);
  }

  console.log('');
  console.log('  ' + bold('Flags:'));
  console.log('');

  const opts: [string, string][] = [
    ['--json',    'Emit machine-readable JSON on stdout; no ANSI rendering.'],
    ['--yes',     'Skip the pull confirmation prompt (use in scripts).'],
  ];
  const optW = Math.max(...opts.map(([o]) => o.length));
  for (const [opt, desc] of opts) {
    console.log(`    ${cyan(pad(opt, optW))}  ${desc}`);
  }

  console.log('');
  console.log('  ' + bold('Notes:'));
  console.log('');
  console.log(`    ${dim('• Models are never downloaded automatically — only via explicit `pull`.')}`);
  console.log(`    ${dim('• `start` only starts an already-installed local Ollama; it never installs.')}`);
  console.log(`    ${dim('• Cloud providers are not managed here — configure via ashlr config.')}`);
  console.log('');
  console.log('  ' + bold('Examples:'));
  console.log('');
  console.log(`    ${cyan('ashlr models')}                      ${dim('# list all local models')}`);
  console.log(`    ${cyan('ashlr models --json')}               ${dim('# machine-readable list')}`);
  console.log(`    ${cyan('ashlr models pull llama3.2')}        ${dim('# pull a model (confirms)')}`);
  console.log(`    ${cyan('ashlr models pull llama3.2 --yes')}  ${dim('# pull without prompt (CI)')}`);
  console.log(`    ${cyan('ashlr models start')}                ${dim('# start local Ollama')}`);
  console.log('');
  console.log('  ' + bold('Exit codes:'));
  console.log('');
  console.log(`    ${dim('0  success')}`);
  console.log(`    ${dim('1  error (provider unreachable, pull failed, etc.)')}`);
  console.log(`    ${dim('2  bad usage / unknown subcommand or flag')}`);
  console.log('');
}

// ---------------------------------------------------------------------------
// cmdModels — main entry point
// ---------------------------------------------------------------------------

/**
 * `ashlr models` — local model management.
 * Returns process exit code.
 */
export async function cmdModels(args: string[]): Promise<number> {
  // Help shortcircuit
  if (args[0] === '--help' || args[0] === '-h' || args[0] === 'help') {
    printModelsHelp();
    return 0;
  }

  const parsed = parseModelsArgs(args);

  if (parsed.usageError) {
    process.stderr.write(`${C.red}error:${C.reset} ${parsed.usageError}\n`);
    process.stderr.write(`Run ${C.cyan}ashlr models --help${C.reset} for usage.\n`);
    return 2;
  }

  // Load model-manager (lazy; degrades if M15 core not yet built)
  const mm = await loadModelManager();

  // Load config (needed for list; not needed for start/pull but load once here)
  let cfg: AshlrConfig | null = null;
  if (parsed.subcommand === 'list') {
    try {
      cfg = await loadConfig();
    } catch (err) {
      process.stderr.write(
        `${C.red}error:${C.reset} failed to load config: ` +
          (err instanceof Error ? err.message : String(err)) + '\n',
      );
      return 1;
    }
  }

  switch (parsed.subcommand) {
    case 'list':
      return cmdModelsList(cfg!, mm, parsed.json);

    case 'pull':
      return cmdModelsPull(parsed.pullName!, mm, { json: parsed.json, yes: parsed.yes });

    case 'start':
      return cmdModelsStart(mm, parsed.json);

    default:
      // unreachable; parseModelsArgs covers all cases
      process.stderr.write(`${C.red}error:${C.reset} unknown subcommand\n`);
      return 2;
  }
}
