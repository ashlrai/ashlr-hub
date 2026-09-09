'use client';
import { useState } from 'react';

export function CopyCommand({ command }: { command: string }) {
  const [status, setStatus] = useState('');
  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      setStatus('Copied. Review the commands before running them locally.');
    } catch {
      setStatus('Clipboard unavailable. Select and copy the commands below.');
    }
  }
  return (
    <div className="copy-controls">
      <button type="button" onClick={copy}>
        Copy commands
      </button>
      <output>{status}</output>
    </div>
  );
}
