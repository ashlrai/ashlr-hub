/**
 * routes/verse/onboarding/OnboardingFlow.tsx — the first-run tour.
 *
 * A first-time operator opens Verse to five unlabelled rail icons and no
 * guidance. This is six short steps that answer the questions that actually
 * block someone on day one: which of my accounts can this thing use, is
 * there anything local, how do I turn autonomy on, what do the three stop
 * buttons really do, where do I change how it looks, and how do I start.
 *
 * THREE RULES IT IS BUILT AROUND:
 *
 * 1. It never blocks the app. This is NOT a modal — no backdrop, no focus
 *    trap, no `aria-modal`. It first appears as a one-line chip
 *    ("Getting started 1/6 →") in the corner; only a click opens the card,
 *    and every rail button, shortcut and section behind either stays
 *    clickable. The card's minimise button and Escape fold it back to the
 *    chip without answering it; Skip, or the chip's ×, silences it for good.
 *
 * 2. It never asserts more than it read. Step 2 is C6's shared capacity
 *    strip (no reading is "no reading", never zero); step 3 reads the same
 *    local-models route Usage reads, through the same narrower — an
 *    unanswered probe is "no answer", never a green check (logic in
 *    ./onboarding-model.ts, tested without a DOM); step 4 reads the same
 *    authority entry Command's switch reads.
 *
 * 3. It costs no extra requests on the common path. The chip reads nothing.
 *    Each data step mounts its own query only when the operator reaches it,
 *    and those queries are the Usage / Command sections' own cache entries —
 *    so a first-run user who walks the tour and then opens either finds the
 *    reads already in cache and within the freshness window
 *    (data/hooks.ts DEFAULT_QUERY_FRESH_MS).
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button } from '../../../components/primitives/index.js';
import {
  IconAlert,
  IconCheckCircle,
  IconChat,
  IconChevronDown,
  IconChevronRight,
  IconCopy,
  IconCpu,
  IconInfo,
  IconLock,
  IconSliders,
  IconX,
} from '../../../components/primitives/icons.js';
import { useQuery } from '../../../data/hooks.js';
import { SECTION_ICON } from '../verse-icons.js';
import { RAIL_SECTIONS, requestVerseCommand, setVerseSection } from '../verse-ui-store.js';
import { LiveCapacityStrip } from '../usage/CapacityStrip.js';
import { tidyProse } from '../autonomy/format.js';
import { verseLocalModelsQuery } from '../usage/usage-queries.js';
import { projectLocalModels } from '../usage/usage-contract.js';
import { authorityQuery } from '../command/surface-data.js';
import { grantChip, modeWord, type ChipTone } from '../command/authority-model.js';
import { useSetupChecklist } from '../autonomy/AutonomyOffState.js';
import { nextCommand } from '../autonomy/setup-checklist-model.js';
import { AUTONOMY_SETUP_COMMAND } from '../shell/command-catalog.js';
import { copyAutonomySetupCommand } from '../shell/copy-setup.js';
import { executeCatalogCommand } from '../shell/run-command.js';
import {
  ONBOARDING_STEPS,
  STOP_CONTROLS,
  buildLocalFinding,
  clampStep,
  type FindingTone,
} from './onboarding-model.js';
import {
  collapseOnboarding,
  completeOnboarding,
  dismissOnboarding,
  expandOnboarding,
  setOnboardingStep,
} from './onboarding-store.js';
import { useOnboarding } from './useOnboarding.js';
import styles from './onboarding.module.css';

// The setup checklist is its own chunk (shared with the "Autonomy is off" state).
const SetupChecklist = lazy(() => import('../autonomy/SetupChecklist.js'));

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

function WelcomeStep() {
  return (
    <StepBody>
      <p className={styles.lead}>Verse runs your chats and this machine’s agent fleet from one local server.</p>
      {/*
        The five rail surfaces, in ⌘1–⌘5 order, with the same one-line blurbs
        the palette uses (VERSE_SECTIONS) — one description per surface, not
        a second copy that drifts. Settings, Apps and Usage live in the gear.
      */}
      <ul className={styles.sections}>
        {RAIL_SECTIONS.map((entry, index) => {
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
                <span className={styles.sectionBlurb}>{entry.blurb}</span>
              </span>
            </li>
          );
        })}
      </ul>
      <p className={styles.sectionBlurb}>
        <kbd className={styles.kbd}>⌘K</kbd> runs anything by name · <kbd className={styles.kbd}>⌘J</kbd> is everything
        waiting on you · Settings, Apps &amp; Accounts and Usage are under the gear.
      </p>
    </StepBody>
  );
}

// ---------------------------------------------------------------------------
// Step 2 — seats
// ---------------------------------------------------------------------------

