/**
 * routes/verse/sections/ChatSettingsPanel.tsx — Settings ▸ Chat (unit C1;
 * SPEC-310C §2 "Settings offers Expanded, Collapsed or Hidden", C2/C3
 * cross-unit requests).
 *
 *   Reasoning            how the transcript shows thinking — C2's preference
 *                        (chat/reasoning-pref.ts); this panel writes through
 *                        that store and never keeps a copy of the value.
 *   New chats start in   the GLOBAL permission-mode and effort defaults a new
 *                        chat is created with — C3's server-side defaults
 *                        (composer-queries fetchControlDefaults /
 *                        updateControlDefaults). The engine drops a default a
 *                        seat cannot honour (initialControlsFor), so a global
 *                        "max" never breaks a local chat; the row says so.
 *
 * Bypass is never offered: it is confirmed per chat and can never be a
 * default (the server refuses it, and the list here does not contain it).
 * Writes need the mutation token — asked for through the same token dialog
 * the composer uses, with a reason naming the change.
 */
import { useCallback, useEffect, useId, useState } from 'react';
import { MutationTokenDialog } from '../../../components/auth/MutationTokenDialog.js';
import { Segmented, Select } from '../../../components/primitives/index.js';
import { ApiError } from '../../../data/client.js';
import { VERSE_EFFORTS, type VerseEffort, type VersePermissionMode, type VerseSessionControls } from '../../../../core/verse/types.js';
import type { VerseSessionControlDefaults, VerseSessionControlDefaultsUpdate } from '../../../../core/verse/workbench-types.js';
import {
  REASONING_DISPLAY_LABEL,
  REASONING_DISPLAYS,
  setReasoningDisplay,
  useReasoningDisplay,
  type ReasoningDisplay,
} from '../chat/reasoning-pref.js';
import { fetchControlDefaults, updateControlDefaults } from '../composer/composer-queries.js';
import { describeContextError, useTokenGate } from '../context/use-token-gate.js';
import { Panel, SettingRow } from './SettingRow.js';
import styles from './SettingsSection.module.css';

const DESCRIPTION: Readonly<Record<ReasoningDisplay, string>> = {
  collapsed: 'Streams three lines while the model thinks, then folds to “Thought 12s · ~1.8k tok”.',
  expanded: 'Streams, and stays open when the thinking is done.',
  hidden: 'No reasoning in the transcript. The live status still says it is thinking, so a long think never looks like a hang.',
};

type DefaultMode = Exclude<VersePermissionMode, 'bypass'>;

/** Picker order and words match the composer's permission menu (C3). */
export const DEFAULT_MODES: readonly DefaultMode[] = ['plan', 'accept-edits', 'auto'];
const MODE_LABEL: Readonly<Record<DefaultMode, string>> = { plan: 'Plan', 'accept-edits': 'Accept edits', auto: 'Auto' };
const MODE_DESCRIPTION: Readonly<Record<DefaultMode, string>> = {
  plan: 'New chats plan and edit nothing until you switch them.',
  'accept-edits': 'New chats apply edits without asking — the default.',
  auto: 'New chats run in the CLI’s own auto mode.',
};
const EFFORT_LABEL: Readonly<Record<VerseEffort, string>> = {
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
};
/** The <select> value for "no default" (null on the wire). */
const MODEL_DEFAULT = '';

type Load =
  | { state: 'loading' }
  | { state: 'ready'; defaults: VerseSessionControlDefaults }
  | { state: 'unavailable'; message: string };

