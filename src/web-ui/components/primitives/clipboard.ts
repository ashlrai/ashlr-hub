/**
 * components/primitives/clipboard.ts — copy text, honestly.
 *
 * The async Clipboard API where the page is allowed it (a secure context,
 * which the desktop webview and localhost are), else a hidden-textarea copy.
 * Resolves false when both fail, so a caller can say "copy failed" instead of
 * drawing a check. Style-free on purpose: importing it costs no CSS.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the textarea path
  }
  if (typeof document === 'undefined') return false;
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  let ok = false;
  try {
    ok = typeof document.execCommand === 'function' && document.execCommand('copy');
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}