/**
 * Step 2 mounts C6's shared LiveCapacityStrip — the SAME projection Apps &
 * Accounts, Usage, the new-chat dialog and the rail's capacity ring read — so
 * the tour can never describe a seat differently from the rest of the app
 * (3.9 had its own accounts narrower here, which drifted from Usage). A seat
 * that is signed out or out of usage shows the exact command that fixes it,
 * straight from A2's health report; nothing is run from the tour.
 */
function AccountsStep() {
  return (
    <StepBody>
      <LiveCapacityStrip
        density="compact"
        headline
        local="collapse"
        // The step's own heading ("Your seats") names the strip: a second,
        // hidden heading with the same words is noise to a screen reader.
        labelledBy="verse-onboarding-title"
        emptyText="No seats reported yet. Connect an account in Apps & Accounts, or start Ollama for local models."
        renderActions={(row) =>
          row.connection?.fixCommand ? (
            <p className={styles.findingFix}>
              <span className={styles.fixLabel}>Fix</span>
              <code className={styles.code}>{row.connection.fixCommand.join(' ')}</code>
            </p>
          ) : null
        }
      />
      <p className={styles.aside}>
        Every window, reset and reserve lives in Apps &amp; Accounts, under the gear.
      </p>
    </StepBody>
  );
}

// ---------------------------------------------------------------------------
// Step 3 — local runtime
// ---------------------------------------------------------------------------

