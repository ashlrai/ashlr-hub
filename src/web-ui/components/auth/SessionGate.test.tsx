import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SessionGate } from './SessionGate.js';

const VALID_TOKEN = 'a'.repeat(64);

describe('SessionGate', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
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
