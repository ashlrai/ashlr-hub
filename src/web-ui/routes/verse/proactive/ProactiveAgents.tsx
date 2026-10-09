import { useRef, useState } from 'react';
import type { ProactiveAvatar, ProactiveProfile, ProactiveProfileInput, ProactiveProvider, ProactiveService } from '../../../../core/proactive/types.js';
import { MutationTokenDialog } from '../../../components/auth/MutationTokenDialog.js';
import { Button } from '../../../components/primitives/Button.js';
import { Dialog } from '../../../components/primitives/Dialog.js';
import { Input } from '../../../components/primitives/Input.js';
import { Select } from '../../../components/primitives/Select.js';
import { Switch } from '../../../components/primitives/Switch.js';
import { ApiError, readFailureReason } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { describeContextError, useTokenGate } from '../context/use-token-gate.js';
import { VerseMark } from '../rail-icons.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { createProactiveProfile, deleteProactiveProfile, editProactiveProfile, proactiveProfilesQuery } from './proactive-queries.js';
import styles from './ProactiveAgents.module.css';

const PROVIDERS: Record<ProactiveProvider, string> = { 'openai-dot': 'OpenAI Dot', 'grok-bot': 'Grok Bot', 'meta-muse': 'Meta Muse', other: 'Other agent' };
const OPERATION_LABEL = { dispatch: 'Send work', status: 'Read status', cancel: 'Cancel work', result: 'Read results' };
function SetupHelp({ provider }: { provider: ProactiveProvider }) {
  const link = provider === 'openai-dot' ? { href: 'https://developers.openai.com/plugins/build/mcp-events', label: 'OpenAI plugin events setup' }
    : provider === 'grok-bot' ? { href: 'https://cursor.com/help/grok-bot/routines', label: 'Grok Bot routine setup' }
      : provider === 'meta-muse' ? { href: 'https://ai.meta.com/muse/', label: 'Meta Muse product guide' } : null;
  const guidance = provider === 'openai-dot' ? 'A supported connection needs an authenticated HTTPS plugin and event subscription. Phantom has not commissioned that connection yet.'
    : provider === 'grok-bot' ? 'An existing routine needs an account-bound connection and independent result evidence. Phantom has not commissioned that connection yet.'
      : provider === 'meta-muse' ? 'A supported personal-Muse connection has not been verified. Meta Model API funding does not connect your personal Muse.'
        : 'Record your existing agent identity. A supported account connection and result path are needed before Phantom can send work.';
  return <div className={styles.setup}><p>{guidance}</p>{link ? <a href={link.href} target="_blank" rel="noopener noreferrer">{link.label} ↗</a> : null}
    {provider === 'grok-bot' ? <p>Grok Bot has its own weekly allowance on your Cursor account, separate from Grok Build. Its balance, reset and on-demand billing must be verified separately. <a href="https://cursor.com/help/grok-bot/plans" target="_blank" rel="noopener noreferrer">Bot usage and billing ↗</a></p> : null}
  </div>;
}
type Draft = Required<Pick<ProactiveProfileInput, 'identity' | 'displayName' | 'avatar' | 'responsibility' | 'computer' | 'services' | 'enabled'>> & { fundingKind: 'unknown' | 'subscription' | 'promotional-api'; poolId: string };
type Editor = { saved: ProactiveProfile | null; draft: Draft; conflict: boolean };
function draftOf(profile?: ProactiveProfile): Draft {
  return {
    identity: profile ? { ...profile.identity } : { provider: 'openai-dot', accountId: '', agentId: '' },
    displayName: profile?.displayName ?? '', avatar: { ...(profile?.avatar ?? { color: '#5a59ef', variant: 'classic' }) },
    responsibility: profile?.responsibility ?? '', computer: { ...(profile?.computer ?? { kind: 'unknown', label: '', providerComputerId: null }) },
    services: profile?.services.map(service => ({ ...service })) ?? [], enabled: profile?.enabled ?? false,
    fundingKind: profile?.fundingReference?.kind ?? 'unknown', poolId: profile?.fundingReference?.poolId ?? '',
  };
}
function profileInput(draft: Draft): ProactiveProfileInput {
  const identity = { ...draft.identity, accountId: draft.identity.accountId.trim(), agentId: draft.identity.agentId.trim() };
  return { identity, displayName: draft.displayName.trim(), avatar: draft.avatar,
    responsibility: draft.responsibility.trim(), computer: { ...draft.computer, label: draft.computer.label.trim(), providerComputerId: draft.computer.providerComputerId?.trim() || null },
    services: draft.services.map(service => ({ id: service.id.trim(), label: service.label.trim() })), enabled: draft.enabled,
    fundingReference: draft.fundingKind === 'unknown' && !draft.poolId.trim() ? null : { kind: draft.fundingKind, accountId: identity.accountId, poolId: draft.poolId.trim() || null } };
}
function validDraft(draft: Draft): boolean {
  return !!draft.displayName.trim() && !!draft.identity.accountId.trim() && !!draft.identity.agentId.trim()
    && draft.services.every(service => !!service.id.trim() && !!service.label.trim())
    && new Set(draft.services.map(service => service.id.trim())).size === draft.services.length;
}
function Avatar({ avatar }: { avatar: ProactiveAvatar }) {
  return <span className={styles.avatar} style={{ color: avatar.color }} data-variant={avatar.variant} aria-hidden="true">
    {avatar.variant === 'classic' ? <VerseMark size={36} /> : <svg viewBox="0 0 32 32" width="36" height="36" focusable="false">
      <path fill="currentColor" d={avatar.variant === 'round' ? 'M16 3a12 12 0 0 0-12 12v13l6-3 6 3 6-3 6 3V15A12 12 0 0 0 16 3Z' : 'M8 4h16v4h4v20h-4v-4h-4v4h-8v-4H8v4H4V8h4Z'} />
      <ellipse fill="#f7faff" cx="11" cy="15" rx="3" ry="4" /><ellipse fill="#f7faff" cx="21" cy="15" rx="3" ry="4" />
      <circle fill="#172442" cx="12" cy="16" r="1.5" /><circle fill="#172442" cx="22" cy="16" r="1.5" />
    </svg>}
  </span>;
}

