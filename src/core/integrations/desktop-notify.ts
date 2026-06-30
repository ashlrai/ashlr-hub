/**
 * M32/M94: desktop notifications — macOS + Windows + Linux, opt-in, metadata only.
 *
 * Strict no-op unless BOTH hold: cfg.notify.desktop === true AND the current
 * platform is supported. Opt-in mirrors the webhook contract — when unset,
 * nothing fires. Uses execFile (never a shell) on all platforms, with
 * platform-specific arg escaping and a never-throws contract.
 *
 * Platform dispatch:
 *   darwin  — osascript -e 'display notification "<body>" with title "<title>"'
 *   win32   — PowerShell Windows.UI.Notifications toast (no BurntToast dep)
 *   linux   — notify-send "<title>" "<body>" (no-op if binary absent)
 *
 * An optional `launchUri` deep-links the toast back to a target (e.g. the
 * project's editor window) so a "Claude finished" toast is clickable. It is
 * honored on Windows only — the toast becomes protocol-activated and gains an
 * explicit action button; macOS `display notification` and Linux `notify-send`
 * have no click target and ignore it.
 */

import { execFile } from 'node:child_process';
import type { AshlrConfig, NotifyTarget } from '../types.js';

const NOTIFY_TIMEOUT_MS = 2_000;
// WinRT assembly load + toast show is heavier than osascript/notify-send; give
// the PowerShell path headroom so a cold start does not spuriously time out.
const WINDOWS_TOAST_TIMEOUT_MS = 8_000;

/** Options for a desktop notification. */
export interface DesktopNotifyOpts {
  /** Protocol URI activated when the toast is clicked (Windows only). */
  launchUri?: string;
  /** Label for the explicit "open" action button (Windows only). */
  openLabel?: string;
}

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
 * Newlines are collapsed to a space so the injected literal stays on one line.
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

/** XML-escape a value for a toast XML text node or attribute. */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ---------------------------------------------------------------------------
// Platform support check
// ---------------------------------------------------------------------------

type SupportedPlatform = 'darwin' | 'win32' | 'linux';

function isSupportedPlatform(p: string): p is SupportedPlatform {
  return p === 'darwin' || p === 'win32' || p === 'linux';
}

// ---------------------------------------------------------------------------
// Windows toast builders (pure — exported for tests)
// ---------------------------------------------------------------------------

/**
 * Build the toast XML document. Title/body and the optional launch URI are
 * XML-escaped. When `launchUri` is set the whole toast is protocol-activated
 * (clicking anywhere opens it) and an explicit action button is added;
 * otherwise it is an informational toast with no click target.
 */
export function buildWindowsToastXml(
  title: string,
  body: string,
  opts: DesktopNotifyOpts = {},
): string {
  const launch = opts.launchUri ? escapeXml(opts.launchUri) : '';
  const actions = opts.launchUri
    ? `<actions><action content="${escapeXml(opts.openLabel ?? 'Open')}" ` +
      `activationType="protocol" arguments="${launch}"/></actions>`
    : '';
  return (
    `<toast activationType="protocol" launch="${launch}">` +
    `<visual><binding template="ToastGeneric">` +
    `<text>${escapeXml(title)}</text>` +
    `<text>${escapeXml(body)}</text>` +
    `</binding></visual>` +
    actions +
    `<audio src="ms-winsoundevent:Notification.Default"/>` +
    `</toast>`
  );
}

// AUMID of the built-in Windows PowerShell host — lets the toast render without
// registering a bespoke app id (an unregistered AUMID often shows nothing).
const TOAST_APP_ID =
  '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';

/**
 * Build the PowerShell `-Command` script that shows the toast. The toast XML is
 * injected as a single-quoted PS literal so no metacharacter in the
 * title/body/URI can break out of the string.
 */
export function buildWindowsToastScript(xml: string): string {
  const xmlLit = escapePowerShell(xml);
  const appId = escapePowerShell(TOAST_APP_ID);
  return [
    `$ErrorActionPreference='SilentlyContinue'`,
    `[Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime]|Out-Null`,
    `[Windows.Data.Xml.Dom.XmlDocument,Windows.Data.Xml.Dom,ContentType=WindowsRuntime]|Out-Null`,
    `$doc=New-Object Windows.Data.Xml.Dom.XmlDocument`,
    `$doc.LoadXml('${xmlLit}')`,
    `$toast=[Windows.UI.Notifications.ToastNotification]::new($doc)`,
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${appId}').Show($toast)`,
  ].join('; ');
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
export function desktopNotify(
  title: string,
  body: string,
  cfg: AshlrConfig,
  opts: DesktopNotifyOpts = {},
): Promise<boolean> {
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
        // The XML is built then injected as a single-quoted PS literal.
        const xml = buildWindowsToastXml(title, body, opts);
        const psScript = buildWindowsToastScript(xml);
        execFile(
          'powershell',
          ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psScript],
          { timeout: WINDOWS_TOAST_TIMEOUT_MS, windowsHide: true },
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
