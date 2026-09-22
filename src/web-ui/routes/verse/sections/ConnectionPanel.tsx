/**
 * routes/verse/sections/ConnectionPanel.tsx — which server this window is
 * talking to, what authority it currently holds, and how to get the tokens
 * back if it loses them.
 *
 * SECURITY: this panel never renders, copies or logs a token. It shows the
 * STATE of the two authorities (read session, mutation hold) and tells the
 * operator where the real values are printed — the terminal that started the
 * server. The mutation token is memory-only by design (data/auth-store.ts);
 * showing it here would put it on screen, in a screenshot, and in any
 * screen-recording of a demo.
 */
import { useRef, useState } from 'react';
import { Button, Dialog, Input, StatusBadge } from '../../../components/primitives/index.js';
import { IconCopy, IconInfo, IconLock } from '../../../components/primitives/icons.js';
import { clearMutationToken, clearReadSession } from '../../../data/auth-store.js';
import { useAuthPhase, useMutationHold } from '../../../data/hooks.js';
import { useToast } from '../../../components/primitives/Toast.js';
import { Panel, SettingRow } from './SettingRow.js';
import styles from './SettingsSection.module.css';

function formatHoldExpiry(heldUntil: number | null): string {
  if (heldUntil === null) return 'locked';
  const minutes = Math.max(0, Math.round((heldUntil - Date.now()) / 60_000));
  if (minutes <= 0) return 'expiring now';
  return `unlocked for ${minutes} more minute${minutes === 1 ? '' : 's'}`;
}

export function ConnectionPanel() {
  const phase = useAuthPhase();
  const hold = useMutationHold();
  const toast = useToast();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);

  const origin = typeof window === 'undefined' ? '' : window.location.origin;

  async function copyOrigin(): Promise<void> {
    try {
      await navigator.clipboard.writeText(origin);
      toast.show('Server address copied.');
    } catch {
      toast.show('Could not reach the clipboard — select the field and copy manually.', 'danger');
    }
  }

  async function disconnect(): Promise<void> {
    setConfirmOpen(false);
    await clearReadSession();
    toast.show('Disconnected. Paste the read token to reconnect.');
  }

  return (
    <Panel title="Connection">
      <SettingRow label="Server" description="This window talks to one local hub. Nothing leaves your machine.">
        <div className={styles.origin}>
          <Input value={origin} readOnly mono size="sm" aria-label="Server address" />
        </div>
        <Button variant="ghost" size="sm" icon={<IconCopy />} onClick={() => void copyOrigin()}>
          Copy
        </Button>
      </SettingRow>

      <SettingRow label="Read session" description="A 15-minute signed cookie, renewed silently while this tab stays open.">
        <StatusBadge
          status={phase === 'authenticated' ? 'connected' : phase === 'checking' ? 'checking' : 'disconnected'}
          tone={phase === 'authenticated' ? 'success' : phase === 'checking' ? 'running' : 'danger'}
        />
      </SettingRow>

      <SettingRow
        label="Mutation hold"
        description="Every action that changes something needs the mutation token. It is held in memory only, never stored, and clears when this tab closes."
      >
        <StatusBadge
          status={hold.hasHold ? formatHoldExpiry(hold.heldUntil) : 'locked'}
          tone={hold.hasHold ? 'success' : 'neutral'}
        />
        <Button
          variant="subtle"
          size="sm"
          icon={<IconLock />}
          onClick={() => {
            clearMutationToken();
            toast.show('Mutation hold cleared.');
          }}
          disabled={!hold.hasHold}
        >
          Lock now
        </Button>
      </SettingRow>

      <SettingRow
        label="Disconnect"
        description="Ends the read session in this browser and clears the mutation hold. Chats on the server are untouched."
      >
        <Button variant="danger" size="sm" onClick={() => setConfirmOpen(true)}>
          Disconnect
        </Button>
      </SettingRow>

      <div className={styles.row}>
        <p className={styles.note}>
          <span className={styles.noteIcon}>
            <IconInfo size={14} />
          </span>
          <span>
            <strong>Where the tokens come from.</strong> Start the console with{' '}
            <code className={styles.code}>ashlr verse</code> — it prints a read token and a mutation token in that
            terminal, and opens this page. The desktop app injects both for you. Tokens are never displayed here, and
            the hub never writes them into a page, a log line or an API response. Lost them? Stop the server and start
            it again; it mints a fresh pair.
          </span>
        </p>
      </div>

      <Dialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        titleId="verse-settings-disconnect"
        title="Disconnect from this server?"
        description="You will need the read token again to get back in. Running sessions keep running on the server."
        initialFocusRef={cancelRef}
      >
        <div className={styles.previewRow} style={{ justifyContent: 'flex-end' }}>
          <Button ref={cancelRef} variant="subtle" onClick={() => setConfirmOpen(false)}>
            Cancel
          </Button>
          <Button variant="danger" onClick={() => void disconnect()}>
            Disconnect
          </Button>
        </div>
      </Dialog>
    </Panel>
  );
}
