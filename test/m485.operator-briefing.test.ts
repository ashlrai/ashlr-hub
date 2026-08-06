import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const app = readFileSync(join(root, 'src/core/web/public/app.js'), 'utf8');
const styles = readFileSync(join(root, 'src/core/web/public/styles.css'), 'utf8');

function sourceBetween(start: string, end: string): string {
  const startIndex = app.indexOf(start);
  const endIndex = app.indexOf(end, startIndex);
  expect(startIndex, start).toBeGreaterThanOrEqual(0);
  expect(endIndex, end).toBeGreaterThan(startIndex);
  return app.slice(startIndex, endIndex);
}

describe('M485 exception-first operator briefing', () => {
  it('derives the deck only from existing read-only fleet snapshot evidence', () => {
    const model = sourceBetween(
      'function buildOperatorBriefingModel(snap)',
      'function announceOperatorAttention(model)',
    );

    expect(model).toContain('fleet?.autonomousShipReadiness');
    expect(model).toContain('fleet?.missionBrief');
    expect(model).toContain('fleet?.nextActions');
    expect(model).toContain('operatorActionNeedsHuman');
    expect(model).toContain('operatorProofModel(fleet, snap)');
    expect(model).not.toContain('apiPost(');
    expect(model).not.toContain('fetch(');
    const ownership = sourceBetween(
      'function operatorActionNeedsHuman(action)',
      'function operatorActionRoute(action)',
    );
    expect(ownership).toContain("command?.safety === 'manual'");
    expect(ownership).toContain("command?.safety === 'control-plane'");
    expect(ownership).toContain("command?.safety === 'autonomous-dispatch'");
  });

  it('renders Needs you, Autonomous now, and Last proof before collapsed evidence', () => {
    const briefing = sourceBetween(
      'function renderOperatorBriefing(snap)',
      '// ── Settings modal',
    );
    const dashboard = sourceBetween(
      'function renderFleetDashboard()',
      '// ---------------------------------------------------------------------------\n// Boot',
    );

    expect(briefing).toContain("'Needs you'");
    expect(briefing).toContain("'Autonomous now'");
    expect(briefing).toContain("'Last proof'");
    const proof = sourceBetween(
      'function operatorProofModel(fleet, snap)',
      'function buildOperatorBriefingModel(snap)',
    );
    expect(proof).toContain("'Observed'");
    expect(proof).toContain("'Decided'");
    expect(proof).toContain("'Acted'");
    expect(proof).toContain("'Proved'");
    expect(dashboard.indexOf('renderOperatorBriefing(snap)')).toBeLessThan(
      dashboard.indexOf("cls: 'fd-evidence-disclosure'"),
    );
    expect(dashboard).toContain("'data-state-key': 'fleet-dashboard-evidence'");
    expect(dashboard).not.toMatch(/fd-evidence-disclosure[^\n]*open:/);
  });

  it('labels command copying with safety and never executes next-action commands', () => {
    const action = sourceBetween(
      'function copyOperatorCommand(action, command, button)',
      'function renderOperatorBriefing(snap)',
    );

    expect(action).toContain("command?.safety ?? 'manual'");
    expect(action).toContain('navigator.clipboard.writeText(shell)');
    expect(action).toContain('It was not executed.');
    expect(action).toContain('commands.forEach((command) => commandList.appendChild(renderNextActionCommand(command)))');
    expect(action).toContain('commands.forEach((command, commandIndex) =>');
    expect(action).toContain('operator-action-${action.id ?? index}-command-${commandIndex}-copy');
    expect(action).toContain('Copy ${command?.label ?? safety} · ${safety}');
    expect(action).not.toContain('commands[0]');
    expect(action).not.toContain('apiPost(');
    expect(action).not.toContain('eval(');
    expect(action).not.toContain('new Function');
  });

  it('fails closed when freshness, kill-switch state, or readiness is not authoritative', () => {
    const ownership = sourceBetween(
      'function operatorActionNeedsHuman(action)',
      'function operatorActionRoute(action)',
    );
    const inspection = sourceBetween(
      'function operatorInspectionAction(',
      'function buildOperatorBriefingModel(snap)',
    );
    const modelSource = sourceBetween(
      'function buildOperatorBriefingModel(snap)',
      'function announceOperatorAttention(model)',
    );
    const buildModel = new Function(`
      const fleetKillState = fleet => fleet?.killSwitch?.state ?? 'unknown';
      const fleetSnapshotLearningFresh = snap => snap?.fresh === true;
      const fleetDaemonState = () => 'running';
      const operatorProofModel = () => ({ tone: 'muted', steps: [] });
      ${ownership}
      ${inspection}
      ${modelSource}
      return buildOperatorBriefingModel;
    `)() as (snapshot: unknown) => {
      clearEligible: boolean;
      tone: string;
      directive: string;
      needsYou: Array<{ id: string; priority: string; commands: Array<{ safety: string }> }>;
    };

    const fleet = {
      autonomousShipReadiness: {
        verdict: 'ready',
        confidence: 'high',
        freshness: { overall: 'fresh' },
        primaryAction: null,
        topBlocker: null,
      },
      killSwitch: { state: 'inactive' },
      missionBrief: { directive: 'Continue bounded work', operatingMode: 'autonomous' },
      nextActions: [],
      queue: { activeWork: { itemCount: 0 } },
      daemon: { todaySpentUsd: 0 },
    };

    const clear = buildModel({ fresh: true, fleet });
    expect(clear.clearEligible).toBe(true);
    expect(clear.tone).toBe('clear');
    expect(clear.needsYou).toEqual([]);

    for (const unsafe of [
      { fresh: false, fleet },
      { fresh: true, fleet: { ...fleet, killSwitch: undefined } },
      { fresh: true, fleet: { ...fleet, autonomousShipReadiness: null } },
      {
        fresh: true,
        fleet: {
          ...fleet,
          autonomousShipReadiness: {
            ...fleet.autonomousShipReadiness,
            freshness: { overall: 'unknown' },
          },
        },
      },
      {
        fresh: true,
        fleet: {
          ...fleet,
          nextActions: [{
            id: 'manual-remediation',
            priority: 'high',
            label: 'Manual remediation',
            commands: [{ safety: 'manual' }],
          }],
        },
      },
    ]) {
      const result = buildModel(unsafe);
      expect(result.clearEligible).toBe(false);
      expect(result.needsYou[0]?.id).toBe('inspect-operator-evidence');
      expect(result.needsYou[0]?.commands[0]?.safety).toBe('read-only');
      expect(result.directive).toBe('Inspect fleet state');
    }
    expect(buildModel({ fresh: true, fleet: { ...fleet, killSwitch: undefined } }).tone).toBe('critical');
    expect(buildModel({ fresh: true, fleet: { ...fleet, autonomousShipReadiness: null } }).tone).toBe('critical');
  });

  it('announces only meaningful attention transitions', () => {
    const announce = sourceBetween(
      'function announceOperatorAttention(model)',
      'function copyOperatorCommand',
    );

    expect(announce).toContain('state.operatorAttentionSignature = model.signature');
    expect(announce).toContain('previous === null || previous === model.signature');
    expect(announce).toContain("document.getElementById('operator-attention-live')");
  });
});

