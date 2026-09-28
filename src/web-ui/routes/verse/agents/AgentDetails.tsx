/**
 * routes/verse/agents/AgentDetails.tsx — one card's detail panel on the
 * Agents board: the plan to review and approve (Plan first), the held prompt,
 * the workspace's scripts (setup log, Run buttons), the spend cap, and the
 * Checks tab (ChecksPanel). Archive and Restore live here too.
 */
import { useEffect, useState } from 'react';
import type { AgentCard, ScriptRunRecord } from '../../../../core/verse/agents/types.js';
import { Button } from '../../../components/primitives/Button.js';
import { Input } from '../../../components/primitives/Input.js';
import { Segmented } from '../../../components/primitives/Segmented.js';
import { Switch } from '../../../components/primitives/Switch.js';
import { elapsedLabel, spendLabel, usd } from './agents-model.js';
import {
  archiveAgentCard,
  decideAgentPlan,
  fetchScriptLog,
  resolveAgentCard,
  restoreAgentCard,
  runAgentScript,
  sendHeldPrompt,
  stopAgentScript,
  updateAgentSettings,
} from './agents-queries.js';
import { ChecksPanel } from './ChecksPanel.js';
import styles from './Agents.module.css';

type Tab = 'overview' | 'checks';

export interface AgentDetailsProps {
  card: AgentCard;
  now: number;
  busy: string | null;
  onClose: () => void;
  onChanged: () => void;
  act: (key: string, why: string, run: () => Promise<string | null>) => Promise<void>;
  onOpenChat: () => void;
  onOpenTerminal: () => void;
  onStop: () => void;
}

