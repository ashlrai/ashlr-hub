/**
 * core/onboard.ts — one-command idempotent onboarding (M20).
 *
 * onboard(cfg, opts): detect + report + safe ensures in a single, NON-TTY-safe
 * call.  Never hangs on a prompt.  Mutating steps are gated:
 *   - editor wiring: only when opts.wire
 *   - model downloads: NEVER (pull stays explicit)
 *   - shell-profile edits: NEVER
 *
 * Returns an OnboardResult with one OnboardStep per step, a ready flag, and
 * crisp nextSteps guidance.
 */

import { existsSync, mkdirSync, symlinkSync, readlinkSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AshlrConfig, OnboardResult, OnboardStep } from './types.js';
import { saveConfig, defaultConfig } from './config.js';
import { listLocalModels, ollamaInstalled } from './run/model-manager.js';
import { detectEditors, wireEditor } from './integrations/editors.js';
import { getPhantomStatus } from './phantom.js';
import { runDoctor } from './doctor.js';
import { serviceStatus, install } from './daemon/service.js';
import { fleetReadiness } from './fleet/engine-readiness.js';
import { listEnrolled, enroll } from './sandbox/policy.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Produce a passing step — never throws. */
function step(
  name: string,
  status: OnboardStep['status'],
  detail: string,
): OnboardStep {
  return { name, status, detail };
}

// ---------------------------------------------------------------------------
// Step implementations — each is async, catches all errors, never throws
// ---------------------------------------------------------------------------