describe('M485 polling-safe keyboard continuity', () => {
  it('captures the actual main scroll container, focus key, and disclosures', () => {
    const capture = sourceBetween('function captureMainViewState(main)', 'function restoreMainViewState(main, saved)');
    const restore = sourceBetween('function restoreMainViewState(main, saved)', '// ---------------------------------------------------------------------------\n// Shell');

    expect(capture).toContain('scrollTop: main.scrollTop');
    expect(capture).toContain("active.getAttribute?.('data-focus-key')");
    expect(capture).toContain("details[data-state-key]");
    expect(restore).toContain('main.scrollTop = saved.scrollTop');
    expect(restore).toContain("main.querySelectorAll('[data-focus-key]')");
    expect(restore).toContain('focus({ preventScroll: true })');
  });

  it('restores view state after every Fleet Dashboard replacement', () => {
    const dashboard = sourceBetween(
      'function renderFleetDashboard()',
      '// ---------------------------------------------------------------------------\n// Boot',
    );

    expect(dashboard).toContain('const viewState = captureMainViewState(main)');
    expect(dashboard.match(/restoreMainViewState\(main, viewState\)/g)).toHaveLength(2);
    expect(dashboard).not.toContain('window.scrollY');
    expect(dashboard).not.toContain('window.scrollTo');
  });

  it('rebuilds an accessible runtime shell after clearing static markup', () => {
    const shell = sourceBetween('function renderShell()', 'function getMain()');

    expect(shell).toContain("cls: 'skip-link', href: '#main'");
    expect(shell).toContain("nav.setAttribute('aria-label', 'Primary navigation')");
    expect(shell).toContain("id: 'operator-attention-live'");
    expect(shell).toContain("role: 'status'");
    expect(shell).toContain("const main = el('main', { cls: 'main', id: 'main', tabindex: '-1' })");
    expect(app).toContain("a.setAttribute('aria-current', 'page')");
    expect(app).toContain("a.removeAttribute('aria-current')");
    expect(styles).toMatch(/\.skip-link\s*\{[\s\S]*?transform:\s*translateY\(-160%\);/);
    expect(styles).toContain('.skip-link:focus { transform: translateY(0); }');
  });

  it('traps settings focus, cleans listeners, and restores the opener', () => {
    const settings = sourceBetween('function fdOpenSettings(', '// ── Main render');

    expect(settings).toContain("role: 'dialog'");
    expect(settings).toContain("'aria-modal': 'true'");
    expect(settings).toContain("'aria-labelledby': 'fd-settings-title'");
    expect(settings).toContain("if (e.key !== 'Tab') return");
    expect(settings).toContain("document.removeEventListener('keydown', onKey)");
    expect(settings).toContain('focusTarget.focus({ preventScroll: true })');
  });

  it('keeps the settings dialog reachable on short, zoomed, and mobile viewports', () => {
    expect(styles).toMatch(/\.fd-overlay\s*\{[\s\S]*?overflow-y:\s*auto;/);
    expect(styles).toMatch(/\.fd-overlay\s*\{[\s\S]*?safe-area-inset-top/);
    expect(styles).toMatch(/\.fd-modal\s*\{[\s\S]*?max-height:\s*calc\(100dvh - 24px\);/);
    expect(styles).toMatch(/\.fd-modal\s*\{[\s\S]*?overflow-y:\s*auto;/);
    expect(styles).toMatch(/@media \(max-width: 480px\), \(max-height: 640px\)[\s\S]*?100dvh - 16px/);
  });

  it('keeps the deck responsive and reduced-motion compatible', () => {
    expect(styles).toMatch(/@media \(max-width: 900px\)[\s\S]*?\.fd-operator-deck__grid\s*\{\s*grid-template-columns:\s*1fr;/);
    expect(styles).toMatch(/@media \(max-width: 720px\)[\s\S]*?\.fd-proof-line__steps\s*\{\s*grid-template-columns:\s*1fr;/);
    expect(styles).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?transition-duration:\s*0\.01ms !important;/);
  });
});
