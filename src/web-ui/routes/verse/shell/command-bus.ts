/**
 * routes/verse/shell/command-bus.ts — how a catalog command reaches the unit
 * that owns its behaviour (unit C1; the keys and titles are C0's
 * command-catalog.ts).
 *
 * The catalog is one table; the behaviour behind it is spread over units:
 * the shell runs the global commands, the chat (C2) runs `dock.*` and
 * `chat.*`, the composer (C3) runs `composer.*`. The palette, the desktop
 * menu bridge and the shell's key handler all call `runCommand(id)`; the
 * owning unit registers a handler for the ids it serves:
 *
 *   useCommandHandler('dock.terminal', () => openDockPane('terminal'));
 *
 * A handler may return `false` to decline (e.g. a composer command with no
 * chat open), and the most recently registered handler for an id is asked
 * first — a mounted chat outranks nothing, a focused one outranks a hidden
 * one because it registers last.
 *
 * DELIVERY LATER. A chat command run from another surface (⌘K "Terminal"
 * while on Fleet) has no handler until Chat mounts. The shell switches to
 * Chat and parks the command with `runCommandWhenReady`; the first handler to
 * register for that id within the window receives it. Parked commands expire
 * — a command that runs 20 s after the operator asked for it is a surprise,
 * not a feature.
 *
 * Framework-free except the one hook at the bottom.
 */
import { useEffect, useRef } from 'react';

/** What a palette argument (Tab) filled in, or what a caller passes along. */
export interface CommandArgument {
  kind: 'seat' | 'project' | 'section' | 'session';
  id: string;
  label: string;
}

export interface CommandInvocation {
  argument?: CommandArgument;
  /** Where it came from — handlers may word a toast differently for a key press. */
  via?: 'palette' | 'key' | 'menu' | 'button';
}

/** Return false to decline (the next handler is asked); anything else = handled. */
export type CommandHandler = (invocation: CommandInvocation) => void | boolean;

const handlers = new Map<string, CommandHandler[]>();

interface Parked {
  id: string;
  invocation: CommandInvocation;
  until: number;
}

let parked: Parked | null = null;

export const PARKED_COMMAND_TTL_MS = 4_000;

function deliverParked(id: string): void {
  if (!parked || parked.id !== id) return;
  if (Date.now() > parked.until) {
    parked = null;
    return;
  }
  const { invocation } = parked;
  parked = null;
  // After the registering effect has finished: the handler's own component
  // is mounted, but its sibling effects may not have run yet.
  queueMicrotask(() => {
    runCommand(id, invocation);
  });
}

/** Register `handler` for command `id`. Returns the unregister function. */
export function registerCommandHandler(id: string, handler: CommandHandler): () => void {
  const list = handlers.get(id) ?? [];
  list.push(handler);
  handlers.set(id, list);
  deliverParked(id);
  return () => {
    const current = handlers.get(id);
    if (!current) return;
    const index = current.lastIndexOf(handler);
    if (index >= 0) current.splice(index, 1);
    if (current.length === 0) handlers.delete(id);
  };
}

export function hasCommandHandler(id: string): boolean {
  return (handlers.get(id)?.length ?? 0) > 0;
}

/** Run `id` now. True when a handler took it. */
export function runCommand(id: string, invocation: CommandInvocation = {}): boolean {
  const list = handlers.get(id);
  if (!list) return false;
  for (const handler of [...list].reverse()) {
    try {
      if (handler(invocation) !== false) return true;
    } catch (err) {
      // A broken handler must not take the palette or the key handler down.
      console.error(`[verse] command ${id} failed`, err);
      return true;
    }
  }
  return false;
}

/** Run `id` now if someone serves it, else hold it for the next handler to register (within the TTL). */
export function runCommandWhenReady(id: string, invocation: CommandInvocation = {}, ttlMs: number = PARKED_COMMAND_TTL_MS): boolean {
  if (runCommand(id, invocation)) return true;
  parked = { id, invocation, until: Date.now() + ttlMs };
  return false;
}

/** Test hygiene. */
export function resetCommandBus(): void {
  handlers.clear();
  parked = null;
}

/**
 * Serve command `id` while mounted (and `enabled`). The latest `handler` is
 * always the one called, so an inline closure does not re-register each render.
 */
export function useCommandHandler(id: string, handler: CommandHandler, enabled = true): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!enabled) return;
    return registerCommandHandler(id, (invocation) => ref.current(invocation));
  }, [id, enabled]);
}
