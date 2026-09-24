/**
 * core/verse/attachments.ts — files the operator attaches to a chat
 * (SPEC-310C §2 "Composer"; unit C3).
 *
 * Upload, paste or drop in the composer → `POST /api/verse/attachments/:sid`
 * → one file under `~/.ashlr/verse/attachments/<sid>/`, directory 0700, file
 * 0600, never executable. The composer inserts the file's `@path` token into
 * the message; when the turn is sent the engine resolves every token that
 * names THIS chat's attachment directory (`resolveAttachmentRefs`) and grants
 * the CLI exactly that one directory (`--add-dir <dir>`) — not its parent, not
 * the other chats' folders, not the store root.
 *
 * Why a copy on disk rather than inline bytes: every CLI Verse drives already
 * knows how to read a file by path (claude's `@path` mentions and Read tool,
 * codex's shell, `--image`), and a path in the transcript stays meaningful
 * after the turn. The copy is private and is deleted with the chat.
 *
 * The token the composer sees is `~`-relative (every API response is passed
 * through sanitizePublicJson), so the resolver accepts both spellings and
 * always hands the CLI the absolute path — a CLI does not expand `~` inside a
 * prompt.
 */
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

import { writePrivateFileAtomically } from './session-store.js';
import {
  VERSE_ATTACHMENT_MAX_BYTES,
  type VerseAttachment,
  type VerseAttachmentUpload,
} from './workbench-types.js';

/** Files one chat may hold at once; the oldest must be removed first. */
export const VERSE_ATTACHMENTS_PER_SESSION = 24;
/** Bytes one chat may hold at once (3 × the per-file cap). */
export const VERSE_ATTACHMENTS_SESSION_BYTES = 3 * VERSE_ATTACHMENT_MAX_BYTES;
/** Longest display name kept (the stored name adds an 8-char prefix). */
const NAME_MAX = 120;
const MIME_RE = /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/i;
/** `<8 hex>-<safe name>` — what the directory may contain; anything else is ignored. */
const STORED_RE = /^([0-9a-f]{8})-([A-Za-z0-9._-]{1,140})$/;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/** Image types the vendor CLIs read as images (claude Read, codex `--image`). */
export const VERSE_IMAGE_MIMES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export class VerseAttachmentError extends Error {
  readonly code: 'VERSE_INVALID' | 'VERSE_TOO_LARGE' | 'VERSE_SESSION_BUSY';
  constructor(code: VerseAttachmentError['code'], message: string) {
    super(message);
    this.name = 'VerseAttachmentError';
    this.code = code;
  }
}

/**
 * A name safe on every filesystem and in every argv: path separators, control
 * characters, leading dots and anything outside a conservative set become
 * `_`, runs collapse, the extension survives truncation. Never empty.
 */
export function sanitizeAttachmentName(raw: string): string {
  const base = basename(String(raw ?? '').replace(/\\/g, '/'));
  let clean = base.normalize('NFKC').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/_+/g, '_').replace(/^[._]+/, '');
  if (clean.length > NAME_MAX) {
    const dot = clean.lastIndexOf('.');
    const ext = dot > 0 && clean.length - dot <= 12 ? clean.slice(dot) : '';
    clean = `${clean.slice(0, NAME_MAX - ext.length)}${ext}`;
  }
  return clean.length > 0 ? clean : 'attachment';
}

export interface AttachmentStoreOptions {
  now?: () => Date;
  /** Test seam for the random stored-name prefix. */
  randomId?: () => string;
}

export interface VerseAttachmentStore {
  /** `<root>/attachments/<sid>` — the ONE directory a turn with attachments is granted. */
  dirFor(sessionId: string): string;
  save(sessionId: string, upload: VerseAttachmentUpload): VerseAttachment;
  list(sessionId: string): VerseAttachment[];
  remove(sessionId: string, attachmentId: string): boolean;
  /** Delete the chat's whole directory (chat deleted). */
  drop(sessionId: string): void;
}

function decodeBase64(data: string): Buffer {
  const compact = data.replace(/\s+/g, '');
  // A data: URL prefix is accepted (the browser's FileReader hands one over).
  const payload = compact.startsWith('data:') ? compact.slice(compact.indexOf(',') + 1) : compact;
  if (payload.length % 4 !== 0 || !BASE64_RE.test(payload)) {
    throw new VerseAttachmentError('VERSE_INVALID', 'dataBase64 is not valid base64');
  }
  return Buffer.from(payload, 'base64');
}

