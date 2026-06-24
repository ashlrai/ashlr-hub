/**
 * M32/M94: desktop notifications — macOS + Windows + Linux, opt-in, metadata only.
 *
 * Strict no-op unless BOTH hold: cfg.notify.desktop === true AND the current
 * platform is supported. Opt-in mirrors the webhook contract — when unset,
 * nothing fires. Uses execFile (never a shell) on all platforms, with
 * platform-specific arg escaping, a 2s timeout, and a never-throws contract.
 *
 * Platform dispatch:
 *   darwin  — osascript -e 'display notification "<body>" with title "<title>"'
 *   win32   — PowerShell Windows.UI.Notifications toast (no BurntToast dep)
 *   linux   — notify-send "<title>" "<body>" (no-op if binary absent)
 */

import { execFile } from 'node:child_process';
import type { AshlrConfig, NotifyTarget } from '../types.js';

const NOTIFY_TIMEOUT_MS = 2_000;

// ---------------------------------------------------------------------------
// Escaping helpers — one per target scripting context
// ---------------------------------------------------------------------------

/** Escape for inclusion inside an AppleScript double-quoted string literal. */
function escapeAppleScript(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ');
}

/**
 * Escape for a PowerShell single-quoted string literal ('…').
 * The only character that needs escaping inside PS single-quotes is a single
 * quote itself, which is doubled: ' → ''.
 * Newlines are collapsed to a space so the toast body stays on one line.
 */
function escapePowerShell(s: string): string {
  return s.replace(/'/g, "''").replace(/\n/g, ' ');
}

/**
 * Escape for a notify-send argument passed via execFile (no shell expansion).
 * execFile passes args directly to the binary — no shell involved — so the
 * only risk is control characters. We strip NUL and collapse newlines.
 */
function escapeNotifySend(s: string): string {
  // execFile does NOT invoke a shell, so no shell metacharacter risk.
  // Collapse newlines so the summary/body stay readable.
  return s.replace(/\0/g, '').replace(/\n/g, ' ');
}

// ---------------------------------------------------------------------------
// Platform support check
// ---------------------------------------------------------------------------

type SupportedPlatform = 'darwin' | 'win32' | 'linux';

function isSupportedPlatform(p: string): p is SupportedPlatform {
  return p === 'darwin' || p === 'win32' || p === 'linux';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** True when desktop notifications are enabled by config + platform. */
export function desktopNotifyEnabled(cfg: AshlrConfig): boolean {
  if (!isSupportedPlatform(process.platform)) return false;
  const notifyTarget = (cfg as AshlrConfig & { notify?: NotifyTarget }).notify;
  return notifyTarget?.desktop === true;
}

/**
 * Show a desktop notification. Resolves true when the OS notification tool
 * ran successfully, false otherwise (disabled / unsupported platform / missing
 * tool / timeout). NEVER throws; NEVER blocks beyond the timeout.
 */
export function desktopNotify(title: string, body: string, cfg: AshlrConfig): Promise<boolean> {
  if (!desktopNotifyEnabled(cfg)) return Promise.resolve(false);

  const platform = process.platform as SupportedPlatform;

  return new Promise<boolean>((resolve) => {
    try {
      if (platform === 'darwin') {
        const script =
          `display notification "${escapeAppleScript(body)}" ` +
          `with title "${escapeAppleScript(title)}"`;
        execFile('osascript', ['-e', script], { timeout: NOTIFY_TIMEOUT_MS }, (err) =>
          resolve(!err),
        );
      } else if (platform === 'win32') {
        // BurntToast-free toast using Windows.UI.Notifications via PowerShell.
        // Single-quoted PS literals sidestep variable/backtick expansion.
        const psTitle = escapePowerShell(title);
        const psBody = escapePowerShell(body);
        const psScript = [
          `[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null`,
          `[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null`,
          `$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)`,
          `$xml.SelectSingleNode('//text[@id=1]').InnerText = '${psTitle}'`,
          `$xml.SelectSingleNode('//text[@id=2]').InnerText = '${psBody}'`,
          `$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)`,
          `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('ashlr').Show($toast)`,
        ].join('; ');
        execFile(
          'powershell',
          ['-NoProfile', '-NonInteractive', '-Command', psScript],
          { timeout: NOTIFY_TIMEOUT_MS },
          (err) => resolve(!err),
        );
      } else {
        // linux
        execFile(
          'notify-send',
          [escapeNotifySend(title), escapeNotifySend(body)],
          { timeout: NOTIFY_TIMEOUT_MS },
          (err) => resolve(!err),
        );
      }
    } catch {
      resolve(false);
    }
  });
}
