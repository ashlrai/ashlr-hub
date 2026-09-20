/**
 * routes/verse/onboarding/OnboardingFlow.tsx — the first-run tour.
 *
 * A first-time operator opens Verse to five unlabelled rail icons and no
 * guidance. This is five short steps that answer the questions that actually
 * block someone on day one: which of my accounts can this thing use, is
 * there anything local, what do the three stop buttons really do, where do I
 * change how it looks, and how do I start.
 *
 * THREE RULES IT IS BUILT AROUND:
 *
 * 1. It never blocks the app. This is NOT a modal — no backdrop, no focus
 *    trap, no `aria-modal`. It is a docked card over the section area; every
 *    rail button, shortcut and section behind it stays clickable while it is
 *    open. Escape closes it, so does Skip, so does the close button, and any
 *    of those three silences it for good.
 *
 * 2. It never asserts more than it read. Steps 2 and 3 show real state from
 *    the same two routes the Usage section reads, through the same
 *    narrowers, with the same honesty rules — a 404 is "not reported", an
 *    unanswered probe is "no answer", and neither is a green check. All of
 *    that logic is in ./onboarding-model.ts, tested without a DOM.
 *
 * 3. It costs no extra requests on the common path. Each data step mounts
 *    its own query only when the operator reaches it, and those queries are
 *    the Usage section's own cache entries — so a first-run user who walks
 *    the tour and then opens Usage finds both reads already in cache and
 *    within the freshness window (data/hooks.ts DEFAULT_QUERY_FRESH_MS).
 */
import { useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { Button, Tag } from '../../../components/primitives/index.js';
import {
  IconAlert,
  IconCheckCircle,
  IconChat,
  IconCpu,
  IconInfo,
  IconSliders,
  IconX,
} from '../../../components/primitives/icons.js';
import { useQuery } from '../../../data/hooks.js';
import { SECTION_ICON } from '../verse-icons.js';
import { requestVerseCommand, setVerseSection, VERSE_SECTIONS } from '../verse-ui-store.js';
import { verseAccountsQuery, verseLocalModelsQuery } from '../usage/usage-queries.js';
import { projectAccountsSnapshot, projectLocalModels } from '../usage/usage-contract.js';
import {
  ONBOARDING_STEPS,
  STOP_CONTROLS,
  buildAccountsFindings,
  buildLocalFinding,
  clampStep,
  type FindingTone,
} from './onboarding-model.js';
import {
  completeOnboarding,
  dismissOnboarding,
  setOnboardingStep,
} from './onboarding-store.js';
import { useOnboarding } from './useOnboarding.js';
import styles from './onboarding.module.css';

/**
 * Tone is paired with a glyph everywhere it appears, never carried by colour
 * alone (DESIGN-V2 §6).
 */
function ToneMark({ tone, label }: { tone: FindingTone; label: string }) {
  const Glyph = tone === 'ok' ? IconCheckCircle : tone === 'attention' ? IconAlert : IconInfo;
  return (
    <span className={styles.tone} data-tone={tone}>
      <Glyph size={13} aria-hidden="true" focusable="false" />
      <span className={styles.toneLabel}>{label}</span>
    </span>
  );
}

function StepBody({ children }: { children: ReactNode }) {
  return <div className={styles.body}>{children}</div>;
}

// ---------------------------------------------------------------------------
// Step 1 — what the rail is
// ---------------------------------------------------------------------------

const SECTION_BLURB: Record<string, string> = {
  chat: 'Talk to a seat. Sessions are grouped by project and resume where they stopped.',
  autonomy: 'The human-out-of-the-loop cockpit: the loop, its budget, its scope, and what it did while you were away.',
  approvals: 'Everything the loop produced that is waiting on you. Approving a PR proposal pushes a branch.',
  usage: 'Which account you can actually use right now, and what it costs.',
  settings: 'Theme, accent, density, font — and this tour again whenever you want it.',
};

function WelcomeStep() {
  return (
    <StepBody>
      <p className={styles.lead}>
        Verse is the desktop surface over this machine’s agentic fleet. Everything it shows comes from one local
        server — no session, token or artifact leaves this machine.
      </p>
      <ul className={styles.sections}>
        {VERSE_SECTIONS.map((entry, index) => {
          const Icon = SECTION_ICON[entry.id];
          return (
            <li key={entry.id} className={styles.sectionRow}>
              <span className={styles.sectionIcon} aria-hidden="true">
                <Icon />
              </span>
              <span className={styles.sectionText}>
                <span className={styles.sectionName}>
                  {entry.label} <kbd className={styles.kbd}>⌘{index + 1}</kbd>
                </span>
                <span className={styles.sectionBlurb}>{SECTION_BLURB[entry.id]}</span>
              </span>
            </li>
          );
        })}
      </ul>
    </StepBody>
  );
}

// ---------------------------------------------------------------------------
// Step 2 — seats
// ---------------------------------------------------------------------------

function AccountsStep() {
  const read = useQuery(verseAccountsQuery);
  const findings = useMemo(
    () =>
      buildAccountsFindings({
        snapshot: read.data?.available ? projectAccountsSnapshot(read.data.raw) : null,
        loading: read.data === undefined && read.status !== 'error',
        unavailableReason: read.data?.reason ?? read.error?.message ?? null,
      }),
    [read.data, read.status, read.error],
  );

  return (
    <StepBody>
      <p className={styles.lead}>{findings.summary}</p>
      {findings.findings === null ? null : (
        <ul className={styles.findings}>
          {findings.findings.map((finding) => (
            <li key={finding.id} className={styles.finding}>
              <div className={styles.findingHead}>
                <Tag engine={finding.provider}>{finding.label}</Tag>
                <ToneMark tone={finding.tone} label={finding.state} />
              </div>
              <p className={styles.findingDetail}>{finding.detail}</p>
              {finding.fix ? (
                <p className={styles.findingFix}>
                  <span className={styles.fixLabel}>Fix</span>
                  <code className={styles.code}>{finding.fix}</code>
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {findings.caveat ? <p className={styles.caveat}>{findings.caveat}</p> : null}
      <p className={styles.aside}>
        The full per-window picture — resets, credits, limits — lives in Usage{' '}
        <kbd className={styles.kbd}>⌘4</kbd>.
      </p>
    </StepBody>
  );
}

// ---------------------------------------------------------------------------
// Step 3 — local runtime
// ---------------------------------------------------------------------------

function LocalStep() {
  const read = useQuery(verseLocalModelsQuery);
  const finding = useMemo(
    () =>
      buildLocalFinding({
        snapshot: read.data?.available ? projectLocalModels(read.data.raw) : null,
        loading: read.data === undefined && read.status !== 'error',
        unavailableReason: read.data?.reason ?? read.error?.message ?? null,
      }),
    [read.data, read.status, read.error],
  );

  return (
    <StepBody>
      <div className={styles.findingHead}>
        <span className={styles.localIcon} aria-hidden="true">
          <IconCpu size={15} />
        </span>
        <ToneMark tone={finding.tone} label={finding.state} />
      </div>
      <p className={styles.lead}>{finding.summary}</p>
      <p className={styles.findingDetail}>{finding.meaning}</p>
      {finding.fix ? (
        <p className={styles.findingFix}>
          <span className={styles.fixLabel}>Fix</span>
          <span className={styles.fixText}>{finding.fix}</span>
        </p>
      ) : null}
    </StepBody>
  );
}

// ---------------------------------------------------------------------------
// Step 4 — the three stops
// ---------------------------------------------------------------------------

function StopsStep() {
  return (
    <StepBody>
      <p className={styles.lead}>
        Autonomy <kbd className={styles.kbd}>⌘2</kbd> has three stop controls. They are not interchangeable, and the
        difference is the most important thing on this screen.
      </p>
      <ul className={styles.findings}>
        {STOP_CONTROLS.map((control) => (
          <li key={control.name} className={styles.finding}>
            <div className={styles.findingHead}>
              <span className={styles.stopName}>{control.name}</span>
              <ToneMark tone={control.tone} label={control.tone === 'ok' ? 'narrow' : 'global'} />
            </div>
            <p className={styles.findingDetail}>{control.scope}</p>
            <p className={styles.findingDetail}>{control.limit}</p>
            <p className={styles.findingNote}>{control.reversible}</p>
          </li>
        ))}
      </ul>
    </StepBody>
  );
}

// ---------------------------------------------------------------------------
// Step 5 — appearance, then go
// ---------------------------------------------------------------------------

function FinishStep() {
  return (
    <StepBody>
      <p className={styles.lead}>
        Settings <kbd className={styles.kbd}>⌘,</kbd> carries theme, accent hue, density, display font, corner radius
        and reduced motion. Every change applies as you make it — there is no save button.
      </p>
      <Button
        variant="subtle"
        icon={<IconSliders size={14} />}
        onClick={() => setVerseSection('settings')}
      >
        Open Settings
      </Button>
      <p className={styles.aside}>
        You can replay this tour any time from Settings → Onboarding.
      </p>
    </StepBody>
  );
}

const STEP_COMPONENTS = [WelcomeStep, AccountsStep, LocalStep, StopsStep, FinishStep] as const;

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

export function OnboardingFlow() {
  const { open, step } = useOnboarding();
  const index = clampStep(step);
  const meta = ONBOARDING_STEPS[index]!;
  const Step = STEP_COMPONENTS[index]!;
  const last = index === ONBOARDING_STEPS.length - 1;

  const close = useCallback(() => dismissOnboarding(), []);
  const cardRef = useRef<HTMLElement>(null);

  // Escape dismisses the tour — but ONLY when the focus is inside the card.
  //
  // This card is deliberately not a modal (rule 1 above): the operator works
  // behind it, and every Escape they press for something else — closing the
  // command palette, backing out of a seat menu, stopping dictation — used to
  // land here too and permanently dismiss the tour, writing `dismissedAt` with
  // no confirmation and no undo short of Settings → Replay. It also swallowed
  // the default Escape behaviour of whatever they were actually trying to
  // close. Scoped to the card, both problems go away and the shortcut still
  // works where the operator would expect it to.
  useEffect(() => {
    if (!open) return undefined;
    function onKey(event: globalThis.KeyboardEvent) {
      if (event.key !== 'Escape') return;
      const card = cardRef.current;
      if (!card || !(event.target instanceof Node) || !card.contains(event.target)) return;
      event.preventDefault();
      dismissOnboarding();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  if (!open) return null;

  return (
    <aside ref={cardRef} className={styles.card} aria-labelledby="verse-onboarding-title" role="region">
      <header className={styles.head}>
        <div className={styles.headText}>
          <p className={styles.eyebrow}>
            Getting started · {index + 1} of {ONBOARDING_STEPS.length}
          </p>
          <h2 id="verse-onboarding-title" className={styles.title}>
            {meta.title}
          </h2>
          <p className={styles.subtitle}>{meta.subtitle}</p>
        </div>
        <Button
          iconOnly
          variant="ghost"
          size="sm"
          aria-label="Close getting started"
          icon={<IconX size={14} />}
          onClick={close}
        />
      </header>

      <Step />

      <footer className={styles.foot}>
        <ol className={styles.pips} aria-hidden="true">
          {ONBOARDING_STEPS.map((s, i) => (
            <li key={s.id} className={styles.pip} data-state={i === index ? 'current' : i < index ? 'done' : 'todo'} />
          ))}
        </ol>
        <div className={styles.actions}>
          <Button variant="ghost" size="sm" onClick={close}>
            Skip setup
          </Button>
          {index > 0 ? (
            <Button variant="subtle" size="sm" onClick={() => setOnboardingStep(index - 1)}>
              Back
            </Button>
          ) : null}
          {last ? (
            <Button
              variant="primary"
              size="sm"
              icon={<IconChat size={14} />}
              onClick={() => {
                completeOnboarding();
                // Switches to Chat and raises the one-shot ⌘N command the
                // chat section consumes by nonce (verse-ui-store.ts).
                requestVerseCommand('new-chat');
              }}
            >
              Start a first chat
            </Button>
          ) : (
            <Button variant="primary" size="sm" onClick={() => setOnboardingStep(index + 1)}>
              Next
            </Button>
          )}
        </div>
      </footer>
    </aside>
  );
}
