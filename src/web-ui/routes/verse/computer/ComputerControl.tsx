/**
 * routes/verse/computer/ComputerControl.tsx — everything the operator sees of
 * computer use (desktop control by Verse's agents), mounted ONCE by VerseApp
 * and only in a desktop shell that supports it (renders nothing elsewhere).
 *
 *   ACCESS SHEET        an agent asks to control apps: tick which (nothing is
 *                       pre-ticked; denied apps cannot be ticked), Allow / Deny.
 *   CONFIRMATION CARD   an action needs a yes: Allow once / Allow for chat /
 *                       Deny (focused; Esc = Deny).
 *   ONBOARDING SHEET    Screen Recording / Accessibility are missing: status,
 *                       deep links into System Settings, "Ask macOS", re-check.
 *   STATUS PILL         the live control state from native (active / paused /
 *                       killed), the current grants with per-app Revoke, and
 *                       KILL — present whenever any chat holds a grant.
 *
 * Several chats can ask at once, so prompts QUEUE and show one at a time,
 * oldest first; the onboarding sheet waits behind them (prompts have agents
 * blocked on a timeout, the sheet does not).
 *
 * UNTRUSTED TEXT. The agent's reason, app names, control labels and the
 * summary line all came from an agent or off the screen: they render as
 * plain text children (never HTML) and are clamped.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useFocusTrap } from '../../../components/primitives/focus-trap.js';
import {
  sensitiveWordIn,
  type ComputerGrantWire,
  type ComputerPermissionKind,
  type ComputerTier,
  type ConfirmDecision,
  type VerseComputerState,
} from '../../../../core/verse/computer-types.js';
import { getVerseSessionHead } from '../verse-store.js';
import { computerApi, type ComputerApi } from './computer-queries.js';
import { startComputerRunner, type ComputerPrompt, type ComputerRunner } from './computer-runner.js';
import {
  localRequestId,
  nativeComputer,
  parsePermissions,
  UNKNOWN_PERMISSIONS,
  type ComputerPermissions,
  type NativeComputer,
  type NativeComputerStateEvent,
  type PermissionStatus,
} from './native-computer.js';
import styles from './ComputerControl.module.css';

export const KILLED_DISMISS_MS = 6_000;
export const GRANTS_REFRESH_MS = 15_000;
/** A native `killed` this soon after our own KILL is its echo, not a second stop. */
const KILL_ECHO_MS = 3_000;

const REASON_MAX = 600;
const NAME_MAX = 80;
const LINE_MAX = 240;
const SUMMARY_MAX = 300;
const APPS_MAX = 60;

export interface ComputerControlDeps {
  api: ComputerApi;
  native: () => NativeComputer | null;
  /** The chat's title for the sheets, or null to show its id. */
  titleOf: (sessionId: string) => string | null;
  now: () => number;
}

function defaultTitleOf(sessionId: string): string | null {
  try {
    const title = getVerseSessionHead(sessionId).session?.title;
    return typeof title === 'string' && title.trim() ? title : null;
  } catch {
    return null;
  }
}

const DEFAULT_DEPS: ComputerControlDeps = {
  api: computerApi,
  native: () => nativeComputer(),
  titleOf: defaultTitleOf,
  now: () => Date.now(),
};