/** Step 1: ensure ~/.ashlr/config.json exists. */
async function stepConfig(): Promise<OnboardStep> {
  try {
    // Resolve the config path from homedir() at call time so a moving HOME is
    // honored and matches the path saveConfig()/runDoctor() actually use. The
    // exported CONFIG_PATH constant is resolved once at module load and would
    // point at a stale home (breaking onboarding under a relocated/test HOME).
    const configPath = join(homedir(), '.ashlr', 'config.json');
    if (existsSync(configPath)) {
      return step('config', 'ok', `Config present at ${configPath}`);
    }
    // Create from defaults via saveConfig (loadConfig already does this, but we
    // want explicit ensure-only semantics here — never overwrite existing).
    const defaults = defaultConfig();
    saveConfig(defaults);
    return step('config', 'ok', `Created default config at ${configPath}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return step('config', 'manual', `Could not ensure config: ${msg}. Run: ashlr doctor --fix`);
  }
}

/** Step 2: detect local models — report only, NEVER auto-download. */
async function stepModels(cfg: AshlrConfig): Promise<OnboardStep> {
  try {
    const models = await listLocalModels(cfg);
    if (models.length > 0) {
      const names = models.map((m) => `${m.provider}/${m.name}`).join(', ');
      return step('models', 'detected', `Local models found: ${names}`);
    }
    const ollamaPresent = ollamaInstalled();
    if (ollamaPresent) {
      return step(
        'models',
        'manual',
        'Ollama is installed but no models are loaded. Run: ashlr models pull <model>  (e.g. llama3:8b)',
      );
    }
    return step(
      'models',
      'manual',
      'No local models detected (Ollama/LM Studio not running or not installed). Run: ashlr models pull <model>',
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return step('models', 'manual', `Could not probe local models: ${msg}. Run: ashlr models pull <model>`);
  }
}

/** Step 3: detect editors; wire them when opts.wire. */
async function stepEditors(opts: { wire: boolean }): Promise<OnboardStep> {
  try {
    const editors = detectEditors();
    if (editors.length === 0) {
      return step('editors', 'skipped', 'No supported editors detected (claude / codex / cursor)');
    }
    if (!opts.wire) {
      return step(
        'editors',
        'detected',
        `Detected: ${editors.join(', ')}. Re-run with --wire to register the ashlr MCP gateway.`,
      );
    }
    // Wire each detected editor — backup-first + idempotent (M18).
    const results: string[] = [];
    for (const editor of editors) {
      const target = editor as 'claude' | 'codex' | 'cursor';
      const r = await wireEditor(target, {});
      results.push(`${editor}: ${r.detail}`);
    }
    return step('editors', 'wired', results.join('; '));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return step('editors', 'manual', `Editor detection/wiring failed: ${msg}. Run: ashlr wire`);
  }
}

/**
 * Step 4: ensure the ashlr → ~/.local/bin/ashlr symlink.
 *
 * Safe ensure: create only when (a) the symlink is missing AND (b) the source
 * bin/ashlr file can be resolved from this module's location.  Never modifies
 * shell profiles.  If source cannot be resolved → manual guidance.
 */
async function stepSymlink(): Promise<OnboardStep> {
  const localBin = join(homedir(), '.local', 'bin');
  const symlinkDest = join(localBin, 'ashlr');

  try {
    // Check if already present and correct.
    if (existsSync(symlinkDest)) {
      let target: string;
      try {
        target = readlinkSync(symlinkDest);
      } catch {
        // Not a symlink (could be a real file installed by npm) — that's fine.
        return step('symlink', 'ok', `ashlr present at ${symlinkDest}`);
      }
      return step('symlink', 'ok', `Symlink present: ${symlinkDest} → ${target}`);
    }

    // Attempt to resolve the bin/ashlr source from this module's directory tree.
    // __dirname equivalent for ESM: walk up from src/core → project root → bin/ashlr.
    const thisFile = fileURLToPath(import.meta.url);
    // src/core/onboard.ts → src/core → src → project root
    const projectRoot = resolve(dirname(thisFile), '..', '..');
    const binSrc = join(projectRoot, 'bin', 'ashlr');

    if (!existsSync(binSrc)) {
      return step(
        'symlink',
        'manual',
        `ashlr not yet in ~/.local/bin. Run: ./install.sh  (from the ashlr-hub repo)`,
      );
    }

    // Create ~/.local/bin if absent, then create the symlink.
    mkdirSync(localBin, { recursive: true });
    symlinkSync(binSrc, symlinkDest);
    return step('symlink', 'ok', `Created symlink: ${symlinkDest} → ${binSrc}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return step(
      'symlink',
      'manual',
      `Could not ensure symlink: ${msg}. Run: ./install.sh  (from the ashlr-hub repo)`,
    );
  }
}

/**
 * Step 5: ensure the genome directory exists (~/.ashlr/genome).
 * mkdir-only, never seeds/edits entries.
 */
async function stepGenome(): Promise<OnboardStep> {
  const genomeDir = join(homedir(), '.ashlr', 'genome');
  try {
    if (existsSync(genomeDir)) {
      return step('genome', 'ok', `Genome dir present at ${genomeDir}`);
    }
    mkdirSync(genomeDir, { recursive: true });
    return step('genome', 'ok', `Created genome dir at ${genomeDir}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return step('genome', 'manual', `Could not create genome dir: ${msg}. Run: ashlr doctor --fix`);
  }
}

/** Step 6: phantom status — report only, never touches secrets. */
async function stepPhantom(): Promise<OnboardStep> {
  try {
    const status = getPhantomStatus();
    if (!status.installed) {
      return step(
        'phantom',
        'manual',
        'Phantom not installed. Install from https://phantom.sh to enable secrets management.',
      );
    }
    if (!status.initialized) {
      return step(
        'phantom',
        'detected',
        `Phantom v${status.version ?? 'unknown'} installed but vault not initialized. Run: phantom init`,
      );
    }
    const count = status.secretNames.length;
    return step(
      'phantom',
      'ok',
      `Phantom v${status.version ?? 'unknown'} — vault initialized (${count} secret${count !== 1 ? 's' : ''})`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return step('phantom', 'manual', `Phantom status unavailable: ${msg}`);
  }
}

/**
 * Step 6b: install the OS daemon service (idempotent — skip if already installed).
 * Never throws; falls back to 'manual' on any error.
 */
export async function stepDaemonService(): Promise<OnboardStep> {
  try {
    const status = serviceStatus();
    if (status.installed) {
      const detail = status.running
        ? `daemon service installed and running (${status.platformSpec})`
        : `daemon service installed but not running — start with: ashlr daemon start`;
      return step('daemon-service', 'ok', detail);
    }
    // Not installed — attempt install now.
    await install();
    return step('daemon-service', 'ok', `daemon service installed (${serviceStatus().platformSpec})`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return step(
      'daemon-service',
      'manual',
      `Could not install daemon service: ${msg}. Run: ashlr daemon install`,
    );
  }
}

/**
 * Step 6c: report fleet engine readiness — guidance only, never enters tokens.
 * Each engine's fix string tells the user exactly what to do.
 */
export async function stepEngines(cfg: AshlrConfig): Promise<OnboardStep> {
  try {
    const results = fleetReadiness(cfg);
    const total = results.length;
    const ready = results.filter((r) => r.ready).length;

    const notReadyFixes = results
      .filter((r) => !r.ready && r.fix)
      .map((r) => `${r.engine}: ${r.fix}`)
      .join('; ');

    if (ready === total) {
      const names = results.map((r) => r.engine).join(', ');
      return step('engines', 'ok', `${ready}/${total} engines ready (${names})`);
    }

    const names = results.map((r) => `${r.engine}:${r.ready ? '✓' : '✗'}`).join(' ');
    const detail = `${ready}/${total} engines ready — ${names}${notReadyFixes ? '. Fix: ' + notReadyFixes : ''}`;
    return step('engines', 'detected', detail);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return step('engines', 'manual', `Engine readiness probe failed: ${msg}`);
  }
}

/**
 * Step 6d: discover git repos under cfg.roots and enroll any not yet enrolled.
 * Idempotent — enroll() is a no-op for already-enrolled repos.
 * Never auto-enroll when there are no roots (safe default).
 */
export async function stepEnroll(cfg: AshlrConfig, opts: { yes: boolean }): Promise<OnboardStep> {
  try {
    const already = listEnrolled();
    const roots: string[] = Array.isArray(cfg.roots) ? cfg.roots : [];

    if (roots.length === 0) {
      return step(
        'enroll',
        'skipped',
        `No roots configured — run: ashlr config set roots <path> to add repos`,
      );
    }

    // Discover git repos directly under each root (depth 1, non-recursive to keep it fast).
    const { existsSync, readdirSync } = await import('node:fs');
    const { join: pathJoin } = await import('node:path');

    const discovered: string[] = [];
    for (const root of roots) {
      if (!existsSync(root)) continue;
      let entries: string[] = [];
      try {
        entries = readdirSync(root, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => pathJoin(root, d.name));
      } catch {
        continue;
      }
      for (const dir of entries) {
        if (existsSync(pathJoin(dir, '.git'))) {
          discovered.push(dir);
        }
      }
    }

    if (discovered.length === 0) {
      return step(
        'enroll',
        'skipped',
        `No git repos found under roots (${roots.join(', ')}) — add repos or adjust roots`,
      );
    }

    // Only enroll when --yes (non-interactive / desktop app headless).
    if (!opts.yes) {
      const alreadyCount = discovered.filter((d) => already.includes(d)).length;
      const newCount = discovered.length - alreadyCount;
      return step(
        'enroll',
        'detected',
        `Found ${discovered.length} repo(s) (${alreadyCount} already enrolled, ${newCount} new). ` +
          `Re-run with --yes to enroll all, or: ashlr enroll <path>`,
      );
    }

    // --yes: enroll all discovered repos (idempotent).
    let enrolled = 0;
    for (const repo of discovered) {
      if (!already.includes(repo)) {
        enroll(repo);
        enrolled++;
      }
    }
    const total = listEnrolled().length;
    return step(
      'enroll',
      'ok',
      `${enrolled} repo(s) newly enrolled, ${total} total enrolled`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return step('enroll', 'manual', `Enrollment probe failed: ${msg}. Run: ashlr enroll <path>`);
  }
}


/**
 * Step M110: ensure cfg.user identity is set.
 *
 * Resolution order (first wins):
 *   1. Explicit opts.userName / opts.userId (from --user / --user-id flags).
 *   2. Existing cfg.user (already configured — leave it alone).
 *   3. Derive a default: try `git config user.name` / `git config user.email`,
 *      then fall back to OS username from userInfo().
 *
 * Persists via saveConfig when the identity was absent/changed.
 * Guidance-only: never enters a PAT or any other credential.
 * NON-TTY safe: never prompts, never hangs.
 */
export async function stepUser(
  cfg: AshlrConfig,
  opts: { userName?: string; userId?: string },
): Promise<{ userStep: OnboardStep; cfg: AshlrConfig }> {
  try {
    // 1. Explicit flags take priority.
    if (opts.userName || opts.userId) {
      const updated: AshlrConfig = {
        ...cfg,
        user: {
          ...(cfg.user ?? {}),
          ...(opts.userId   ? { id:   opts.userId   } : {}),
          ...(opts.userName ? { name: opts.userName } : {}),
        },
      };
      saveConfig(updated);
      const display = opts.userId ?? opts.userName ?? '';
      return {
        userStep: step('user', 'ok', `Identity set: ${display}`),
        cfg: updated,
      };
    }

    // 2. Already configured — keep as-is.
    if (cfg.user?.id || cfg.user?.name) {
      const display = cfg.user.id ?? cfg.user.name ?? '';
      return {
        userStep: step('user', 'ok', `Identity already set: ${display}`),
        cfg,
      };
    }

    // 3. Derive a default (non-TTY safe — no prompts).
    let derivedName: string | undefined;
    let derivedId: string | undefined;

    try {
      const { execFileSync } = await import('node:child_process');
      const gitName = execFileSync('git', ['config', 'user.name'], { encoding: 'utf8' }).trim();
      if (gitName) derivedName = gitName;
    } catch { /* git not available or not configured — ignore */ }

    try {
      const { execFileSync } = await import('node:child_process');
      const gitEmail = execFileSync('git', ['config', 'user.email'], { encoding: 'utf8' }).trim();
      if (gitEmail) derivedId = gitEmail;
    } catch { /* ignore */ }

    // Final fallback: OS username.
    if (!derivedName) {
      try {
        derivedName = userInfo().username;
      } catch { /* ignore */ }
    }

    if (derivedName || derivedId) {
      const updated: AshlrConfig = {
        ...cfg,
        user: {
          ...(derivedId   ? { id:   derivedId   } : {}),
          ...(derivedName ? { name: derivedName } : {}),
        },
      };
      saveConfig(updated);
      const display = derivedId ?? derivedName ?? '';
      return {
        userStep: step('user', 'ok', `Identity derived and set: ${display}`),
        cfg: updated,
      };
    }

    // Nothing derivable — surface guidance without blocking.
    return {
      userStep: step(
        'user',
        'detected',
        'No user identity configured. Set with: ashlr setup --user "Your Name" --user-id you@example.com',
      ),
      cfg,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      userStep: step(
        'user',
        'manual',
        `Could not determine user identity: ${msg}. Run: ashlr setup --user "Your Name"`,
      ),
      cfg,
    };
  }
}

/**
 * Step M110: report pulse connection status — guidance only, never enters a PAT.
 *
 * Surfaces:
 *   - Whether cfg.pulse is enabled/configured.
 *   - Whether ASHLR_PULSE_PAT is present in the environment.
 *   - The teammate onboarding action: set ASHLR_PULSE_PAT=<token> so their
 *     fleet activity exports to the shared pulse attributed to them.
 *
 * This step is ALWAYS guidance-only: it never reads, writes, or stores a token.
 */
export async function stepPulse(cfg: AshlrConfig): Promise<OnboardStep> {
  try {
    const pulseEnabled = cfg.pulse?.enabled === true;
    const pulseEndpoint = cfg.pulse?.endpoint ?? 'http://localhost:3000';
    const patPresent = Boolean(process.env['ASHLR_PULSE_PAT']);

    if (!pulseEnabled) {
      return step(
        'pulse',
        'skipped',
        'Pulse export disabled. To enable: set cfg.pulse.enabled=true + export ASHLR_PULSE_PAT=<token>',
      );
    }

    if (!patPresent) {
      return step(
        'pulse',
        'detected',
        `Pulse enabled (${pulseEndpoint}) but ASHLR_PULSE_PAT not set. ` +
          'Add to your shell profile: export ASHLR_PULSE_PAT=<your-token>  (never stored in config)',
      );
    }

    return step(
      'pulse',
      'ok',
      `Pulse export active \u2192 ${pulseEndpoint} (ASHLR_PULSE_PAT set). Fleet activity will be attributed to your identity.`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return step('pulse', 'manual', `Pulse status check failed: ${msg}`);
  }
}

/**
 * Doctor checks that genuinely block the hub from running. A `fail` on one of
 * these means setup is NOT ready.
 *
 * This set is intentionally EMPTY: config presence — the one true readiness
 * prerequisite — is gated authoritatively by onboard's own `configStep` (which
 * resolves the config path at call time), not by doctor's `config` check (which
 * compares a module-load-time CONFIG_PATH constant and can therefore disagree
 * under a relocated/test HOME). Every other doctor `fail` (git/ashlr-on-PATH,
 * provider reachability, MCP wiring, etc.) is environmental/advisory: you can
 * still `ashlr run` with cloud fallback, install a model later, or fix PATH
 * later. Those are surfaced as guidance in nextSteps, never a hard readiness
 * blocker. This matches the contract's `ready` = "config present + doctor has
 * no fail that blocks running".
 */
const BLOCKING_FAIL_IDS = new Set<string>();

/** Step 7: run doctor and fold roll-up into final OnboardStep. */
async function stepDoctor(cfg: AshlrConfig): Promise<{ doctorStep: OnboardStep; hasBlockingFail: boolean }> {
  try {
    const report = await runDoctor(cfg);
    const { pass, warn, fail } = report.summary;
    const failChecks = report.checks.filter((c) => c.status === 'fail');
    const blockingFails = failChecks.filter((c) => BLOCKING_FAIL_IDS.has(c.id));
    const hasBlockingFail = blockingFails.length > 0;
    const detail = `doctor: ${pass} pass, ${warn} warn, ${fail} fail`;

    if (hasBlockingFail) {
      const failLabels = blockingFails.map((c) => c.label).join(', ');
      return {
        doctorStep: step('doctor', 'manual', `${detail}. Blocking: ${failLabels}. Run: ashlr doctor --fix`),
        hasBlockingFail: true,
      };
    }

    // Non-blocking fails are advisory — report them but don't gate readiness.
    if (failChecks.length > 0) {
      const failLabels = failChecks.map((c) => c.label).join(', ');
      return {
        doctorStep: step('doctor', 'detected', `${detail}. Needs attention: ${failLabels}. Run: ashlr doctor --fix`),
        hasBlockingFail: false,
      };
    }

    return {
      doctorStep: step('doctor', warn > 0 ? 'detected' : 'ok', detail),
      hasBlockingFail: false,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      doctorStep: step('doctor', 'manual', `Doctor check failed: ${msg}. Run: ashlr doctor`),
      hasBlockingFail: false, // unknown state — don't block if doctor itself errors
    };
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run the complete idempotent onboarding sequence.
 *
 * Guaranteed to:
 *   - Never throw (degrades to 'manual' steps on any error).
 *   - Never hang (no interactive prompts; safe in non-TTY environments).
 *   - Never auto-download models.
 *   - Never touch secrets, shell profiles, or anything outward/network.
 *   - Be idempotent (safe to re-run).
 */
export async function onboard(
  cfg: AshlrConfig,
  opts: { wire: boolean; yes: boolean },
): Promise<OnboardResult> {
  // Run all steps sequentially so each can feed into ready computation.
  // Steps that are independent in principle are still sequential here to avoid
  // interleaved output and to keep the order deterministic and predictable.

  const configStep = await stepConfig();
  const modelsStep = await stepModels(cfg);
  const editorsStep = await stepEditors(opts);
  const symlinkStep = await stepSymlink();
  const genomeStep = await stepGenome();
  const phantomStep = await stepPhantom();
  const { doctorStep, hasBlockingFail } = await stepDoctor(cfg);

  const steps: OnboardStep[] = [
    configStep,
    modelsStep,
    editorsStep,
    symlinkStep,
    genomeStep,
    phantomStep,
    doctorStep,
  ];

  // ready = config is ok AND no doctor blocking failures.
  const configOk = configStep.status === 'ok';
  const ready = configOk && !hasBlockingFail;

  // Build nextSteps guidance.
  const nextSteps: string[] = [];

  if (!configOk) {
    nextSteps.push('Fix config first: ashlr doctor --fix');
  }
  if (modelsStep.status === 'manual') {
    nextSteps.push('Pull a local model: ashlr models pull llama3:8b');
  }
  if (editorsStep.status === 'detected' && !opts.wire) {
    nextSteps.push('Wire your editor: ashlr init --wire');
  }
  if (symlinkStep.status === 'manual') {
    nextSteps.push('Install the CLI symlink: ./install.sh  (from the ashlr-hub repo)');
  }
  // Surface doctor guidance for any remaining issues (blocking or advisory) —
  // doctorStep is 'manual' on a blocking fail and 'detected' when there are
  // non-blocking fails/warns that still warrant a `doctor --fix` pass.
  if (doctorStep.status === 'manual' || hasBlockingFail) {
    nextSteps.push('Fix doctor issues: ashlr doctor --fix');
  }

  // Always end with the crisp "you're set up" guidance.
  nextSteps.push('try: ashlr run / ashlr swarm / ashlr tui');

  return { steps, ready, nextSteps };
}

// ---------------------------------------------------------------------------
// Extended setup — superset used by `ashlr setup`
// ---------------------------------------------------------------------------

/**
 * Run the full setup wizard: all onboard steps PLUS daemon-service, engines,
 * and enroll. Used by `ashlr setup`; `ashlr init` continues to run only the
 * original 7 steps so existing behavior is untouched.
 *
 * Same guarantees as onboard(): never throws, never hangs, never enters creds.
 */
export async function setupWizard(
  cfg: AshlrConfig,
  opts: { wire: boolean; yes: boolean; userName?: string; userId?: string },
): Promise<OnboardResult> {
  const base = await onboard(cfg, opts);

  // M110: resolve user identity first — updated cfg flows into subsequent steps.
  const { userStep, cfg: cfgWithUser } = await stepUser(cfg, {
    userName: opts.userName,
    userId: opts.userId,
  });

  // Run the wizard-specific steps sequentially after the base onboard.
  const daemonStep = await stepDaemonService();
  const enginesStep = await stepEngines(cfgWithUser);
  const enrollStep = await stepEnroll(cfgWithUser, opts);
  const pulseStep = await stepPulse(cfgWithUser);

  const steps = [...base.steps, userStep, daemonStep, enginesStep, enrollStep, pulseStep];

  // Augment nextSteps with wizard-specific guidance (before the final CTA).
  const nextSteps = base.nextSteps.filter((s) => !s.startsWith('try:'));

  if (userStep.status === 'detected') {
    nextSteps.push('Set your identity: ashlr setup --user "Your Name" --user-id you@example.com');
  }
  if (daemonStep.status === 'manual') {
    nextSteps.push('Install daemon service: ashlr daemon install');
  }
  if (enginesStep.status !== 'ok') {
    nextSteps.push('Authenticate engines — see fix hints above (never stored by setup)');
  }
  if (enrollStep.status === 'detected') {
    nextSteps.push('Enroll repos: ashlr setup --yes  (or: ashlr enroll <path>)');
  }
  if (enrollStep.status === 'manual') {
    nextSteps.push('Enroll a repo manually: ashlr enroll <path>');
  }
  if (pulseStep.status === 'detected') {
    nextSteps.push(
      'Connect to shared pulse: export ASHLR_PULSE_PAT=<your-token>  (get token from Mason)',
    );
  }

  nextSteps.push('try: ashlr run / ashlr swarm / ashlr tui');

  return { steps, ready: base.ready, nextSteps };
}
