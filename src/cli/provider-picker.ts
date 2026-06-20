/**
 * provider-picker.ts — interactive Local Provider Picker (M-LP3).
 *
 * The "ask the user" UX for setting up a free local model runtime, so
 * `ashlr run`/`swarm` default to local compute instead of falling through
 * providerChain to paid cloud. Invoked by `ashlr models setup` and offered by
 * `ashlr init` when no local model is found.
 *
 * GUARDRAILS:
 *  - Lives in the CLI layer, NOT in core/onboard.ts — onboard() stays pure and
 *    non-interactive. This is the only place that prompts.
 *  - Non-interactive (no TTY) or --yes → DETECT-ONLY: scan + report, never
 *    prompt, never install, never pull. Preserves the current behavior.
 *  - Every install and every pull is confirm-gated: ashlr offers, the user
 *    confirms. The runtime install routes through installProvider({confirm}),
 *    the model pull through the existing explicit pullModel.
 *  - Never throws — degrades to a reported result.
 */

import { createInterface } from 'node:readline';
import type { ProviderSetupResult } from '../core/types.js';
import { makeColors, isTty } from './ui.js';
import {
  PROVIDER_INSTALLERS,
  getInstaller,
  scanExistingProviders,
  installProvider,
  type ProviderInstaller,
} from '../core/run/provider-installer.js';
import { pullModel, startOllama } from '../core/run/model-manager.js';

const { bold, dim, green, yellow, cyan, gray } = makeColors(isTty());

// ---------------------------------------------------------------------------
// TTY + prompt helpers
// ---------------------------------------------------------------------------

