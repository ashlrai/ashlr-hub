/**
 * routes/verse/mobile/screens/MoreScreen.tsx — the More tab: what this
 * device may do (and locking / unlocking it), the other places to go, the
 * theme, the desktop layout, installing to the Home Screen, the connection
 * to the Mac with sign-out, and the version.
 *
 * Nothing here is a server write except through the existing guards:
 *   - Unlock opens the SAME token sheet every action uses (guard-store's
 *     `requestGuarded` with the confirmation skipped), so the token goes into
 *     the one memory-only hold and nowhere else;
 *   - Lock now drops that hold (data/auth-store.ts clearMutationToken);
 *   - Sign out ends the read session (clearReadSession) after a sheet that
 *     says what it means — it is not a change on the Mac, so it is not a
 *     guarded action.
 * The theme is the workbench's own store (useTheme), so the phone and the Mac
 * browser share one choice.
 */
import { useEffect, useState } from 'react';
import { clearMutationToken, clearReadSession } from '../../../../data/auth-store.js';
import { isRemoteMobileMode } from '../../../../data/remote-mode.js';
import { currentRemoteSession, remotePushPublicKey, subscribeRemotePush } from '../../../../data/remote-session.js';
import { useMutationHold, useTheme } from '../../../../data/hooks.js';
import type { ThemePreference } from '../../../../data/theme-store.js';
import { writeVerseLayoutPreference } from '../../../../app/console-mode.js';
import { requestGuarded } from '../../shell/guard-store.js';
import { APP_NAME, APP_VERSION } from '../../sections/app-version.js';
import type { Reachability } from '../connectivity.js';
import { canShowActions, useMobile } from '../mobile-context.js';
import { showMobileToast } from '../mobile-toast.js';
import { enableRemotePush, supportsIphoneHomeScreenPush } from '../pwa.js';
import { BottomSheet } from '../sheet.js';
import { Button, Screen } from '../ui.js';
import { Badge, Row, Section, ui, type Tone } from '../ui-parts.js';
import styles from './MoreScreen.module.css';

const THEMES: ReadonlyArray<{ value: ThemePreference; label: string }> = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

const REACH: Readonly<Record<Reachability, { word: string; tone: Tone; detail: string }>> = {
  live: { word: 'Connected', tone: 'success', detail: 'Your Mac answered the last check.' },
  connecting: { word: 'Connecting', tone: 'neutral', detail: 'Waiting for your Mac to answer.' },
  offline: { word: 'Offline', tone: 'warning', detail: 'This phone has no network. The last update stays on screen.' },
  unreachable: { word: 'Can’t reach your Mac', tone: 'danger', detail: 'It may be asleep, or the connection to it is down.' },
};

/** "3:42 PM" — when the unlock lapses if nothing is done. */
export function clockText(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function useStandalone(): boolean | null {
  const [standalone, setStandalone] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    void import('../pwa.js')
      .then((m) => {
        if (live) setStandalone(m.isStandalone());
      })
      .catch(() => {
        if (live) setStandalone(false);
      });
    return () => {
      live = false;
    };
  }, []);
  return standalone;
}