export function AgentDetails({ card, now, busy, onClose, onChanged, act, onOpenChat, onOpenTerminal, onStop }: AgentDetailsProps) {
  const [tab, setTab] = useState<Tab>(card.reason === 'ci-failed' || card.reason === 'pr-open' ? 'checks' : 'overview');
  const [planText, setPlanText] = useState(card.plan?.text ?? '');
  const [capText, setCapText] = useState(card.spend.capUsd !== null ? String(card.spend.capUsd) : '');
  const agentId = card.agentId;

  useEffect(() => { setPlanText(card.plan?.text ?? ''); }, [card.plan?.text]);
  useEffect(() => { setCapText(card.spend.capUsd !== null ? String(card.spend.capUsd) : ''); }, [card.spend.capUsd]);

  const saveCap = () => {
    if (!agentId) return;
    const raw = capText.trim().replace(/^\$/, '');
    const cap = raw === '' ? null : Number(raw);
    if (cap !== null && (!Number.isFinite(cap) || cap <= 0)) return;
    void act('cap', 'Change this agent’s spend cap', async () => {
      await updateAgentSettings(agentId, { spendCapUsd: cap });
      return cap === null ? 'Spend cap removed.' : `Spend cap set to ${usd(cap)}.`;
    });
  };

  const latestSetup = [...card.scripts].reverse().find((r) => r.kind === 'setup') ?? null;
  const runs = card.scripts.filter((r) => r.kind === 'run' && r.state === 'running');

  return (
    <aside className={styles.details} aria-label={`Details: ${card.title}`}>
      <header className={styles.detailsHead}>
        <div>
          <h3 className={styles.detailsTitle}>{card.title}</h3>
          <p className={styles.muted}>{card.reasonText}</p>
        </div>
        <Button size="sm" variant="ghost" onClick={onClose} aria-label="Close details">Close</Button>
      </header>

      <div className={styles.detailsActions}>
        {card.sessionId ? <Button size="sm" variant="subtle" onClick={onOpenChat}>Open chat</Button> : null}
        {card.status === 'running' ? <Button size="sm" variant="ghost" onClick={onStop}>Stop</Button> : null}
        {card.reason === 'failed' ? (
          <Button size="sm" variant="ghost" busy={busy === `resolve:${card.id}`} onClick={() => void act(`resolve:${card.id}`, 'Resolve this failed turn', async () => { await resolveAgentCard(card.id); return 'Resolved: it leaves Needs you.'; })}>
            Resolve
          </Button>
        ) : null}
        {agentId && !card.archived ? (
          <Button size="sm" variant="ghost" busy={busy === 'archive'} onClick={() => void act('archive', 'Archive this agent (snapshot, then remove its worktree)', async () => { await archiveAgentCard(agentId); onClose(); return 'Archived. Its snapshot is kept — Restore brings it back.'; })}>
            Archive
          </Button>
        ) : null}
        {agentId && card.restorable ? (
          <Button size="sm" variant="subtle" busy={busy === 'restore'} onClick={() => void act('restore', 'Restore this agent’s workspace', async () => { await restoreAgentCard(agentId); return 'Restored.'; })}>
            Restore
          </Button>
        ) : null}
      </div>

      <Segmented
        aria-label="Detail view"
        value={tab}
        onChange={(v) => setTab(v as Tab)}
        options={[{ value: 'overview', label: 'Overview' }, { value: 'checks', label: 'Checks' }]}
      />

      {tab === 'checks' ? (
        <ChecksPanel cardId={card.id} onChanged={onChanged} />
      ) : (
        <div className={styles.overview}>
          <dl className={styles.facts}>
            <div><dt>Seat</dt><dd>{card.seatId ?? '—'}{card.model ? ` · ${card.model}` : ''}</dd></div>
            <div><dt>Where</dt><dd className={styles.mono}>{card.repo ?? '—'}{card.branch ? ` · ${card.branch}` : ''}</dd></div>
            {card.workspacePath ? <div><dt>Workspace</dt><dd className={styles.mono}>{card.workspacePath}</dd></div> : null}
            {card.ports ? <div><dt>Ports</dt><dd>{card.ports.count > 0 ? `${card.ports.base}–${card.ports.base + card.ports.count - 1} (ASHLR_PORT)` : `ASHLR_PORT=${card.ports.base}`}</dd></div> : null}
            <div><dt>Spend</dt><dd>{spendLabel(card.spend)} <span className={styles.muted}>(API list price)</span></dd></div>
            {card.startedAt ? <div><dt>Running for</dt><dd>{elapsedLabel(card.startedAt, now)}</dd></div> : null}
          </dl>

          {card.plan && card.plan.state === 'awaiting-approval' && agentId ? (
            <section className={styles.planBox} aria-label="Plan for approval">
              <h4 className={styles.smallHead}>Plan — edit, then approve</h4>
              <textarea className={styles.textarea} rows={12} value={planText} onChange={(e) => setPlanText(e.target.value)} />
              <div className={styles.formActions}>
                <Button size="sm" variant="ghost" busy={busy === 'plan:discard'} onClick={() => void act('plan:discard', 'Discard this plan', async () => { await decideAgentPlan(agentId, 'discard'); return 'Plan discarded. Nothing was changed.'; })}>
                  Discard
                </Button>
                <Button size="sm" variant="primary" busy={busy === 'plan:approve'} onClick={() => void act('plan:approve', 'Approve the plan: the seat starts making the changes', async () => { await decideAgentPlan(agentId, 'approve', planText); return 'Approved — the agent is carrying it out.'; })}>
                  Approve and run
                </Button>
              </div>
            </section>
          ) : card.plan ? (
            <p className={styles.hint}>Plan first: {card.plan.state === 'drafting' ? 'the seat is writing a plan.' : card.plan.state === 'approved' ? 'plan approved.' : 'on.'}</p>
          ) : null}

          {card.heldPrompt && agentId ? (
            <section className={styles.held}>
              <p className={styles.hint}>The first prompt is held until setup finishes.</p>
              <div className={styles.formActions}>
                <Button size="sm" variant="ghost" busy={busy === 'setup'} onClick={() => void act('setup', 'Run setup again', async () => { await runAgentScript(agentId, 'setup'); return 'Setup started again.'; })}>
                  Rerun setup
                </Button>
                <Button size="sm" variant="subtle" busy={busy === 'send'} onClick={() => void act('send', 'Send the held prompt now, without setup', async () => { await sendHeldPrompt(agentId); return 'Sent.'; })}>
                  Send anyway
                </Button>
              </div>
            </section>
          ) : null}

          {agentId && card.workspacePath ? (
            <section aria-label="Scripts">
              <h4 className={styles.smallHead}>Workspace scripts</h4>
              <div className={styles.scriptButtons}>
                {card.runScripts.map((name, index) => (
                  <Button key={name} size="sm" variant="subtle" busy={busy === `run:${index}`} onClick={() => void act(`run:${index}`, `Run “${name}” in this workspace`, async () => {
                    const res = await runAgentScript(agentId, 'run', index);
                    if (res.run.via === 'terminal') onOpenTerminal();
                    return `${name} started${res.run.via === 'terminal' ? ' in a terminal tab' : ''}.`;
                  })}>
                    Run {name}
                  </Button>
                ))}
                {card.runScripts.length === 0 ? <span className={styles.muted}>No run scripts in .ashlr/verse/workspace.json.</span> : null}
              </div>
              {runs.map((r) => (
                <div key={r.id} className={styles.runRow}>
                  <span>{r.name} — running{r.via === 'terminal' ? ' in a terminal tab' : ''}</span>
                  <Button size="sm" variant="ghost" onClick={() => void act(`stop:${r.id}`, `Stop ${r.name}`, async () => { await stopAgentScript(agentId, r.id); return `${r.name} stopped.`; })}>Stop</Button>
                </div>
              ))}
              {latestSetup ? <ScriptLog agentId={agentId} run={latestSetup} onOpenTerminal={onOpenTerminal} /> : null}
            </section>
          ) : null}

          {agentId ? (
            <section className={styles.capBox} aria-label="Spend cap">
              <Input
                label="Spend cap (USD at API list price)"
                size="sm"
                value={capText}
                onChange={(e) => setCapText(e.target.value)}
                placeholder="none"
                inputMode="decimal"
                hint="Warns at 80%; at 100% the agent stops and takes no more turns until you raise it."
              />
              <Button size="sm" variant="subtle" onClick={saveCap} busy={busy === 'cap'}>Save cap</Button>
              <Switch
                checked={card.pinned}
                onChange={(v) => void act('pin', v ? 'Pin this agent' : 'Unpin this agent', async () => { await updateAgentSettings(agentId, { pinned: v }); return null; })}
                label="Pinned (never auto-archived)"
              />
            </section>
          ) : null}

          {card.loopNote ? <p className={styles.loopNote} role="status">{card.loopNote}</p> : null}
        </div>
      )}
    </aside>
  );
}

function ScriptLog({ agentId, run, onOpenTerminal }: { agentId: string; run: ScriptRunRecord; onOpenTerminal: () => void }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    if (run.via !== 'process') return undefined;
    const ctl = new AbortController();
    const load = () => fetchScriptLog(agentId, run.id, ctl.signal).then((l) => setText(l.text), () => undefined);
    void load();
    const t = run.state === 'running' ? setInterval(load, 2_000) : null;
    return () => { ctl.abort(); if (t) clearInterval(t); };
  }, [agentId, run.id, run.via, run.state]);
  const state = run.state === 'running' ? 'running' : run.state === 'ok' ? 'finished' : `failed${run.exitCode !== null ? ` (exit ${run.exitCode})` : ''}`;
  return (
    <div className={styles.setupLog}>
      <div className={styles.runRow}>
        <span>Setup {state}</span>
        {run.via === 'terminal' ? <Button size="sm" variant="ghost" onClick={onOpenTerminal}>Show terminal</Button> : null}
      </div>
      {run.via === 'process' && text ? <pre className={styles.log}>{text.slice(-8_000)}</pre> : null}
    </div>
  );
}