/** True only when BOTH stdin and stdout are real terminals. */
function interactive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/** Ask a free-text question; resolves with the trimmed answer. */
function ask(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/** Ask a yes/no question. Defaults to NO on empty input. */
async function confirmYN(question: string): Promise<boolean> {
  const a = (await ask(question)).toLowerCase();
  return a === 'y' || a === 'yes';
}

/**
 * Render a numbered menu and return the chosen 1-based index, or null on
 * cancel (empty / out-of-range). Caller maps index → option.
 */
async function choose(title: string, options: string[]): Promise<number | null> {
  console.log('');
  console.log(`  ${bold(title)}`);
  console.log('');
  options.forEach((opt, i) => {
    console.log(`    ${cyan(String(i + 1))}) ${opt}`);
  });
  console.log('');
  const answer = await ask(`  Choose [1-${options.length}], or Enter to skip: `);
  if (!answer) return null;
  const n = Number.parseInt(answer, 10);
  if (!Number.isInteger(n) || n < 1 || n > options.length) return null;
  return n;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function emit(result: ProviderSetupResult, json: boolean): void {
  if (json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }
  console.log('');
  const glyph = result.changed ? green('✓') : result.action === 'none' ? yellow('!') : dim('•');
  console.log(`  ${glyph} ${result.detail}`);
  console.log('');
}

// ---------------------------------------------------------------------------
// Sub-flows
// ---------------------------------------------------------------------------

/** Offer to pull a recommended model for runtimes that support `ollama pull`. */
async function offerModelPull(
  installer: ProviderInstaller,
  json: boolean,
): Promise<{ pulled?: string; changed: boolean }> {
  // pullModel speaks the Ollama protocol; only offer where that applies.
  if (installer.id !== 'ollama' || installer.recommendedModels.length === 0) {
    return { changed: false };
  }

  const options = [
    ...installer.recommendedModels.map((m, i) =>
      i === 0 ? `${m}  ${dim('(recommended)')}` : m,
    ),
    `${dim('skip')}`,
  ];
  const pick = await choose('Pull a starter model? (downloads now)', options);
  if (pick === null || pick > installer.recommendedModels.length) {
    return { changed: false };
  }

  const model = installer.recommendedModels[pick - 1]!;
  if (!json) {
    console.log('');
    console.log(`  Pulling ${bold(model)} via ollama… ${dim('(this can take a few minutes)')}`);
  }
  const r = await pullModel(model);
  if (!json) {
    console.log(r.ok ? `  ${green('✓')} ${r.detail}` : `  ${yellow('!')} ${r.detail}`);
  }
  return r.ok ? { pulled: model, changed: true } : { changed: false };
}

/**
 * Set up one chosen runtime: detect → (start | install) → offer model.
 * Returns a partial result describing what happened.
 */
async function setupRuntime(
  installer: ProviderInstaller,
  opts: { json: boolean; platform?: NodeJS.Platform },
): Promise<ProviderSetupResult> {
  const det = await installer.detect();

  // Already running → straight to the model step.
  if (det.state === 'running') {
    if (!opts.json) console.log(`  ${green('✓')} ${installer.label} is already running.`);
    const m = await offerModelPull(installer, opts.json);
    return {
      action: m.changed ? 'pulled' : 'detected',
      provider: installer.id,
      ...(m.pulled ? { model: m.pulled } : {}),
      live: [{ id: installer.id, models: det.models }],
      changed: m.changed,
      detail: m.changed
        ? `Pulled ${m.pulled} — ${installer.label} ready.`
        : `${installer.label} is already running.`,
    };
  }

  // Installed but stopped → start it (Ollama) or guide.
  if (det.state === 'installed') {
    if (installer.id === 'ollama') {
      if (!opts.json) console.log(`  ${dim(installer.label)} is installed but not running — starting it…`);
      const s = await startOllama();
      if (!opts.json) console.log(s.ok ? `  ${green('✓')} ${s.detail}` : `  ${yellow('!')} ${s.detail}`);
      if (s.ok) {
        const m = await offerModelPull(installer, opts.json);
        return {
          action: m.changed ? 'pulled' : 'started',
          provider: installer.id,
          ...(m.pulled ? { model: m.pulled } : {}),
          live: [{ id: installer.id, models: [] }],
          changed: true,
          detail: m.changed ? `Started Ollama and pulled ${m.pulled}.` : 'Started Ollama.',
        };
      }
    }
    return {
      action: 'skipped',
      provider: installer.id,
      live: [],
      changed: false,
      detail: `${installer.label} is installed but not running. Start it, then re-run ashlr models setup.`,
    };
  }

  // Absent → confirm-gated install.
  const plan = await installProvider(installer.id, { confirm: false, ...(opts.platform ? { platform: opts.platform } : {}) });
  if (!plan.command) {
    // No automated installer for this OS.
    if (!opts.json) {
      console.log('');
      console.log(`  ${yellow('!')} ${plan.detail}`);
    }
    return {
      action: 'skipped',
      provider: installer.id,
      live: [],
      changed: false,
      detail: plan.detail,
    };
  }

  if (!opts.json) {
    console.log('');
    console.log(`  This will run: ${bold(plan.command)}`);
  }
  const ok = await confirmYN(`  Install ${installer.label} now? ${dim('[y/N] ')}`);
  if (!ok) {
    return {
      action: 'skipped',
      provider: installer.id,
      live: [],
      changed: false,
      detail: `Skipped ${installer.label} install. See ${installer.docsUrl}`,
    };
  }

  if (!opts.json) console.log(`  Installing ${installer.label}…`);
  const res = await installProvider(installer.id, { confirm: true, ...(opts.platform ? { platform: opts.platform } : {}) });
  if (!opts.json) console.log(res.ok ? `  ${green('✓')} ${installer.label} installed.` : `  ${yellow('!')} ${res.detail}`);
  if (!res.ok) {
    return {
      action: 'skipped',
      provider: installer.id,
      live: [],
      changed: false,
      detail: `${installer.label} install failed: ${res.detail}`,
    };
  }

  // Some runtimes need a fresh shell for PATH; try the model step best-effort.
  const m = await offerModelPull(installer, opts.json);
  return {
    action: m.changed ? 'pulled' : 'installed',
    provider: installer.id,
    ...(m.pulled ? { model: m.pulled } : {}),
    live: [],
    changed: true,
    detail: m.changed
      ? `Installed ${installer.label} and pulled ${m.pulled}.`
      : `Installed ${installer.label}. ${gray('Open a new shell so PATH picks it up.')}`,
  };
}

/** Scan-existing path: report what's already live. */
async function scanFlow(json: boolean): Promise<ProviderSetupResult> {
  const live = await scanExistingProviders();
  if (!json) {
    console.log('');
    if (live.length === 0) {
      console.log(`  ${yellow('!')} No live local runtimes found on the standard ports.`);
    } else {
      for (const d of live) {
        const models = d.models.length ? gray(`(${d.models.length} model${d.models.length === 1 ? '' : 's'})`) : dim('(no models)');
        console.log(`  ${green('✓')} ${d.id} ${models}`);
      }
    }
  }
  return {
    action: live.length > 0 ? 'scanned' : 'none',
    live: live.map((d) => ({ id: d.id, models: d.models })),
    changed: false,
    detail: live.length > 0
      ? `Live local runtimes: ${live.map((d) => d.id).join(', ')}`
      : 'No live local runtimes detected.',
  };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Run the Local Provider Picker.
 *
 * Non-interactive (no TTY) or opts.yes → detect-only: scan + report, prompt
 * nothing, change nothing. Interactive → the runtime/model picker. Never
 * throws. Returns the result plus a process exit code (always 0 — setup is
 * advisory; a failed install is reported, not fatal).
 */
export async function runProviderPicker(
  opts: { json: boolean; yes: boolean; platform?: NodeJS.Platform },
): Promise<{ result: ProviderSetupResult; code: number }> {
  // Detect-only mode — preserves current non-interactive behavior.
  if (opts.yes || !interactive()) {
    const result = await scanFlow(opts.json);
    if (result.action === 'none') {
      result.detail += ' Re-run interactively to set one up: ashlr models setup';
    }
    emit(result, opts.json);
    return { result, code: 0 };
  }

  // Interactive — Step 1: pick a runtime.
  if (!opts.json) {
    console.log('');
    console.log(`  ${dim('Local models save you paid compute. ashlr bundles no runtime —')}`);
    console.log(`  ${dim('it speaks the open local protocols, so bring any runtime.')}`);
  }

  const runtimeOptions = [
    ...PROVIDER_INSTALLERS.map((p) => `${bold(p.label)}  ${dim(p.docsUrl)}`),
    `${bold('Scan existing')}  ${dim('I already run one → detect it')}`,
    `${bold('Manual / skip')}  ${dim("show docs, I'll do it myself")}`,
  ];
  const pick = await choose('Pick a local model runtime to set up:', runtimeOptions);

  // Cancel / skip.
  if (pick === null || pick === runtimeOptions.length) {
    const result: ProviderSetupResult = {
      action: 'skipped',
      live: [],
      changed: false,
      detail: 'Skipped local-provider setup. Run `ashlr models setup` any time.',
    };
    if (!opts.json && pick === runtimeOptions.length) {
      console.log('');
      for (const p of PROVIDER_INSTALLERS) {
        console.log(`  ${bold(p.label)}: ${cyan(p.docsUrl)}`);
      }
    }
    emit(result, opts.json);
    return { result, code: 0 };
  }

  // Scan existing.
  if (pick === PROVIDER_INSTALLERS.length + 1) {
    const result = await scanFlow(opts.json);
    emit(result, opts.json);
    return { result, code: 0 };
  }

  // A specific runtime.
  const installer = PROVIDER_INSTALLERS[pick - 1]!;
  const result = await setupRuntime(installer, { json: opts.json });
  emit(result, opts.json);
  return { result, code: 0 };
}

/**
 * Offer the picker from `ashlr init` when interactive and no local model was
 * found. Asks first (opt-in); a "no" leaves everything untouched. Safe to call
 * unconditionally — it returns immediately when not interactive.
 */
export async function offerLocalProviderSetup(): Promise<void> {
  if (!interactive()) return;
  const yes = await confirmYN(`  ${cyan('Set up a local model runtime now?')} ${dim('[y/N] ')}`);
  if (!yes) return;
  await runProviderPicker({ json: false, yes: false });
}

/** Exposed for callers that want the runtime list without running the picker. */
export { getInstaller };