export function ProactiveAgents() {
  const read = useQuery(proactiveProfilesQuery);
  const refetch = useRefetch(proactiveProfilesQuery);
  usePollWhileVisible(refetch, 30_000);
  const gate = useTokenGate();
  const [editor, setEditor] = useState<Editor | null>(null);
  const [busy, setBusy] = useState(false);
  const flight = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<ProactiveProfile | null>(null);
  const profiles = read.data?.profiles ?? [];
  const unavailable = read.status === 'error' || !read.data;
  const latest = editor?.saved ? profiles.find(profile => profile.id === editor.saved!.id) : undefined;
  const stale = !!editor?.saved && (editor.conflict || !latest || latest.version !== editor.saved.version);

  function open(profile?: ProactiveProfile) { setError(null); setNotice(null); setEditor({ saved: profile ?? null, draft: draftOf(profile), conflict: false }); }
  function patch(patch: Partial<Draft>) { setEditor(current => current ? { ...current, draft: { ...current.draft, ...patch } } : null); }
  async function mutate(reason: string, action: () => Promise<unknown>, done: () => void) {
    if (flight.current) return;
    flight.current = true; setBusy(true); setError(null); setNotice(null);
    try {
      const result = await gate.run(reason, action);
      if (result !== null) { done(); refetch(); }
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 409) {
        setEditor(current => current ? { ...current, conflict: true } : null);
        setDeleting(null);
        setError('This profile changed elsewhere. Your draft is preserved. Refresh, then load the latest profile before saving.');
        refetch();
      } else setError(describeContextError(failure));
    } finally { flight.current = false; setBusy(false); }
  }
  function save() {
    if (!editor || busy || stale || unavailable || !validDraft(editor.draft)) return;
    const input = profileInput(editor.draft);
    const saved = editor.saved;
    void mutate(saved ? 'Save this proactive agent profile' : 'Add this proactive agent profile', () => {
      if (!saved) return createProactiveProfile(input);
      const { identity: _identity, ...editable } = input;
      return editProactiveProfile(saved.id, { ...editable, expectedVersion: saved.version });
    }, () => { setEditor(null); setNotice('Profile saved. You can organize it here; sending work and reading results are not available yet.'); });
  }

  return <section className={styles.section} aria-label="Proactive agents">
    <header className={styles.header}>
      <div><h2>Proactive agents</h2><p>Your persistent agents, their responsibilities and their recorded apps.</p></div>
      <div className={styles.actions}><Button size="sm" variant="ghost" onClick={refetch} disabled={busy}>Refresh agents</Button>
        <Button size="sm" variant="primary" disabled={unavailable || busy} onClick={() => open()}>Add agent</Button></div>
    </header>
    <p className={styles.note}>Save your agents and planning preferences. The planner does not consume these profiles yet; connections, execution and funding are verified separately.</p>
    {notice ? <p role="status">{notice}</p> : null}
    {error && !editor && !deleting ? <p role="alert" className={styles.error}>{error}</p> : null}
    {read.status === 'error' ? <p role="alert" className={styles.error}>Agent profiles are unavailable. {readFailureReason(read.error)} Refresh to retry.</p>
      : !read.data ? <p role="status" aria-busy="true">Reading agent profiles…</p>
        : profiles.length === 0 ? <div className={styles.empty}><Avatar avatar={{ color: '#5a59ef', variant: 'classic' }} />
          <div><h3>Bring your persistent agents together</h3><p>Add Dot, Grok Bot, Muse or another agent. Keep its identity, responsibilities and connection evidence in one place.</p>
            <Button size="sm" variant="primary" onClick={() => open()}>Add your first agent</Button></div></div> : null}
    {read.status !== 'error' ? <ul className={styles.list}>{profiles.map(profile => <li key={profile.id} className={styles.row}>
      <div className={styles.identity}><Avatar avatar={profile.avatar} /><div><h3>{profile.displayName}</h3><p>{PROVIDERS[profile.identity.provider]}</p></div></div>
      <p className={styles.responsibility}>{profile.responsibility || 'No responsibility added yet.'}</p>
      {profile.identity.provider === 'grok-bot' ? <p className={styles.note}>Bot allowance and reset unknown · separate from Grok Build.</p> : null}
      <div className={styles.rowActions}><span className={styles.state}>{profile.enabled ? 'Planning preference on' : 'Planning preference off'}</span>
        <Button size="sm" variant="subtle" onClick={() => open(profile)} disabled={busy}>Edit {profile.displayName}</Button></div>
      <details className={styles.evidence}><summary>Connection and capabilities</summary>
        <dl><div><dt>Connection</dt><dd>Configured profile; transport unverified</dd></div>
          <div><dt>Account</dt><dd>{profile.identity.accountId}</dd></div><div><dt>Agent identity</dt><dd>{profile.identity.agentId}</dd></div>
          <div><dt>Computer</dt><dd>{profile.computer.label || 'Unknown'} · control unverified ({profile.computer.kind === 'hosted' ? 'hosted' : profile.computer.kind === 'connected-local' ? 'connected local computer' : 'not verified'})</dd></div>
          <div><dt>Recorded apps</dt><dd>{profile.services.length ? profile.services.map(service => service.label).join(', ') : 'None recorded'}; access unverified</dd></div>
          <div><dt>Funding reference</dt><dd>{profile.fundingReference ? `${profile.fundingReference.kind === 'subscription' ? 'Subscription' : profile.fundingReference.kind === 'promotional-api' ? 'Promotional API pool' : 'Unknown'} · ${profile.fundingReference.accountId}${profile.fundingReference.poolId ? ` · ${profile.fundingReference.poolId}` : ''}` : 'None recorded'}. Spending eligibility unknown.</dd></div>
          {Object.entries(OPERATION_LABEL).map(([operation, label]) => { const readiness = profile.operations[operation as keyof typeof OPERATION_LABEL]; return <div key={operation}><dt>{label}</dt><dd>{readiness.state === 'unverified' ? 'Unverified' : 'Unsupported'}{readiness.note ? ` — ${readiness.note}` : ''}</dd></div>; })}
          <div><dt>Latest run</dt><dd>No qualified run evidence</dd></div>
        </dl><SetupHelp provider={profile.identity.provider} />
      </details>
    </li>)}</ul> : null}

    <Dialog open={editor !== null} onClose={() => { if (!busy) setEditor(null); }} titleId="proactive-profile-editor" title={editor?.saved ? `Edit ${editor.saved.displayName}` : 'Add a proactive agent'}
      description="Save a profile and planning preference. The planner does not use it yet. This does not connect a transport, send work or enable spending.">
      {editor ? <form className={styles.editor} onSubmit={event => { event.preventDefault(); save(); }}>
        <fieldset disabled={busy}><legend className={styles.visuallyHidden}>Agent profile</legend>
          <label>Name<Input required maxLength={120} value={editor.draft.displayName} onChange={event => patch({ displayName: event.target.value })} /></label>
          <div className={styles.twoColumn}><label>Provider<Select value={editor.draft.identity.provider} disabled={!!editor.saved} onChange={event => patch({ identity: { ...editor.draft.identity, provider: event.target.value as ProactiveProvider } })}>
            {Object.entries(PROVIDERS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</Select></label>
            <label>Avatar<Select value={editor.draft.avatar.variant} onChange={event => patch({ avatar: { ...editor.draft.avatar, variant: event.target.value as ProactiveAvatar['variant'] } })}>
              <option value="classic">Classic ghost</option><option value="round">Round ghost</option><option value="pixel">Pixel ghost</option></Select></label></div>
          <label>Ghost color<input type="color" value={editor.draft.avatar.color} onChange={event => patch({ avatar: { ...editor.draft.avatar, color: event.target.value } })} /></label>
          <div className={styles.twoColumn}><label>Account identity<Input required maxLength={256} disabled={!!editor.saved} value={editor.draft.identity.accountId} onChange={event => patch({ identity: { ...editor.draft.identity, accountId: event.target.value } })} /></label>
            <label>Agent identity<Input required maxLength={256} disabled={!!editor.saved} value={editor.draft.identity.agentId} onChange={event => patch({ identity: { ...editor.draft.identity, agentId: event.target.value } })} /></label></div>
          <SetupHelp provider={editor.draft.identity.provider} />
          <p className={styles.note}>Use the provider’s existing account and agent IDs. These identities stay fixed after saving.</p>
          <label>Responsibility<textarea rows={3} maxLength={4000} value={editor.draft.responsibility} placeholder="What should this agent help with?" onChange={event => patch({ responsibility: event.target.value })} /></label>
          <div className={styles.toggle}><div><strong>Save planning preference</strong><p>Saved preference; no planner consumes this profile yet.</p></div>
            <Switch checked={editor.draft.enabled} aria-label="Save planning preference" onChange={enabled => patch({ enabled })} /></div>
          <details><summary>Computer, apps and funding</summary><div className={styles.advanced}>
            <label>Computer type<Select value={editor.draft.computer.kind} onChange={event => patch({ computer: { ...editor.draft.computer, kind: event.target.value as Draft['computer']['kind'] } })}>
              <option value="unknown">Unknown</option><option value="hosted">Provider hosted</option><option value="connected-local">Local computer (recorded)</option></Select></label>
            <label>Computer label<Input maxLength={120} value={editor.draft.computer.label} onChange={event => patch({ computer: { ...editor.draft.computer, label: event.target.value } })} /></label>
            <label>Provider computer ID<Input maxLength={256} value={editor.draft.computer.providerComputerId ?? ''} onChange={event => patch({ computer: { ...editor.draft.computer, providerComputerId: event.target.value || null } })} /></label>
            <fieldset><legend>Apps</legend>{editor.draft.services.map((service, index) => <div className={styles.service} key={index}>
              <label>App ID<Input aria-label={`App ${index + 1} ID`} maxLength={128} required value={service.id} onChange={event => {
                const services: ProactiveService[] = editor.draft.services.map((item, position) => position === index ? { ...item, id: event.target.value } : item); patch({ services });
              }} /></label><label>App name<Input aria-label={`App ${index + 1} name`} maxLength={120} required value={service.label} onChange={event => patch({ services: editor.draft.services.map((item, position) => position === index ? { ...item, label: event.target.value } : item) })} /></label>
              <Button size="sm" type="button" variant="ghost" onClick={() => patch({ services: editor.draft.services.filter((_, position) => position !== index) })}>Remove app {index + 1}</Button>
            </div>)}<Button size="sm" type="button" variant="subtle" disabled={editor.draft.services.length >= 100} onClick={() => patch({ services: [...editor.draft.services, { id: '', label: '' }] })}>Add app</Button></fieldset>
            <label>Funding kind<Select value={editor.draft.fundingKind} onChange={event => patch({ fundingKind: event.target.value as Draft['fundingKind'] })}>
              <option value="unknown">Unknown</option><option value="subscription">Subscription</option><option value="promotional-api">Promotional API pool</option></Select></label>
            <label>Pool identity<Input maxLength={256} value={editor.draft.poolId} onChange={event => patch({ poolId: event.target.value })} /></label>
            <p className={styles.note}>A reference to this account only. Balance, expiry and spending permission are not inferred.</p>
          </div></details>
        </fieldset>
        {error ? <p role="alert" className={styles.error}>{error}</p> : null}
        {stale ? <p role="status">This profile changed or was removed. Your draft is preserved.
          <Button size="sm" type="button" variant="ghost" onClick={refetch} disabled={busy}>Refresh latest profile</Button>
          {latest ? <Button size="sm" type="button" variant="subtle" disabled={busy} onClick={() => { setEditor({ saved: latest, draft: draftOf(latest), conflict: false }); setError(null); }}>Load latest profile</Button> : null}</p> : null}
        <div className={styles.actions}>
          {editor.saved ? <Button type="button" size="sm" variant="danger" disabled={busy || stale} onClick={() => { setDeleting(editor.saved); setError(null); }}>Delete profile</Button> : null}
          <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setEditor(null)}>Cancel</Button>
          <Button type="submit" size="sm" variant="primary" busy={busy} disabled={unavailable || stale || !validDraft(editor.draft)}>Save profile</Button>
        </div>
      </form> : null}
    </Dialog>
    <Dialog open={deleting !== null} titleId="proactive-profile-delete" title="Delete this profile?" description="This removes the profile from Phantom. It does not stop or delete the provider’s agent." onClose={() => { if (!busy) setDeleting(null); }}>
      {error ? <p role="alert" className={styles.error}>{error}</p> : null}
      <div className={styles.actions}><Button size="sm" variant="ghost" disabled={busy} onClick={() => setDeleting(null)}>Keep profile</Button>
        <Button size="sm" variant="danger" busy={busy} onClick={() => { if (!deleting) return; const saved = deleting;
          void mutate('Delete this proactive agent profile', () => deleteProactiveProfile(saved.id, saved.version), () => { setDeleting(null); setEditor(null); setNotice('Agent profile deleted.'); }); }}>Delete agent profile</Button></div>
    </Dialog>
    <MutationTokenDialog {...gate.dialog} tokenLabel="Mutation token" tokenHelp="the mutation token phm verse printed" />
  </section>;
}