const MODE_SET: ReadonlySet<string> = new Set(DEFAULT_MODES);
const EFFORT_SET: ReadonlySet<string> = new Set(VERSE_EFFORTS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The defaults as this panel may show them. The body crossed the network, so
 * it is narrowed field by field: an unknown mode or effort shows as the
 * engine default (never as a value the server did not send), and a body that
 * is not the contract at all is "unavailable", never a crash of Settings.
 */
export function narrowControlDefaults(raw: unknown): VerseSessionControlDefaults | null {
  if (!isRecord(raw) || !isRecord(raw['global'])) return null;
  const clean = (value: unknown): VerseSessionControls => {
    const out: VerseSessionControls = {};
    if (!isRecord(value)) return out;
    if (typeof value['permissionMode'] === 'string' && MODE_SET.has(value['permissionMode'])) out.permissionMode = value['permissionMode'] as DefaultMode;
    if (typeof value['effort'] === 'string' && EFFORT_SET.has(value['effort'])) out.effort = value['effort'] as VerseEffort;
    return out;
  };
  const seats: Record<string, VerseSessionControls> = {};
  if (isRecord(raw['seats'])) for (const [id, value] of Object.entries(raw['seats'])) seats[id] = clean(value);
  return { global: clean(raw['global']), seats };
}

function loadFailure(err: unknown): string {
  // 404: a server before C3's route; 501: an engine without the methods.
  if (err instanceof ApiError && (err.status === 404 || err.status === 501)) {
    return 'This server can’t set new-chat defaults yet — update Ashlr and restart `ashlr verse`.';
  }
  return 'Couldn’t read the new-chat defaults. Reopen Settings to try again.';
}

function NewChatDefaults() {
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const gate = useTokenGate();
  const modeLabelId = useId();
  const effortId = useId();

  useEffect(() => {
    const controller = new AbortController();
    fetchControlDefaults(controller.signal).then(
      (raw) => {
        const defaults = narrowControlDefaults(raw);
        setLoad(defaults ? { state: 'ready', defaults } : { state: 'unavailable', message: loadFailure(null) });
      },
      (err: unknown) => {
        if (controller.signal.aborted) return;
        setLoad({ state: 'unavailable', message: loadFailure(err) });
      },
    );
    return () => controller.abort();
  }, []);

  const save = useCallback(async (update: VerseSessionControlDefaultsUpdate, reason: string) => {
    setError(null);
    setSaving(true);
    try {
      const next = await gate.run(reason, () => updateControlDefaults(update));
      // null = the token prompt was dismissed: nothing changed, nothing to say.
      if (next) {
        const defaults = narrowControlDefaults(next);
        if (defaults) setLoad({ state: 'ready', defaults });
      }
    } catch (err) {
      setError(describeContextError(err));
    } finally {
      setSaving(false);
    }
  }, [gate]);

  if (load.state === 'loading') {
    return <p className={styles.panelNote} aria-busy="true">Reading new-chat defaults…</p>;
  }
  if (load.state === 'unavailable') {
    return <p className={styles.panelNote}>{load.message}</p>;
  }

  const global = load.defaults.global;
  const mode: DefaultMode = global.permissionMode && global.permissionMode !== 'bypass' ? global.permissionMode : 'accept-edits';
  const effort = global.effort ?? null;
  const seatOverrides = Object.keys(load.defaults.seats).length;

  return (
    <>
      <SettingRow label="New chats start in" description={MODE_DESCRIPTION[mode]} labelId={modeLabelId}>
        <Segmented<DefaultMode>
          aria-labelledby={modeLabelId}
          size="sm"
          value={mode}
          onChange={(next) => {
            if (next !== mode) void save({ permissionMode: next }, `Start new chats in ${MODE_LABEL[next]}.`);
          }}
          options={DEFAULT_MODES.map((value) => ({ value, label: MODE_LABEL[value], disabled: saving }))}
        />
      </SettingRow>
      <SettingRow
        label="Reasoning effort for new chats"
        description={
          seatOverrides > 0
            ? `A seat that can’t use this level starts at its model’s own default. ${seatOverrides === 1 ? 'One seat has its' : `${seatOverrides} seats have their`} own default, which wins.`
            : 'A seat that can’t use this level starts at its model’s own default.'
        }
        htmlFor={effortId}
      >
        <Select
          id={effortId}
          size="sm"
          value={effort ?? MODEL_DEFAULT}
          disabled={saving}
          onChange={(event) => {
            const raw = event.target.value;
            const next = raw === MODEL_DEFAULT ? null : (raw as VerseEffort);
            if (next === effort) return;
            void save({ effort: next }, next ? `Start new chats at ${EFFORT_LABEL[next]} effort.` : 'Start new chats at the model’s default effort.');
          }}
        >
          <option value={MODEL_DEFAULT}>Model default</option>
          {VERSE_EFFORTS.map((value) => (
            <option key={value} value={value}>{EFFORT_LABEL[value]}</option>
          ))}
        </Select>
      </SettingRow>
      {error ? <p className={styles.panelNote} role="alert">{error}</p> : null}
      <MutationTokenDialog {...gate.dialog} />
    </>
  );
}

export function ChatSettingsPanel() {
  const display = useReasoningDisplay();
  const labelId = useId();
  return (
    <Panel title="Chat">
      <SettingRow label="Reasoning" description={DESCRIPTION[display]} labelId={labelId}>
        <Segmented<ReasoningDisplay>
          aria-labelledby={labelId}
          size="sm"
          value={display}
          onChange={setReasoningDisplay}
          options={REASONING_DISPLAYS.map((value) => ({ value, label: REASONING_DISPLAY_LABEL[value] }))}
        />
      </SettingRow>
      <NewChatDefaults />
    </Panel>
  );
}
