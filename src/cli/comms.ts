/**
 * M137: `ashlr comms` — iMessage bidirectional channel CLI.
 *
 * Subcommands:
 *   status                  Config + pending/outstanding + watermark state.
 *   send-test               Post + send a test 'report' to verify the channel.
 *   cycle                   Run one runCommsCycle (send pending + poll replies).
 *   ask "<text>" -o "a" -o "b"   Post a test question with numbered options.
 *
 * Exit codes: 0 success, 1 error, 2 bad usage.
 *
 * macOS permissions required (show in `status`):
 *   - Automation → Messages  (osascript tell application "Messages")
 *   - Full Disk Access        (read ~/Library/Messages/chat.db)
 */

import { loadConfig } from '../core/config.js';
import { commsEnabled } from '../core/integrations/imessage.js';
import { listRequests, outstanding, postRequest } from '../core/comms/requests.js';
import { runCommsCycle } from '../core/comms/dispatch.js';
import { registerCommsHandlers } from '../core/comms/handlers.js';
import { buildOversightSnapshot } from '../core/fleet/oversight-export.js';
import { runStrategist, loadLatestBriefing } from '../core/vision/strategist.js';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function statePath(): string {
  return join(homedir(), '.ashlr', 'comms', 'state.json');
}

function loadWatermark(): number {
  try {
    if (!existsSync(statePath())) return 0;
    const raw = readFileSync(statePath(), 'utf8');
    const parsed = JSON.parse(raw) as { watermarkMs?: number };
    return typeof parsed.watermarkMs === 'number' ? parsed.watermarkMs : 0;
  } catch {
    return 0;
  }
}

function parseArgs(args: string[]): { sub: string; text: string; options: string[] } {
  const sub = args[0] ?? 'status';
  let text = '';
  const options: string[] = [];
  let i = 1;
  while (i < args.length) {
    const a = args[i]!;
    if ((a === '-o' || a === '--option') && i + 1 < args.length) {
      options.push(args[i + 1]!);
      i += 2;
    } else if (!text && !a.startsWith('-')) {
      text = a;
      i++;
    } else {
      i++;
    }
  }
  return { sub, text, options };
}

// ---------------------------------------------------------------------------
// Subcommand implementations
// ---------------------------------------------------------------------------

async function cmdStatus(): Promise<number> {
  const cfg = await loadConfig();
  const enabled = commsEnabled(cfg);

  console.log('comms channel:');
  console.log(`  enabled:   ${enabled}`);
  console.log(`  handle:    ${cfg.comms?.imessageHandle ?? '(unset)'}`);
  console.log(`  service:   ${cfg.comms?.service ?? 'iMessage'}`);
  console.log(`  platform:  ${process.platform}`);
  console.log('');

  if (!enabled) {
    console.log('Channel disabled. Set cfg.comms.enabled=true and cfg.comms.imessageHandle in ~/.ashlr/config.json.');
    console.log('');
    console.log('macOS permissions needed:');
    console.log('  • System Settings → Privacy & Security → Automation → Terminal → Messages (to send)');
    console.log('  • System Settings → Privacy & Security → Full Disk Access → Terminal (to read chat.db)');
    return 0;
  }

  const pending = listRequests({ status: 'pending' });
  const sent = listRequests({ status: 'sent' });
  const out = outstanding();
  const watermarkMs = loadWatermark();

  console.log(`pending requests:     ${pending.length}`);
  console.log(`outstanding (sent):   ${sent.length}`);
  if (out) {
    console.log(`  awaiting reply: [${out.id.slice(0, 8)}] "${out.text.slice(0, 60)}"`);
  }
  console.log(`watermark:            ${watermarkMs > 0 ? new Date(watermarkMs).toISOString() : '(none)'}`);
  console.log('');
  console.log('macOS permissions needed:');
  console.log('  • Automation → Messages  (send via osascript)');
  console.log('  • Full Disk Access        (read ~/Library/Messages/chat.db)');

  return 0;
}