export function createAttachmentStore(root: string, opts: AttachmentStoreOptions = {}): VerseAttachmentStore {
  const base = join(root, 'attachments');
  const now = opts.now ?? (() => new Date());
  const randomId = opts.randomId ?? (() => randomBytes(4).toString('hex'));

  function dirFor(sessionId: string): string {
    return join(base, sessionId);
  }

  function describe(sessionId: string, stored: string): VerseAttachment | null {
    const match = STORED_RE.exec(stored);
    if (!match) return null;
    const path = join(dirFor(sessionId), stored);
    let stat;
    try {
      stat = lstatSync(path);
    } catch {
      return null;
    }
    // A symlink planted in the directory is never offered or granted.
    if (!stat.isFile()) return null;
    const name = match[2]!;
    return {
      id: match[1]!,
      sessionId,
      name,
      mime: mimeFromName(name),
      bytes: stat.size,
      ref: `@${path}`,
      createdAt: new Date(stat.birthtimeMs || stat.mtimeMs).toISOString(),
    };
  }

  function list(sessionId: string): VerseAttachment[] {
    const dir = dirFor(sessionId);
    if (!existsSync(dir)) return [];
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return [];
    }
    return names
      .map((name) => describe(sessionId, name))
      .filter((item): item is VerseAttachment => item !== null)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  }

  return {
    dirFor,
    list,

    save(sessionId: string, upload: VerseAttachmentUpload): VerseAttachment {
      if (typeof upload?.name !== 'string' || upload.name.trim().length === 0) {
        throw new VerseAttachmentError('VERSE_INVALID', 'name is required');
      }
      if (typeof upload.mime !== 'string' || !MIME_RE.test(upload.mime.trim())) {
        throw new VerseAttachmentError('VERSE_INVALID', 'mime must be a media type such as image/png');
      }
      if (typeof upload.dataBase64 !== 'string') {
        throw new VerseAttachmentError('VERSE_INVALID', 'dataBase64 is required');
      }
      // Cheap upper bound before decoding: base64 is 4 chars per 3 bytes.
      if (Math.floor((upload.dataBase64.length * 3) / 4) > VERSE_ATTACHMENT_MAX_BYTES + 3) {
        throw new VerseAttachmentError('VERSE_TOO_LARGE', `each file must be ${formatMb(VERSE_ATTACHMENT_MAX_BYTES)} or smaller`);
      }
      const bytes = decodeBase64(upload.dataBase64);
      if (bytes.length === 0) throw new VerseAttachmentError('VERSE_INVALID', 'the file is empty');
      if (bytes.length > VERSE_ATTACHMENT_MAX_BYTES) {
        throw new VerseAttachmentError('VERSE_TOO_LARGE', `each file must be ${formatMb(VERSE_ATTACHMENT_MAX_BYTES)} or smaller`);
      }
      const existing = list(sessionId);
      if (existing.length >= VERSE_ATTACHMENTS_PER_SESSION) {
        throw new VerseAttachmentError('VERSE_INVALID', `a chat holds at most ${VERSE_ATTACHMENTS_PER_SESSION} attachments — remove one first`);
      }
      const held = existing.reduce((sum, item) => sum + item.bytes, 0);
      if (held + bytes.length > VERSE_ATTACHMENTS_SESSION_BYTES) {
        throw new VerseAttachmentError('VERSE_TOO_LARGE', `a chat holds at most ${formatMb(VERSE_ATTACHMENTS_SESSION_BYTES)} of attachments — remove one first`);
      }
      let name = sanitizeAttachmentName(upload.name);
      // Give an image pasted as "image.png" with the wrong extension the right one.
      const wanted = extensionForMime(upload.mime.trim().toLowerCase());
      if (wanted && !name.toLowerCase().endsWith(wanted)) name = `${name.replace(/\.[A-Za-z0-9]{1,8}$/, '')}${wanted}`;
      let id = randomId();
      if (!/^[0-9a-f]{8}$/.test(id)) id = randomBytes(4).toString('hex');
      const dir = dirFor(sessionId);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      try { chmodSync(dir, 0o700); } catch { /* best effort on exotic filesystems */ }
      const stored = `${id}-${name}`;
      const path = join(dir, stored);
      writePrivateFileAtomically(dir, path, bytes);
      const item = describe(sessionId, stored);
      if (!item) throw new VerseAttachmentError('VERSE_INVALID', 'the attachment could not be stored');
      return { ...item, mime: upload.mime.trim().toLowerCase(), createdAt: now().toISOString() };
    },

    remove(sessionId: string, attachmentId: string): boolean {
      if (!/^[0-9a-f]{8}$/.test(attachmentId)) return false;
      const dir = dirFor(sessionId);
      if (!existsSync(dir)) return false;
      for (const name of readdirSync(dir)) {
        if (name.startsWith(`${attachmentId}-`) && STORED_RE.test(name)) {
          rmSync(join(dir, name), { force: true });
          return true;
        }
      }
      return false;
    },

    drop(sessionId: string): void {
      try { rmSync(dirFor(sessionId), { recursive: true, force: true }); } catch { /* best effort */ }
    },
  };
}

