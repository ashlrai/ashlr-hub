import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SessionGate } from './SessionGate.js';
import { clearMutationToken, getMutationToken } from '../../data/auth-store.js';

const VALID_TOKEN = 'a'.repeat(64);

describe('SessionGate', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    clearMutationToken();
    delete window.__ASHLR_TOKENS__;
  });

  it('adopts host-injected window.__ASHLR_TOKENS__ without a paste and clears them from the page', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const mutation = 'f'.repeat(64);
    window.__ASHLR_TOKENS__ = { readToken: VALID_TOKEN, token: mutation };
    const onAuthenticated = vi.fn();

    render(<SessionGate onAuthenticated={onAuthenticated} />);

    await waitFor(() => expect(onAuthenticated).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/session');
    expect((init.headers as Record<string, string>)['x-ashlr-token']).toBe(VALID_TOKEN);
    expect(getMutationToken()).toBe(mutation);
    expect(window.__ASHLR_TOKENS__).toBeUndefined();
    expect(Object.values(sessionStorage)).not.toContain(VALID_TOKEN);
    expect(Object.values(localStorage)).not.toContain(mutation);
  });

  it('falls back to the paste flow when injected tokens are rejected', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }));
    window.__ASHLR_TOKENS__ = { readToken: VALID_TOKEN };
    const onAuthenticated = vi.fn();

    render(<SessionGate onAuthenticated={onAuthenticated} />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(onAuthenticated).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/read token/i)).toBeInTheDocument();
    expect(getMutationToken()).toBeNull();
  });

  it('can take the mutation token on the same screen and names the surface in its copy', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const onAuthenticated = vi.fn();
    const user = userEvent.setup();
    const mutation = 'e'.repeat(64);

    render(<SessionGate heading="Connect to Ashlr Verse" command="ashlr verse" subject="Ashlr Verse" mutationField onAuthenticated={onAuthenticated} />);
    expect(screen.queryByText(/This dashboard/)).not.toBeInTheDocument();
    expect(screen.getByText(/Ashlr Verse only ever talks/)).toBeInTheDocument();
    await user.type(screen.getByLabelText(/^read token/i), VALID_TOKEN);
    await user.type(screen.getByLabelText(/mutation token/i), mutation);
    await user.click(screen.getByRole('button', { name: /connect/i }));

    await waitFor(() => expect(onAuthenticated).toHaveBeenCalledTimes(1));
    expect(getMutationToken()).toBe(mutation);
    expect(Object.values(sessionStorage)).not.toContain(mutation);
  });

  it('rejects a malformed optional mutation token before any network call', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const user = userEvent.setup();
    render(<SessionGate mutationField />);
    await user.type(screen.getByLabelText(/^read token/i), VALID_TOKEN);
    await user.type(screen.getByLabelText(/mutation token/i), 'nope');
    await user.click(screen.getByRole('button', { name: /connect/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/mutation token/i);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getMutationToken()).toBeNull();
  });

  it('explains where to find the token instead of a bare 401', () => {
    render(<SessionGate />);
    expect(screen.getAllByText(/ashlr serve/).length).toBeGreaterThan(0);
    expect(screen.getByLabelText(/read token/i)).toBeInTheDocument();
  });

  it('submits the token via POST /api/session and calls onAuthenticated on success', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const onAuthenticated = vi.fn();
    const user = userEvent.setup();

    render(<SessionGate onAuthenticated={onAuthenticated} />);
    await user.type(screen.getByLabelText(/read token/i), VALID_TOKEN);
    await user.click(screen.getByRole('button', { name: /connect/i }));

    await waitFor(() => expect(onAuthenticated).toHaveBeenCalledTimes(1));

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/session');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-ashlr-token']).toBe(VALID_TOKEN);
    expect(headers['x-ashlr-read-client']).toMatch(/^[a-f0-9]{64}$/);
  });

  it('shows a real error message on a rejected token, not a bare 401', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }));
    const user = userEvent.setup();

    render(<SessionGate />);
    await user.type(screen.getByLabelText(/read token/i), VALID_TOKEN);
    await user.click(screen.getByRole('button', { name: /connect/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/rejected/i);
  });

  it('validates the token shape client-side before ever calling fetch', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const user = userEvent.setup();

    render(<SessionGate />);
    await user.type(screen.getByLabelText(/read token/i), 'not-a-real-token');
    await user.click(screen.getByRole('button', { name: /connect/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/64 hex/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