async function cmdSendTest(): Promise<number> {
  const cfg = await loadConfig();

  if (!commsEnabled(cfg)) {
    console.error('comms disabled — set cfg.comms.enabled=true and cfg.comms.imessageHandle');
    return 1;
  }

  const id = postRequest({
    kind: 'test',
    type: 'report',
    text: `[ashlr test] iMessage channel OK — ${new Date().toISOString()}`,
    options: [],
    meta: { source: 'send-test' },
  });

  console.log(`posted test report: ${id}`);
  const result = await runCommsCycle(cfg);
  console.log(`cycle: sent=${result.sent} resolved=${result.resolved}`);

  if (result.sent > 0) {
    console.log('Test message sent. Check your iMessage on the handle configured in cfg.comms.imessageHandle.');
    return 0;
  } else {
    console.error('Send failed — check macOS Automation permissions for Messages.');
    return 1;
  }
}

async function cmdCycle(): Promise<number> {
  const cfg = await loadConfig();
  // Register M138 resolution handlers before the cycle polls/resolves.
  registerCommsHandlers(cfg);
  const result = await runCommsCycle(cfg);
  console.log(`cycle complete: sent=${result.sent} resolved=${result.resolved}`);
  return 0;
}

// ---------------------------------------------------------------------------
// M138: digest — build oversight snapshot → send SMS-sized summary
// ---------------------------------------------------------------------------

async function cmdDigest(): Promise<number> {
  const cfg = await loadConfig();

  if (!commsEnabled(cfg)) {
    console.error('comms disabled — set cfg.comms.enabled=true and cfg.comms.imessageHandle');
    return 1;
  }

  try {
    const snap = buildOversightSnapshot(cfg);
    const m = snap.scorecard;

    // Build a terse SMS-sized fleet summary — no secrets, no long text.
    const lines: string[] = [];
    lines.push(`Fleet 24h: ${m.proposalsCreated} proposals, ${(m.acceptRate * 100).toFixed(0)}% accept, trivial ${(m.trivialRatio * 100).toFixed(0)}%.`);

    if (snap.goals.active > 0 || snap.goals.done > 0) {
      lines.push(`Goals: ${snap.goals.active} active, ${snap.goals.done} done (${snap.goals.progressPct}% complete).`);
    }

    if (snap.manager) {
      lines.push(`Judge: ${snap.manager.shipped} ship, ${snap.manager.review} review, ${snap.manager.noise} noise.`);
    }

    // Top concern: first manager recommendation, or a derived signal.
    const topConcern = snap.manager?.recommendations?.[0]
      ?? (m.trivialRatio > 0.5 ? 'High trivial ratio — proposal quality may be low.'
        : m.emptyRate > 0.3 ? 'High empty-diff rate — engine may be stalling.'
          : 'Fleet operating normally.');
    lines.push(`Top concern: ${topConcern}`);

    if (snap.vision) {
      lines.push(`Vision progress: ${snap.vision.progressPct}%.`);
    }

    const text = lines.join(' ');

    // Post as a report (no reply needed), then run one cycle to send it.
    const id = postRequest({
      kind: 'fleet-digest',
      type: 'report',
      text,
      options: [],
      meta: { source: 'digest', generatedAt: snap.generatedAt },
    });

    console.log(`posted digest report: ${id}`);
    registerCommsHandlers(cfg);
    const result = await runCommsCycle(cfg);
    console.log(`cycle: sent=${result.sent} resolved=${result.resolved}`);

    if (result.sent > 0) {
      console.log('Digest sent.');
      return 0;
    } else {
      console.error('Send failed — check macOS Automation permissions or outstanding request blocking.');
      return 1;
    }
  } catch (err) {
    console.error('digest failed:', err instanceof Error ? err.message : String(err));
    return 1;
  }
}

// ---------------------------------------------------------------------------
// M138: ask-vision — run strategist → post elon-vision question
// ---------------------------------------------------------------------------