function LocalStep() {
  const read = useQuery(verseLocalModelsQuery);
  const finding = useMemo(() => {
    // The server's sentence, with any ISO instant in it read as local time.
    const reason = read.data?.reason ?? read.error?.message ?? null;
    return buildLocalFinding({
      snapshot: read.data?.available ? projectLocalModels(read.data.raw) : null,
      loading: read.data === undefined && read.status !== 'error',
      unavailableReason: reason === null ? null : tidyProse(reason),
    });
  }, [read.data, read.status, read.error]);

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
// Step 4 — autonomy
// ---------------------------------------------------------------------------

/** The Command bar's chip tones, in the tour's three (glyph + word, never colour alone). */
function findingTone(tone: ChipTone | undefined): FindingTone {
  if (tone === 'success') return 'ok';
  if (tone === 'warning' || tone === 'danger') return 'attention';
  return 'unknown';
}

/**
 * Reads the SAME authority entry Command's bar reads (surface-data
 * authorityQuery), so "Right now" can never disagree with the switch — and
 * never claims a state it did not read: no answer is "not reported", with
 * the server's own reason.
 *
 * The next step is the one Command's "Autonomy is off" state names, decided
 * the same way (autonomy-off-model): with no grant, the live setup checklist
 * (every step, unfolded) and the command for its next open step while one
 * before the grant is open (or we cannot tell); once only the grant is left,
 * "Approve grant…" — the same ⌘K command, which opens the Touch ID sheet on
 * Command (the only place a grant is drafted). With a grant, the chip decides
 * (re-approve / renew), else Command itself.
 */
function AutonomyStep() {
  const read = useQuery(authorityQuery);
  const [copied, setCopied] = useState<boolean | null>(null);
  const status = read.data?.value ?? null;
  const loading = read.data === undefined && read.status !== 'error';
  const mode = modeWord(status);
  const chip = grantChip(status, Date.now());
  const setup = useSetupChecklist(status?.grant.state === 'none');
  const needsSetup = !status || (status.grant.state === 'none' && setup.readiness !== 'ready');
  const command = nextCommand(setup.report) ?? AUTONOMY_SETUP_COMMAND;
  const fix = (
    <div className={styles.findingFix}>
      <span className={styles.fixLabel}>{command === AUTONOMY_SETUP_COMMAND ? 'Set up' : 'Next'}</span>
      <code className={styles.code}>{command}</code>
      <Button
        variant="subtle"
        size="sm"
        icon={<IconCopy size={13} />}
        onClick={() => {
          void copyAutonomySetupCommand(command).then(setCopied);
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </Button>
    </div>
  );
  const detail = loading
    ? 'Reading the autonomy state…'
    : status
      ? chip.detail
      : (read.data?.reason ?? read.error?.message ?? 'The autonomy state could not be read.');

  return (
    <StepBody>
      <div className={styles.findingHead}>
        <span className={styles.stopName}>Right now</span>
        <ToneMark tone={loading ? 'unknown' : findingTone(mode.tone)} label={loading ? 'checking' : status ? mode.text : 'not reported'} />
      </div>
      <p className={styles.findingDetail}>{detail}</p>
      <p className={styles.lead}>
        The switch on Command <kbd className={styles.kbd}>⌘1</kbd> — Off, Propose, Autonomous — decides what the fleet
        may do on its own. Raising it past your grant asks for Touch ID; lowering it never does.
      </p>
      {needsSetup ? (
        <>
          {setup.report ? (
            <Suspense fallback={fix}>
              <SetupChecklist report={setup.report} action={fix} open />
            </Suspense>
          ) : fix}
          <p className={styles.aside} role={copied === false ? 'alert' : undefined}>
            {copied === false
              ? 'The clipboard is not available here — select the command and copy it by hand.'
              : 'Run it in a terminal. It stops for what only you can do — sudo, Touch ID, GitHub — and --dry-run prints every step first.'}
          </p>
        </>
      ) : chip.action ? (
        <Button variant="subtle" icon={<IconLock size={14} />} onClick={() => executeCatalogCommand('autonomy.grant', { via: 'button' })}>
          {chip.action === 're-approve' ? 'Re-approve grant…' : 'Approve grant…'}
        </Button>
      ) : (
        <Button variant="subtle" icon={<IconLock size={14} />} onClick={() => setVerseSection('command')}>
          Open Command
        </Button>
      )}
      <p className={styles.aside}>
        <kbd className={styles.kbd}>⌘K</kbd> “Autonomy: …” and “Approve grant…” work from any surface.
      </p>
    </StepBody>
  );
}

// ---------------------------------------------------------------------------
// Step 5 — the three stops
// ---------------------------------------------------------------------------

function StopsStep() {
  return (
    <StepBody>
      <p className={styles.lead}>
        Fleet <kbd className={styles.kbd}>⌘2</kbd> has three stop controls. They are not interchangeable, and the
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
// Step 6 — appearance, then go
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

/** In ONBOARDING_STEPS order (the model test pins the ids; the flow test walks them). */
const STEP_COMPONENTS = [WelcomeStep, AccountsStep, LocalStep, AutonomyStep, StopsStep, FinishStep] as const;

// ---------------------------------------------------------------------------
// The chip and the card
// ---------------------------------------------------------------------------

export function OnboardingFlow() {
  const { open, expanded, step } = useOnboarding();
  const index = clampStep(step);
  const meta = ONBOARDING_STEPS[index]!;
  const Step = STEP_COMPONENTS[index]!;
  const last = index === ONBOARDING_STEPS.length - 1;
  const total = ONBOARDING_STEPS.length;

  const dismiss = useCallback(() => dismissOnboarding(), []);
  const cardRef = useRef<HTMLElement>(null);
  const chipRef = useRef<HTMLButtonElement>(null);
  // Focus follows a fold / unfold the operator asked for — never a mount:
  // the chip appearing on first launch must not steal focus from the composer.
  const moveFocus = useRef(false);

  const expand = useCallback(() => {
    moveFocus.current = true;
    expandOnboarding();
  }, []);
  const collapse = useCallback(() => {
    moveFocus.current = true;
    collapseOnboarding();
  }, []);

  useEffect(() => {
    if (!moveFocus.current) return;
    moveFocus.current = false;
    if (expanded) cardRef.current?.focus();
    else chipRef.current?.focus();
  }, [expanded]);

  // Escape folds the card back to the chip — but ONLY when the focus is
  // inside the card.
  //
  // This card is deliberately not a modal (rule 1 above): the operator works
  // behind it, and every Escape they press for something else — closing the
  // command palette, backing out of a seat menu, stopping dictation — used to
  // land here too and permanently dismiss the tour. Scoped to the card, and
  // folding rather than answering, an Escape can never cost the operator the
  // tour; Skip and the chip's × are the only ways to silence it.
  useEffect(() => {
    if (!open || !expanded) return undefined;
    function onKey(event: globalThis.KeyboardEvent) {
      if (event.key !== 'Escape') return;
      const card = cardRef.current;
      if (!card || !(event.target instanceof Node) || !card.contains(event.target)) return;
      event.preventDefault();
      collapse();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, expanded, collapse]);

  if (!open) return null;

  if (!expanded) {
    return (
      <div className={styles.chip} role="region" aria-label="Getting started">
        <button
          ref={chipRef}
          type="button"
          className={styles.chipOpen}
          aria-expanded="false"
          title={`Getting started: ${meta.title}`}
          onClick={expand}
        >
          <span className={styles.chipLabel}>Getting started</span>
          <span className={styles.chipCount}>
            {index + 1}/{total}
          </span>
          <IconChevronRight size={13} aria-hidden="true" focusable="false" />
        </button>
        <button
          type="button"
          className={styles.chipDismiss}
          aria-label="Dismiss getting started"
          title="Dismiss getting started — replay it any time from Settings"
          onClick={dismiss}
        >
          <IconX size={12} aria-hidden="true" focusable="false" />
        </button>
      </div>
    );
  }

  return (
    <aside ref={cardRef} tabIndex={-1} className={styles.card} aria-labelledby="verse-onboarding-title" role="region">
      <header className={styles.head}>
        <div className={styles.headText}>
          <p className={styles.eyebrow}>
            Getting started · {index + 1} of {total}
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
          aria-label="Minimize getting started"
          title="Minimize getting started"
          aria-expanded="true"
          icon={<IconChevronDown size={14} />}
          onClick={collapse}
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
          <Button variant="ghost" size="sm" onClick={dismiss}>
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
