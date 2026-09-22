/**
 * McpServerDisclosure.test.tsx — the card an operator has to read before an
 * MCP server is installed.
 *
 * Pinned here are the three ways a convenient rendering would undersell what
 * is about to run with the agent's privileges: a truncated command, a hidden
 * environment hand-off, and a secret printed because the component trusted
 * what it was handed.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { McpServerDisclosure } from './McpServerDisclosure.js';
import { narrowServer, type McpServer } from './mcp-contract.js';

function server(over: Partial<McpServer> = {}): McpServer {
  return {
    name: 'weather',
    command: '/usr/local/bin/weather-mcp',
    args: ['--serve', '--port', '7333'],
    env: null,
    sourceRef: '.ashlr/settings.json',
    ...over,
  };
}

describe('McpServerDisclosure', () => {
  it('shows the whole command line, not an abbreviation of it', () => {
    render(<McpServerDisclosure server={server()} />);
    expect(
      screen.getByText('/usr/local/bin/weather-mcp --serve --port 7333'),
    ).toBeInTheDocument();
  });

  it('names every environment key and states how many there are', () => {
    render(<McpServerDisclosure server={server({ env: { API_KEY: '<set>', REGION: '<set>' } })} />);
    expect(screen.getByText(/2 environment variables passed/)).toBeInTheDocument();
    expect(screen.getByText('API_KEY=<set>')).toBeInTheDocument();
    expect(screen.getByText('REGION=<set>')).toBeInTheDocument();
  });

  it('says so plainly when no environment is handed over', () => {
    render(<McpServerDisclosure server={server()} />);
    expect(screen.getByText(/No environment variables are passed/)).toBeInTheDocument();
  });

  it('cannot print a secret, even one handed to it directly', () => {
    // The projection is what enforces this, so the component is rendered
    // through it exactly as the real section does.
    const narrowed = narrowServer({
      name: 'weather',
      command: '/usr/local/bin/weather-mcp',
      args: [],
      env: { API_KEY: 'REDACTION-CANARY-C' },
      sourceRef: '.ashlr/settings.json',
    })!;
    const { container } = render(<McpServerDisclosure server={narrowed} />);
    expect(container.textContent).not.toContain('REDACTION-CANARY-C');
    expect(screen.getByText('API_KEY=<set>')).toBeInTheDocument();
  });

  it('names the config file without ever showing an absolute path', () => {
    const { container } = render(<McpServerDisclosure server={server()} />);
    expect(screen.getByText('configured in .ashlr/settings.json')).toBeInTheDocument();
    expect(container.textContent).not.toContain('/Users/');
  });
});