/** Plain, single-spaced, clamped: for text that came from an agent or the screen. */
export function clampText(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point.
  const flat = value.replace(/[\u0000-\u0008\u000b-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '').replace(/[ \t]+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

export const TIER_LABEL: Record<ComputerTier, string> = { read: 'Read only', click: 'Click only', full: 'Full control' };

function tierLabel(tier: ComputerTier | null): string {
  return tier ? TIER_LABEL[tier] : 'Never available';
}

function errorText(err: unknown): string {
  return err instanceof Error && err.message ? clampText(err.message, LINE_MAX) : 'The request failed.';
}

interface ControlStatus {
  state: NativeComputerStateEvent['state'];
  app: string | null;
}

export function ComputerControl({ deps: overrides }: { deps?: Partial<ComputerControlDeps> } = {}) {
  const deps = useMemo<ComputerControlDeps>(() => ({ ...DEFAULT_DEPS, ...overrides }), [overrides]);
  // Chosen once: the shell's capabilities do not change under a live page.
  const [native] = useState<NativeComputer | null>(() => deps.native());
  if (!native) return null;
  return <ComputerControlLive deps={deps} native={native} />;
}

function ComputerControlLive({ deps, native }: { deps: ComputerControlDeps; native: NativeComputer }) {
  const { api, titleOf, now } = deps;
  const runnerRef = useRef<ComputerRunner | null>(null);
  const lastKillAt = useRef(0);
  const [prompts, setPrompts] = useState<ComputerPrompt[]>([]);
  const [onboarding, setOnboarding] = useState<{ open: boolean; permissions: ComputerPermissions; checking: boolean }>({
    open: false,
    permissions: UNKNOWN_PERMISSIONS,
    checking: false,
  });
  const [control, setControl] = useState<ControlStatus>({ state: 'idle', app: null });
  const [grants, setGrants] = useState<VerseComputerState | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // ── grants ───────────────────────────────────────────────────────────────
  const stateAbort = useRef<AbortController | null>(null);
  const refreshGrants = useCallback(() => {
    stateAbort.current?.abort();
    const controller = new AbortController();
    stateAbort.current = controller;
    api.state(controller.signal).then(
      (next) => {
        if (!controller.signal.aborted) setGrants(next);
      },
      () => undefined,
    );
  }, [api]);
  useEffect(() => {
    refreshGrants();
    return () => stateAbort.current?.abort();
  }, [refreshGrants]);

  const grantCount = useMemo(() => (grants?.chats ?? []).reduce((n, chat) => n + chat.grants.length, 0), [grants]);
  useEffect(() => {
    if (grantCount === 0) return undefined;
    const timer = setInterval(refreshGrants, GRANTS_REFRESH_MS);
    return () => clearInterval(timer);
  }, [grantCount, refreshGrants]);

  // ── permissions ──────────────────────────────────────────────────────────
  const checkPermissions = useCallback(async () => {
    setOnboarding((s) => ({ ...s, checking: true }));
    const answer = await native.request({ op: 'permissions', req: localRequestId() });
    setOnboarding((s) => ({ ...s, checking: false, permissions: answer.ok ? parsePermissions(answer.data) : s.permissions }));
  }, [native]);

  const openOnboarding = useCallback(
    (permissions: ComputerPermissions | null) => {
      setOnboarding((s) => ({ open: true, permissions: permissions ?? s.permissions, checking: s.checking }));
      if (!permissions) void checkPermissions();
    },
    [checkPermissions],
  );

  // ── the relay ────────────────────────────────────────────────────────────
  const openOnboardingRef = useRef(openOnboarding);
  openOnboardingRef.current = openOnboarding;
  const refreshRef = useRef(refreshGrants);
  refreshRef.current = refreshGrants;
  useEffect(() => {
    const runner = startComputerRunner({
      api,
      native,
      onPrompt: (prompt) => setPrompts((queue) => (queue.some((p) => p.id === prompt.id) ? queue : [...queue, prompt])),
      onNeedsPermissions: (permissions) => openOnboardingRef.current(permissions),
      onActivity: () => refreshRef.current(),
    });
    runnerRef.current = runner;
    return () => {
      runner.stop();
      runnerRef.current = null;
    };
  }, [api, native]);

  // ── KILL ─────────────────────────────────────────────────────────────────
  const revokeEverything = useCallback(() => {
    runnerRef.current?.forgetPrompts();
    setPrompts([]);
    api.kill().then(
      (next) => setGrants(next),
      (err) => setNotice(`Grants could not be revoked: ${errorText(err)}`),
    );
  }, [api]);

  const kill = useCallback(() => {
    lastKillAt.current = now();
    native.send({ op: 'kill' });
    revokeEverything();
  }, [native, now, revokeEverything]);

  // ── native control state ─────────────────────────────────────────────────
  useEffect(
    () =>
      native.onState((event) => {
        setControl({ state: event.state, app: event.app ?? null });
        // Esc (or the HUD's own stop) stopped native: revoke the grants too,
        // so the agent cannot simply start again. Our own KILL already did.
        if (event.state === 'killed' && now() - lastKillAt.current > KILL_ECHO_MS) {
          lastKillAt.current = now();
          revokeEverything();
        }
      }),
    [native, now, revokeEverything],
  );
  useEffect(() => {
    if (control.state !== 'killed') return undefined;
    const timer = setTimeout(() => setControl({ state: 'idle', app: null }), KILLED_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [control.state]);

  // ── answers ──────────────────────────────────────────────────────────────
  const dropPrompt = (id: string) => setPrompts((queue) => queue.filter((p) => p.id !== id));
  const answerAccess = (id: string, approved: ComputerGrantWire[] | null) => {
    dropPrompt(id);
    void runnerRef.current?.answerAccess(id, approved).then(refreshGrants);
  };
  const answerConfirm = (id: string, decision: ConfirmDecision) => {
    dropPrompt(id);
    void runnerRef.current?.answerConfirm(id, decision);
  };
  const revoke = (sessionId: string, bundleId: string) => {
    api.revoke(sessionId, bundleId).then(
      (next) => setGrants(next),
      (err) => setNotice(`Could not revoke: ${errorText(err)}`),
    );
  };

  const head = prompts[0] ?? null;
  const chatLabel = (sessionId: string) => clampText(titleOf(sessionId) ?? sessionId, NAME_MAX) || 'an unnamed chat';

  return (
    <>
      <StatusPill
        control={control}
        grants={grants}
        grantCount={grantCount}
        notice={notice}
        chatLabel={chatLabel}
        onKill={kill}
        onResume={() => native.send({ op: 'resume' })}
        onRevoke={revoke}
        onDismissNotice={() => setNotice(null)}
      />
      {head?.kind === 'access' ? (
        <AccessSheet
          key={head.id}
          prompt={head}
          chat={chatLabel(head.sessionId)}
          queued={prompts.length - 1}
          onAnswer={(approved) => answerAccess(head.id, approved)}
        />
      ) : head?.kind === 'confirm' ? (
        <ConfirmCard
          key={head.id}
          prompt={head}
          chat={chatLabel(head.sessionId)}
          queued={prompts.length - 1}
          onAnswer={(decision) => answerConfirm(head.id, decision)}
        />
      ) : onboarding.open ? (
        <OnboardingSheet
          permissions={onboarding.permissions}
          checking={onboarding.checking}
          onOpenSettings={(kind) => native.send({ op: 'open-settings', kind })}
          onAsk={async () => {
            const kinds: ComputerPermissionKind[] = [];
            if (onboarding.permissions.screen !== 'granted') kinds.push('screen');
            if (onboarding.permissions.accessibility !== 'granted') kinds.push('accessibility');
            for (const kind of kinds) await native.request({ op: 'request-permission', req: localRequestId(), kind });
            await checkPermissions();
          }}
          onCheck={() => void checkPermissions()}
          onClose={() => setOnboarding((s) => ({ ...s, open: false }))}
        />
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// Modal frame (focus trap, no backdrop-click dismissal: a stray click must not
// answer an agent's request either way)
// ---------------------------------------------------------------------------

function Sheet({
  titleId,
  title,
  children,
  onEscape,
  initialFocusRef,
  tone,
  describedBy,
}: {
  titleId: string;
  title: ReactNode;
  children: ReactNode;
  onEscape: () => void;
  initialFocusRef?: React.RefObject<HTMLElement | null>;
  tone?: 'warning';
  describedBy?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap({ open: true, containerRef: ref, onClose: onEscape, initialFocusRef });
  return createPortal(
    <div className={styles.backdrop}>
      <div
        ref={ref}
        className={styles.sheet}
        data-tone={tone}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={describedBy}
        tabIndex={-1}
        data-computer-sheet
      >
        <h2 id={titleId} className={styles.title}>
          {title}
        </h2>
        {children}
      </div>
    </div>,
    document.body,
  );
}

function Queued({ count }: { count: number }) {
  if (count <= 0) return null;
  return <p className={styles.queued}>{count === 1 ? '1 more request is waiting.' : `${count} more requests are waiting.`}</p>;
}

// ---------------------------------------------------------------------------
// Access sheet
// ---------------------------------------------------------------------------

export function AccessSheet({
  prompt,
  chat,
  queued,
  onAnswer,
}: {
  prompt: Extract<ComputerPrompt, { kind: 'access' }>;
  chat: string;
  queued: number;
  onAnswer: (approved: ComputerGrantWire[] | null) => void;
}) {
  const titleId = useId();
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const firstRef = useRef<HTMLInputElement>(null);
  const answered = useRef(false);
  const apps = prompt.apps.slice(0, APPS_MAX);
  const firstGrantable = apps.findIndex((app) => app.tier !== null);
  const reason = clampText(prompt.reason, REASON_MAX);

  const answer = (approved: ComputerGrantWire[] | null) => {
    if (answered.current) return;
    answered.current = true;
    onAnswer(approved);
  };
  const deny = () => answer(null);
  const allow = () => {
    const approved: ComputerGrantWire[] = [];
    for (const app of apps) if (app.tier !== null && ticked.has(app.bundleId)) approved.push({ bundleId: app.bundleId, tier: app.tier });
    if (approved.length > 0) answer(approved);
  };
  const toggle = (bundleId: string) =>
    setTicked((prev) => {
      const next = new Set(prev);
      if (next.has(bundleId)) next.delete(bundleId);
      else next.add(bundleId);
      return next;
    });

  return (
    <Sheet titleId={titleId} title="An agent wants to control apps on this Mac" onEscape={deny} initialFocusRef={firstGrantable >= 0 ? firstRef : undefined}>
      <p className={styles.meta}>
        From chat <strong className={styles.chat}>{chat}</strong>
      </p>
      {reason ? (
        <figure className={styles.quote}>
          <figcaption className={styles.quoteLabel}>The agent says</figcaption>
          <blockquote className={styles.quoteText}>{reason}</blockquote>
        </figure>
      ) : null}
      <fieldset className={styles.apps}>
        <legend className={styles.legend}>Apps</legend>
        {apps.map((app, index) => {
          const denied = app.tier === null;
          const inputId = `${titleId}-app-${index}`;
          return (
            <div key={`${app.bundleId}-${index}`} className={styles.appRow} data-denied={denied || undefined}>
              <input
                ref={index === firstGrantable ? firstRef : undefined}
                id={inputId}
                type="checkbox"
                className={styles.check}
                checked={!denied && ticked.has(app.bundleId)}
                disabled={denied}
                onChange={() => toggle(app.bundleId)}
              />
              <label htmlFor={inputId} className={styles.appText}>
                <span className={styles.appHead}>
                  <span className={styles.appName}>{clampText(app.name, NAME_MAX) || clampText(app.bundleId, NAME_MAX)}</span>
                  <span className={styles.tier} data-tier={app.tier ?? 'denied'}>
                    {tierLabel(app.tier)}
                  </span>
                  {app.running ? null : <span className={styles.notRunning}>(not running)</span>}
                </span>
                <span className={styles.appReason}>{clampText(app.reason, LINE_MAX)}</span>
              </label>
            </div>
          );
        })}
      </fieldset>
      <Queued count={queued} />
      <div className={styles.actions}>
        <button type="button" className={styles.secondary} onClick={deny}>
          Deny
        </button>
        <button type="button" className={styles.primary} onClick={allow} disabled={ticked.size === 0}>
          Allow selected
        </button>
      </div>
      <p className={styles.footnote}>Grants last until you close this chat, restart Verse, or press KILL. Esc stops the agent at any time.</p>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// Confirmation card
// ---------------------------------------------------------------------------

export function confirmWhy(confirm: { reason: string; label: string | null }): string {
  if (confirm.reason === 'untrusted-content') return 'This turn read content from another app or web page, which could contain instructions.';
  const word = sensitiveWordIn(confirm.label);
  return word ? `The control is labelled ${word}.` : 'The control looks consequential.';
}

export function ConfirmCard({
  prompt,
  chat,
  queued,
  onAnswer,
}: {
  prompt: Extract<ComputerPrompt, { kind: 'confirm' }>;
  chat: string;
  queued: number;
  onAnswer: (decision: ConfirmDecision) => void;
}) {
  const titleId = useId();
  const whyId = useId();
  const denyRef = useRef<HTMLButtonElement>(null);
  const answered = useRef(false);
  const answer = (decision: ConfirmDecision) => {
    if (answered.current) return;
    answered.current = true;
    onAnswer(decision);
  };
  const { confirm } = prompt;
  const summary = clampText(confirm.summary, SUMMARY_MAX) || `${clampText(confirm.action, 40)} in ${clampText(confirm.app, NAME_MAX)}`;
  return (
    <Sheet titleId={titleId} title="Allow this action?" onEscape={() => answer('deny')} initialFocusRef={denyRef} tone="warning" describedBy={whyId}>
      <p className={styles.meta}>
        From chat <strong className={styles.chat}>{chat}</strong>
      </p>
      <p className={styles.summary}>{summary}</p>
      <p id={whyId} className={styles.why}>
        {confirmWhy(confirm)}
      </p>
      <Queued count={queued} />
      <div className={styles.actions}>
        <button ref={denyRef} type="button" className={styles.secondary} onClick={() => answer('deny')}>
          Deny
        </button>
        <button type="button" className={styles.secondary} onClick={() => answer('chat')}>
          Allow for chat
        </button>
        <button type="button" className={styles.primary} onClick={() => answer('once')}>
          Allow once
        </button>
      </div>
      <p className={styles.footnote}>“Allow for chat” stops asking for this reason until the chat’s grants end.</p>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// Onboarding (permissions)
// ---------------------------------------------------------------------------

const STATUS_TEXT: Record<PermissionStatus, string> = { granted: 'Allowed', missing: 'Not allowed', unknown: 'Not checked yet' };

export function OnboardingSheet({
  permissions,
  checking,
  onOpenSettings,
  onAsk,
  onCheck,
  onClose,
}: {
  permissions: ComputerPermissions;
  checking: boolean;
  onOpenSettings: (kind: 'screen' | 'accessibility') => void;
  onAsk: () => Promise<void>;
  onCheck: () => void;
  onClose: () => void;
}) {
  const titleId = useId();
  const [asking, setAsking] = useState(false);
  const rows: Array<{ kind: 'screen' | 'accessibility'; name: string; why: string; button: string }> = [
    { kind: 'screen', name: 'Screen Recording', why: 'to see windows', button: 'Open Screen Recording settings' },
    { kind: 'accessibility', name: 'Accessibility', why: 'to click, type and read controls', button: 'Open Accessibility settings' },
  ];
  return (
    <Sheet titleId={titleId} title="Let Ashlr see and use this Mac" onEscape={onClose}>
      <p className={styles.body}>Agents in Verse need two macOS permissions before they can use the apps you grant them.</p>
      <ul className={styles.permissions}>
        {rows.map((row) => (
          <li key={row.kind} className={styles.permissionRow}>
            <div className={styles.permissionText}>
              <span className={styles.appName}>{row.name}</span>
              <span className={styles.appReason}>{row.why}</span>
            </div>
            <span className={styles.status} data-status={permissions[row.kind]} aria-live="polite">
              {STATUS_TEXT[permissions[row.kind]]}
            </span>
            <button type="button" className={styles.secondary} onClick={() => onOpenSettings(row.kind)}>
              {row.button}
            </button>
          </li>
        ))}
      </ul>
      <ul className={styles.notes}>
        <li>After you allow Screen Recording, macOS needs Ashlr to quit and relaunch before it takes effect.</li>
        <li>macOS asks again roughly once a month (“continue to allow?”). Say yes to keep computer use working.</li>
        <li>A local rebuild of Ashlr signed with a different identity loses both permissions; allow them again.</li>
      </ul>
      <div className={styles.actions}>
        <button type="button" className={styles.secondary} onClick={onClose}>
          Close
        </button>
        <button
          type="button"
          className={styles.secondary}
          disabled={asking}
          onClick={() => {
            setAsking(true);
            void onAsk().finally(() => setAsking(false));
          }}
        >
          Ask macOS
        </button>
        <button type="button" className={styles.primary} onClick={onCheck} disabled={checking}>
          {checking ? 'Checking…' : 'Check again'}
        </button>
      </div>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// Status pill
// ---------------------------------------------------------------------------

function StatusPill({
  control,
  grants,
  grantCount,
  notice,
  chatLabel,
  onKill,
  onResume,
  onRevoke,
  onDismissNotice,
}: {
  control: ControlStatus;
  grants: VerseComputerState | null;
  grantCount: number;
  notice: string | null;
  chatLabel: (sessionId: string) => string;
  onKill: () => void;
  onResume: () => void;
  onRevoke: (sessionId: string, bundleId: string) => void;
  onDismissNotice: () => void;
}) {
  const [listOpen, setListOpen] = useState(false);
  const listId = useId();
  const visible = control.state !== 'idle' || grantCount > 0 || notice !== null;
  useEffect(() => {
    if (grantCount === 0) setListOpen(false);
  }, [grantCount]);
  if (!visible) return null;

  const app = control.app ? clampText(control.app, NAME_MAX) : null;
  let text: string;
  if (control.state === 'active') text = `Agent controlling ${app ?? 'an app'} — Esc to stop`;
  else if (control.state === 'paused') text = 'You took over — the agent is paused';
  else if (control.state === 'killed') text = 'Stopped — every desktop grant was revoked';
  else text = grantCount === 1 ? '1 app granted to agents' : `${grantCount} apps granted to agents`;
  const killable = control.state === 'active' || control.state === 'paused' || grantCount > 0;

  return (
    <div className={styles.pillWrap} data-computer-pill>
      <div className={styles.pill} data-state={control.state} role="status" aria-live="polite">
        <span className={styles.dot} aria-hidden="true" />
        <span className={styles.pillText}>{text}</span>
        {control.state === 'paused' ? (
          <button type="button" className={styles.pillButton} onClick={onResume}>
            Resume
          </button>
        ) : null}
        {grantCount > 0 ? (
          <button
            type="button"
            className={styles.pillButton}
            aria-expanded={listOpen}
            aria-controls={listOpen ? listId : undefined}
            onClick={() => setListOpen((v) => !v)}
          >
            Grants
          </button>
        ) : null}
        {killable ? (
          <button type="button" className={styles.kill} onClick={onKill} aria-label="KILL — stop the agent and revoke every desktop grant">
            KILL
          </button>
        ) : null}
      </div>
      {notice ? (
        <div className={styles.notice} role="alert">
          <span>{notice}</span>
          <button type="button" className={styles.pillButton} onClick={onDismissNotice}>
            Dismiss
          </button>
        </div>
      ) : null}
      {listOpen && grants ? (
        <div
          id={listId}
          className={styles.grants}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              setListOpen(false);
            }
          }}
        >
          {grants.chats
            .filter((chat) => chat.grants.length > 0)
            .map((chat) => (
              <section key={chat.sessionId} className={styles.grantChat} aria-label={`Grants for ${chatLabel(chat.sessionId)}`}>
                <h3 className={styles.grantChatTitle}>{chatLabel(chat.sessionId)}</h3>
                <ul className={styles.grantList}>
                  {chat.grants.map((grant) => {
                    const name = clampText(grant.name, NAME_MAX) || clampText(grant.bundleId, NAME_MAX);
                    return (
                      <li key={grant.bundleId} className={styles.grantRow}>
                        <span className={styles.appName}>{name}</span>
                        <span className={styles.tier} data-tier={grant.tier}>
                          {TIER_LABEL[grant.tier] ?? grant.tier}
                        </span>
                        <button type="button" className={styles.pillButton} onClick={() => onRevoke(chat.sessionId, grant.bundleId)} aria-label={`Revoke ${name}`}>
                          Revoke
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
        </div>
      ) : null}
    </div>
  );
}
