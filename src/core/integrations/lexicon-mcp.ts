import { isAbsolute, join, relative } from 'node:path';

export interface LexiconMcpBinding {
  projectRoot: string;
  client: string;
  command: string;
  launch: 'stdio' | 'cli';
}

/** Names and paths only. Does not read vocabulary, create trust, or start a server. */
export function lexiconServerSpec(binding: LexiconMcpBinding): {
  command: string; args: string[]; env: Record<string, string>;
} {
  if (!isAbsolute(binding.projectRoot) || /[\r\n\0]/.test(binding.projectRoot)) {
    throw new Error('Lexicon requires an absolute project root');
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(binding.client)) {
    throw new Error('Lexicon requires a client identifier (letters, numbers, dot, dash or underscore)');
  }
  if (!isAbsolute(binding.command) || /[\r\n\0]/.test(binding.command)) {
    throw new Error('Lexicon requires an exact absolute installed executable');
  }
  return {
    command: binding.command,
    args: binding.launch === 'cli' ? ['mcp'] : [],
    env: {
      LEXICON_CWD: binding.projectRoot,
      // Lexicon keeps trust.json beside this global vocabulary; scope both to this client/project.
      LEXICON_PATH: join(binding.projectRoot, '.phantom', 'lexicon', binding.client, 'lexicon.yaml'),
    },
  };
}

export function pathWithinProject(projectRoot: string, candidate: string): boolean {
  const rel = relative(projectRoot, candidate);
  return rel !== '' && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\') && !isAbsolute(rel);
}