function formatMb(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

const EXT_MIME: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.svg': 'image/svg+xml',
};

function mimeFromName(name: string): string {
  const dot = name.lastIndexOf('.');
  return (dot >= 0 ? EXT_MIME[name.slice(dot).toLowerCase()] : undefined) ?? 'application/octet-stream';
}

/** True for an attachment the CLIs read as an image (by its stored extension). */
export function isImageAttachment(path: string): boolean {
  return VERSE_IMAGE_MIMES.has(mimeFromName(basename(path)));
}

function extensionForMime(mime: string): string | null {
  switch (mime) {
    case 'image/png': return '.png';
    case 'image/jpeg': return '.jpg';
    case 'image/gif': return '.gif';
    case 'image/webp': return '.webp';
    default: return null;
  }
}

// ---------------------------------------------------------------------------
// Turn-time resolution
// ---------------------------------------------------------------------------

export interface ResolvedAttachments {
  /** The text with every recognised token rewritten to its absolute path. */
  text: string;
  /** Absolute paths of the files the text names (existing regular files only). */
  files: string[];
  /** `[dir]` when `files` is non-empty, else `[]` — the exact `--add-dir`. */
  dirs: string[];
}

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Find `@<this chat's attachment dir>/<stored name>` tokens in the message —
 * written with the absolute path or the `~` spelling the API showed — and
 * rewrite them to the absolute path. A token naming a file that no longer
 * exists (removed, or another chat's folder) is left exactly as typed and
 * grants nothing.
 */
export function resolveAttachmentRefs(text: string, dir: string, home: string = homedir()): ResolvedAttachments {
  const spellings = [dir];
  if (home && dir.startsWith(`${home}/`)) spellings.push(`~${dir.slice(home.length)}`);
  const pattern = new RegExp(`@(${spellings.map(escapeRe).join('|')})/([0-9a-f]{8}-[A-Za-z0-9._-]{1,140})`, 'g');
  const files: string[] = [];
  const out = text.replace(pattern, (whole, _prefix: string, stored: string) => {
    // A trailing sentence period is punctuation, not part of the name.
    let name = stored;
    let tail = '';
    while (name.endsWith('.') && !isRegularFile(join(dir, name))) {
      name = name.slice(0, -1);
      tail = `.${tail}`;
    }
    const abs = join(dir, name);
    if (!STORED_RE.test(name) || !isRegularFile(abs)) return whole;
    if (!files.includes(abs)) files.push(abs);
    return `@${abs}${tail}`;
  });
  return { text: out, files, dirs: files.length > 0 ? [dir] : [] };
}

function isRegularFile(path: string): boolean {
  try {
    return lstatSync(path).isFile() && statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * `@~/…` mentions of files in the chat's OTHER roots (the `@` finder shows
 * those `~`-relative, like every API response) become absolute before the
 * CLI sees them — a CLI does not expand `~` inside a prompt. Only a path that
 * lands inside one of the chat's own roots is touched; anything else is left
 * exactly as typed and grants nothing (the roots are already granted).
 */
export function expandHomeMentions(text: string, roots: readonly string[], home: string = homedir()): string {
  if (!home || !text.includes('@~/')) return text;
  return text.replace(/@~\/([^\s'"`<>()[\]{}]+)/g, (whole, rest: string) => {
    const abs = `${home}/${rest}`;
    const inside = roots.some((root) => abs === root || abs.startsWith(`${root}/`));
    return inside && !rest.split('/').includes('..') ? `@${abs}` : whole;
  });
}