export function MoreScreen() {
  const { permissions, reachability, activity, navigate } = useMobile();
  const hold = useMutationHold();
  const theme = useTheme();
  const standalone = useStandalone();
  const [signOutOpen, setSignOutOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const [pushBusy, setPushBusy] = useState(false);
  const [pushKey, setPushKey] = useState<string | null>(null);
  const [pushMessage, setPushMessage] = useState<string | null>(null);
  const remote = isRemoteMobileMode();
  const pushAvailable = remote && currentRemoteSession()?.capabilities.push === true;
  const pushEligible = pushAvailable && supportsIphoneHomeScreenPush();
  useEffect(() => {
    if (!pushEligible) return;
    let live = true;
    void remotePushPublicKey().then((key) => { if (live) setPushKey(key); })
      .catch(() => { if (live) setPushMessage('The gateway notification key is unavailable.'); });
    return () => { live = false; };
  }, [pushEligible]);
  const canAct = canShowActions(permissions);

  const actWord = permissions.act === 'unavailable' ? 'Not on this device' : remote ? 'Passkey required' : permissions.act === 'unlocked' ? 'Unlocked' : 'Locked';
  const actTone: Tone = permissions.act === 'unlocked' ? 'success' : permissions.act === 'locked' ? 'warning' : 'neutral';
  const actDetail = remote && permissions.act !== 'unavailable'
    ? 'Higher-risk actions ask for a fresh passkey on this phone. Authority changes stay on your Mac.'
    : permissions.act === 'unlocked'
    ? hold.heldUntil !== null
      ? `Actions stay unlocked until ${clockText(hold.heldUntil)} if nothing is done — each action extends it.`
      : 'Actions are unlocked.'
    : permissions.act === 'locked'
      ? 'Needs the mutation token. Actions ask for it when you use one, or unlock now.'
      : permissions.actReason ?? 'This device can read but not act.';

  const unlock = () => {
    requestGuarded({
      title: 'Unlock actions',
      body: 'Unlocks approving, starting and stopping from this phone.',
      // The token sheet's button reads "Unlock and <label>": "Unlock and continue", not "Unlock and unlock".
      confirmLabel: 'Continue',
      destructive: false,
      token: true,
      tokenReason: 'Paste the mutation token `ashlr verse` printed on your Mac. It stays in this tab’s memory for 20 idle minutes and is never saved.',
      skipConfirm: true,
      run: async () => {},
      onDone: () => showMobileToast('Actions unlocked', 'success'),
    });
  };

  const lock = () => {
    clearMutationToken();
    showMobileToast('Actions locked', 'neutral');
  };

  const openDesktop = () => {
    writeVerseLayoutPreference('desktop');
    window.location.assign('/verse/');
  };

  const signOut = async () => {
    setSigningOut(true);
    setSignOutError(null);
    try {
      await clearReadSession();
      setSignOutOpen(false);
    } catch {
      setSignOutError('This phone could not sign out. Check the connection and try again.');
    } finally {
      setSigningOut(false);
    }
  };

  const enablePush = async () => {
    if (!pushEligible || !pushKey || pushBusy) return;
    setPushBusy(true);
    setPushMessage(null);
    try {
      await subscribeRemotePush(await enableRemotePush(pushKey));
      setPushMessage('Notifications are on. They only say that Verse has an update.');
    } catch (error) {
      setPushMessage(error instanceof Error ? error.message : 'Notifications could not be enabled.');
    } finally { setPushBusy(false); }
  };

  const reach = REACH[reachability];
  const reachDetail = reachability === 'offline' && activity.updatedAt === null
    ? 'This phone has no network. No update yet.'
    : reach.detail;

  return (
    <Screen title="More" large label="More">
      <Section title="This device">
        <Row title="Read" trailing={permissions.read ? 'Yes' : 'No'} subtitle={permissions.read ? undefined : 'Not signed in to your Mac.'} />
        <Row title="Act" subtitle={actDetail} trailing={<Badge tone={actTone}>{actWord}</Badge>} />
        <Row
          title="Signed in as"
          trailing={permissions.source === 'device' ? permissions.deviceLabel ?? 'A paired device' : 'This browser session'}
        />
      </Section>
      {!remote && permissions.act === 'unlocked' ? (
        <div className={styles.actions}><Button variant="secondary" block onClick={lock}>Lock now</Button></div>
      ) : !remote && permissions.act === 'locked' ? (
        <div className={styles.actions}><Button variant="tinted" block onClick={unlock}>Unlock</Button></div>
      ) : null}

      <Section title="Go to">
        <Row title="Fleet" subtitle={remote ? 'Status, budget and actions allowed by this gateway' : 'Start, pause or stop; budget mode; the grant'} onClick={() => navigate({ screen: 'fleet' })} />
        {canAct ? <Row title="New agent" subtitle="Start an agent on one of your repos" onClick={() => navigate({ screen: 'new' })} /> : null}
        <Row title="Needs you" subtitle="Approvals and questions waiting on you" onClick={() => navigate({ screen: 'needs' })} />
        {!remote ? <Row title="Use the desktop layout" subtitle="Open the full workbench in this browser" onClick={openDesktop} /> : null}
      </Section>

      {pushAvailable ? <Section title="Notifications" flat>
        <p className={ui.card}>Verse can send a generic alert when something needs you or a run completes. The alert contains no agent or repository details.</p>
        {pushEligible ? <Button variant="tinted" block disabled={pushBusy || !pushKey} onClick={() => void enablePush()}>{pushBusy ? 'Enabling…' : pushKey ? 'Enable notifications' : 'Preparing notifications…'}</Button>
          : <p className={ui.card}>Notifications require Verse installed on an iPhone Home Screen with Web Push support. You can still use Verse in this browser.</p>}
        {pushMessage ? <p role="status">{pushMessage}</p> : null}
      </Section> : null}

      <Section title="Appearance" flat>
        <div className={ui.chips} role="group" aria-label="Theme">
          {THEMES.map((t) => (
            <button key={t.value} type="button" className={ui.chip} aria-pressed={theme.theme === t.value} onClick={() => theme.set(t.value)}>
              {t.label}
            </button>
          ))}
        </div>
      </Section>

      <Section title="Install on your Home Screen" flat>
        {standalone ? (
          <p className={ui.card}>Installed — Verse is running from your Home Screen.</p>
        ) : (
          <div className={ui.card}>
            <p className={styles.lead}>Add Verse to your Home Screen and it opens full screen, like an app.</p>
            <ol className={styles.steps}>
              <li><strong>iPhone (Safari):</strong> tap Share, then Add to Home Screen.</li>
              <li><strong>Android (Chrome):</strong> open the menu button, then Install app.</li>
            </ol>
          </div>
        )}
      </Section>

      <Section title="Connection">
        <Row title="Your Mac" subtitle={reachDetail} trailing={<Badge tone={reach.tone}>{reach.word}</Badge>} />
      </Section>
      <div className={styles.actions}>
        <Button variant="destructiveTinted" block onClick={() => setSignOutOpen(true)}>Sign out of this device</Button>
      </div>

      <Section title="About">
        <Row title={APP_NAME} trailing={`Version ${APP_VERSION}`} />
      </Section>

      <BottomSheet
        open={signOutOpen}
        onClose={() => setSignOutOpen(false)}
        busy={signingOut}
        role="alertdialog"
        title="Sign out of this device?"
        footer={(
          <>
            <Button variant="destructive" block disabled={signingOut} onClick={() => void signOut()}>{signingOut ? 'Signing out…' : 'Sign out'}</Button>
            <Button variant="plain" block disabled={signingOut} onClick={() => setSignOutOpen(false)}>Cancel</Button>
          </>
        )}
      >
        <p className={ui.consequence}>{remote ? 'Signs this phone out. Use its approved passkey to sign in again. Nothing on your Mac changes.' : 'Signs this phone out. You’ll need the read token again. Nothing on your Mac changes.'}</p>
        {signOutError ? <p role="alert">{signOutError}</p> : null}
      </BottomSheet>
    </Screen>
  );
}
