/**
 * resources-store — open / pinned, persisted per viewer (unit 3.11 C6).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  closeResources,
  getResourcesUi,
  openResources,
  reloadResourcesUiForTest,
  RESOURCES_STORAGE_KEY,
  setResourcesPinned,
  setResourcesSummary,
  toggleResources,
} from './resources-store.js';

beforeEach(() => {
  localStorage.clear();
  reloadResourcesUiForTest();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resources-store', () => {
  it('starts closed and unpinned', () => {
    expect(getResourcesUi()).toMatchObject({ open: false, pinned: false, summary: null });
  });

  it('opens, closes and toggles', () => {
    openResources();
    expect(getResourcesUi().open).toBe(true);
    toggleResources();
    expect(getResourcesUi().open).toBe(false);
    toggleResources();
    closeResources();
    expect(getResourcesUi().open).toBe(false);
  });

  it('comes back docked after a reload when it was PINNED open', () => {
    setResourcesPinned(true);
    openResources();
    expect(JSON.parse(localStorage.getItem(RESOURCES_STORAGE_KEY)!)).toEqual({ open: true, pinned: true });
    reloadResourcesUiForTest();
    expect(getResourcesUi()).toMatchObject({ open: true, pinned: true });
  });

  it('never restores a floating overlay on reload (it would steal focus), but keeps the pin preference', () => {
    openResources();
    reloadResourcesUiForTest();
    expect(getResourcesUi()).toMatchObject({ open: false, pinned: false });
    setResourcesPinned(true);
    closeResources();
    reloadResourcesUiForTest();
    expect(getResourcesUi()).toMatchObject({ open: false, pinned: true });
  });

  it('survives storage that throws (a private window) and garbage in storage', () => {
    localStorage.setItem(RESOURCES_STORAGE_KEY, '{nope');
    reloadResourcesUiForTest();
    expect(getResourcesUi()).toMatchObject({ open: false, pinned: false });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    expect(() => openResources()).not.toThrow();
    expect(getResourcesUi().open).toBe(true);
    expect(() => reloadResourcesUiForTest()).not.toThrow();
    expect(getResourcesUi().open).toBe(false);
  });

  it('keeps the summary out of storage and only notifies on a real change', () => {
    setResourcesSummary({ tone: 'alert', spoken: '1 spent' });
    const first = getResourcesUi();
    setResourcesSummary({ tone: 'alert', spoken: '1 spent' });
    expect(getResourcesUi()).toBe(first);
    expect(localStorage.getItem(RESOURCES_STORAGE_KEY)).toBeNull();
  });
});
