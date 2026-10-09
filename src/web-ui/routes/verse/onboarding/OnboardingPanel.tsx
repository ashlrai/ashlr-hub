/**
 * routes/verse/onboarding/OnboardingPanel.tsx — the Settings row that brings
 * the first-run tour back.
 *
 * It lives here rather than in sections/ so the whole onboarding feature is
 * one folder; SettingsSection.tsx imports it the same way it imports its own
 * panels, and reuses the same Panel/SettingRow primitives so the row keeps
 * the label-left / control-right rhythm of every other setting.
 *
 * The description states what the tour actually covers, and — because this
 * is the only place the stored answer is visible — whether it has been seen.
 */
import { Button } from '../../../components/primitives/index.js';
import { Panel, SettingRow } from '../sections/SettingRow.js';
import { relativePhrase } from '../context/context-model.js';
import { replayOnboarding } from './onboarding-store.js';
import { useOnboarding } from './useOnboarding.js';
import styles from './onboarding.module.css';

/**
 * What the stored answer says, in the app's one relative wording ("5m ago",
 * "on Sep 19") rather than a locale-numeric "9/19/2026". `now` is injectable
 * so the phrase is testable against a fixed clock.
 */
export function describeOnboardingState(completedAt: string | null, dismissedAt: string | null, now: number = Date.now()): string {
  if (completedAt) {
    const when = relativePhrase(completedAt, now);
    return when ? `Last completed ${when}.` : 'Completed.';
  }
  if (dismissedAt) return 'Skipped. Nothing was missed — it is all reachable from the sections themselves.';
  return 'Not seen yet. Replay it to take the two-minute tour.';
}

export function OnboardingPanel() {
  const { completedAt, dismissedAt, open } = useOnboarding();

  return (
    <Panel title="Onboarding">
      <SettingRow
        label="Replay the first-run tour"
        description={`Your connected seats, whether a local runtime is available, how autonomy is turned on, and what each of the three stop controls really halts. ${describeOnboardingState(completedAt, dismissedAt)}`}
      >
        <Button variant="subtle" size="sm" onClick={replayOnboarding} disabled={open}>
          {open ? 'Showing' : 'Replay'}
        </Button>
      </SettingRow>
      <details className={styles.guide}>
        <summary>How Phantom works</summary>
        <dl>
          <dt>Connect your resources</dt>
          <dd>
            Bring supported Claude Code, Codex, Grok and Devin accounts, configured API providers and local models into one
            workbench. Each account has separate usage readings when reported; subscription allowance and credits are separate.
          </dd>
          <dt>Work with me</dt>
          <dd>
            Talk, ask questions and guide a chat. Choose a resource yourself, or let Automatic choose an eligible account
            and model for the task.
          </dd>
          <dt>Work for me</dt>
          <dd>
            Describe an outcome and manage the fleet. The Leader helps plan priorities and briefs you; independent ready
            tasks can run in parallel once the fleet is enabled.
          </dd>
          <dt>Route and coordinate work</dt>
          <dd>
            Routing matches work to eligible resources and available capacity. Jev can advise task classification when
            configured. Choose Manager for planning, delegation and review across connected resources.
          </dd>
          <dt>See what happened</dt>
          <dd>
            Inspect reported actions, tools, sources and context use in chats; follow tasks, proposals and verification in
            Fleet. Usage and speed are shown when reported, with estimates and missing readings identified.
          </dd>
          <dt>Add tools and companions</dt>
          <dd>
            Connect MCP servers and CLIs. Phantom Secrets manages credentials, and configured Locus checks account and
            session readiness; protection depends on the setup and execution path. Meta Model API offers Muse Spark as
            an opt-in API resource. The personal Muse agent, Dots and Grok Bot are separate products, not connected
            execution resources here.
          </dd>
        </dl>
        <p>Connections, model capabilities and current permissions determine which resources can run each task.</p>
        <a
          href="https://github.com/ashlrai/phantom/blob/master/docs/AUTOMATIC-OUTCOMES.md"
          target="_blank"
          rel="noreferrer noopener"
        >
          Read the work modes guide
        </a>
      </details>
    </Panel>
  );
}