async function cmdAskVision(): Promise<number> {
  const cfg = await loadConfig();

  if (!commsEnabled(cfg)) {
    console.error('comms disabled — set cfg.comms.enabled=true and cfg.comms.imessageHandle');
    return 1;
  }

  try {
    // Use the latest cached briefing if available; otherwise run the strategist.
    let briefing = loadLatestBriefing();
    if (!briefing) {
      console.log('No cached briefing — running strategist (this may take a moment)...');
      briefing = await runStrategist(cfg);
    }

    // Build a terse question text: state + gap + top direction.
    const topDirection = briefing.recommendedDirection[0] ?? 'no specific direction proposed';
    const questionLines: string[] = [
      `State: ${briefing.currentState}`,
      `Gap: ${briefing.gapToVision}`,
      `Top direction: ${topDirection}`,
    ];
    if (briefing.questionsForMason.length > 0) {
      questionLines.push(`Open question: ${briefing.questionsForMason[0]}`);
    }
    const text = questionLines.join(' | ');

    const id = postRequest({
      kind: 'elon-vision',
      type: 'question',
      text,
      options: ['Approve & create goals', 'Hold', 'Show full briefing'],
      meta: {
        source: 'ask-vision',
        briefingGeneratedAt: briefing.generatedAt,
      },
    });

    console.log(`posted vision question: ${id}`);
    registerCommsHandlers(cfg);
    const result = await runCommsCycle(cfg);
    console.log(`cycle: sent=${result.sent} resolved=${result.resolved}`);

    if (result.sent > 0) {
      console.log(`Vision question sent to ${cfg.comms?.imessageHandle}. Reply 1/2/3.`);
      return 0;
    } else {
      console.error('Send failed — check permissions or an existing outstanding question may be blocking.');
      return 1;
    }
  } catch (err) {
    console.error('ask-vision failed:', err instanceof Error ? err.message : String(err));
    return 1;
  }
}

async function cmdAsk(text: string, options: string[]): Promise<number> {
  if (!text) {
    console.error('usage: ashlr comms ask "<text>" -o "option1" -o "option2"');
    return 2;
  }
  if (options.length === 0) {
    console.error('ask requires at least one -o option');
    return 2;
  }

  const cfg = await loadConfig();

  if (!commsEnabled(cfg)) {
    console.error('comms disabled — set cfg.comms.enabled=true and cfg.comms.imessageHandle');
    return 1;
  }

  const id = postRequest({
    kind: 'test-question',
    type: 'question',
    text,
    options,
    meta: { source: 'cli-ask' },
  });

  console.log(`posted question: ${id}`);
  const result = await runCommsCycle(cfg);
  console.log(`cycle: sent=${result.sent} resolved=${result.resolved}`);

  if (result.sent > 0) {
    console.log(`Question sent to ${cfg.comms?.imessageHandle}. Reply with a number to answer.`);
    return 0;
  } else {
    console.error('Send failed — check permissions or an existing outstanding question may be blocking.');
    return 1;
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function cmdComms(args: string[]): Promise<number> {
  const { sub, text, options } = parseArgs(args);

  switch (sub) {
    case 'status':
      return cmdStatus();
    case 'send-test':
      return cmdSendTest();
    case 'cycle':
      return cmdCycle();
    case 'ask':
      return cmdAsk(text, options);
    case 'digest':
      return cmdDigest();
    case 'ask-vision':
      return cmdAskVision();
    case 'ask-merges':
      return cmdAskMerges();
    default:
      console.error(`unknown subcommand: ${sub}`);
      console.error('usage: ashlr comms <status|send-test|cycle|ask|digest|ask-vision|ask-merges>');
      return 2;
  }
}

// ---------------------------------------------------------------------------
// M139: ask-merges — post ship proposals for approval + run comms cycle
// ---------------------------------------------------------------------------

async function cmdAskMerges(): Promise<number> {
  const cfg = await loadConfig();

  if (!commsEnabled(cfg)) {
    console.error('comms disabled — set cfg.comms.enabled=true and cfg.comms.imessageHandle');
    return 1;
  }

  try {
    const { postShipProposalsForApproval } = await import('../core/comms/merge-requests.js');
    const { posted } = await postShipProposalsForApproval(cfg);
    console.log(`ask-merges: posted ${posted} approval request(s)`);

    registerCommsHandlers(cfg);
    const result = await runCommsCycle(cfg);
    console.log(`cycle: sent=${result.sent} resolved=${result.resolved}`);

    return 0;
  } catch (err) {
    console.error('ask-merges failed:', err instanceof Error ? err.message : String(err));
    return 1;
  }
}
