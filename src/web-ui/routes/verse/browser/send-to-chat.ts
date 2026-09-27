/**
 * routes/verse/browser/send-to-chat.ts — "Send to chat": what the Browser
 * pane captured, drafted into the chat's composer. Never sent — the
 * operator's press is the send (composer-bridge.ts).
 *
 * A screenshot becomes a real attachment first (POST /api/verse/attachments,
 * ≤ 8 MB, the same store the composer's paperclip uses); its `@path` ref goes
 * into the draft, which is what makes the seat read the file at turn time
 * (attachments.ts resolveAttachmentRefs). Logs, the page and a picked element
 * go in as text, fenced so a page's own backticks cannot break out.
 */
import type { VerseAttachment, VerseAttachmentUpload } from '../../../../core/verse/workbench-types.js';
import { VERSE_ATTACHMENT_MAX_BYTES } from '../../../../core/verse/workbench-types.js';
import {
  formatBrowserConsole,
  type VerseBrowserConsoleEntry,
  type VerseBrowserNetworkEntry,
} from '../../../../core/verse/browser-types.js';

export interface BrowserScreenshot {
  mime: 'image/png' | 'image/jpeg';
  base64: string;
  width: number | null;
  height: number | null;
}

export interface PickedElement {
  selector: string;
  html: string;
  text?: string;
}

export interface BrowserCapture {
  url: string | null;
  title: string | null;
  screenshot?: BrowserScreenshot | null;
  console?: VerseBrowserConsoleEntry[] | null;
  network?: VerseBrowserNetworkEntry[] | null;
  element?: PickedElement | null;
  /** Said in the draft when part of the capture was not possible (e.g. no screenshots in a browser tab). */
  notes?: string[];
}

/** A fence longer than any backtick run inside `body`, so page text cannot close it. */
export function fence(body: string, lang = ''): string {
  let longest = 0;
  for (const m of body.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  const ticks = '`'.repeat(Math.max(3, longest + 1));
  return `${ticks}${lang}\n${body.replace(/\s+$/, '')}\n${ticks}`;
}

/** Approximate decoded size of a base64 payload. */
export function base64Bytes(b64: string): number {
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - pad;
}

/** `browser-localhost-5173-20260927-101500.png` — ASCII, the attachment store's name rules. */
export function screenshotName(url: string | null, mime: BrowserScreenshot['mime'], now: Date): string {
  let host = 'page';
  try {
    if (url) host = new URL(url).host.replace(/[^A-Za-z0-9.-]+/g, '-');
  } catch {
    /* keep 'page' */
  }
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  return `browser-${host.slice(0, 60)}-${stamp}.${mime === 'image/jpeg' ? 'jpg' : 'png'}`;
}

/** The draft text for a capture (the attachment ref, when there is one, goes first). */
export function buildSendToChatText(capture: BrowserCapture, attachmentRef: string | null): string {
  const parts: string[] = [];
  const where = capture.url
    ? `${capture.title ? `“${capture.title.slice(0, 120)}” — ` : ''}${capture.url}`
    : 'the Browser pane';
  parts.push(`From the Browser pane: ${where}`);
  if (attachmentRef) parts.push(`Screenshot: ${attachmentRef}`);
  if (capture.element) {
    parts.push(`Selected element \`${capture.element.selector.replace(/`/g, '')}\`:\n${fence(capture.element.html, 'html')}`);
  }
  if (capture.console || capture.network) {
    parts.push(fence(formatBrowserConsole(capture.console ?? [], capture.network ?? [], 40), 'text'));
  }
  for (const note of capture.notes ?? []) parts.push(`(${note})`);
  return parts.join('\n\n');
}

export interface SendToChatDeps {
  attach(sessionId: string, upload: VerseAttachmentUpload): Promise<VerseAttachment>;
  insert(sessionId: string, text: string): boolean;
  now(): Date;
}

export type SendToChatResult =
  | { ok: true; attached: boolean }
  | { ok: false; message: string };

/**
 * Upload the screenshot (if any), then draft everything into the composer.
 * A screenshot that is too large or fails to upload does not lose the rest:
 * the draft goes in with a note saying what was left out.
 */
export async function sendCaptureToChat(sessionId: string, capture: BrowserCapture, deps: SendToChatDeps): Promise<SendToChatResult> {
  let ref: string | null = null;
  const notes = [...(capture.notes ?? [])];
  const shot = capture.screenshot;
  if (shot) {
    if (base64Bytes(shot.base64) > VERSE_ATTACHMENT_MAX_BYTES) {
      notes.push('the screenshot was larger than 8 MB and was left out');
    } else {
      try {
        const saved = await deps.attach(sessionId, { name: screenshotName(capture.url, shot.mime, deps.now()), mime: shot.mime, dataBase64: shot.base64 });
        ref = saved.ref;
      } catch (err) {
        // A locked token is the caller's to handle (it opens the unlock dialog).
        if (err instanceof Error && err.name === 'VerseMutationLockedError') throw err;
        notes.push('the screenshot could not be attached');
      }
    }
  }
  const text = buildSendToChatText({ ...capture, notes }, ref);
  if (!deps.insert(sessionId, text)) {
    return { ok: false, message: 'No message box is open for this chat — open the chat, then send again.' };
  }
  return { ok: true, attached: ref !== null };
}
