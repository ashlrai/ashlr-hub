import { resourceCheckOptions, resourceCheckPath, ResourceCheckUsageError } from './resource-check-options.js';

const USAGE = `usage: ashlr resources launcher check --provider codex|claude|grok
  --command ABS_JSON --cwd ABS_PRIVATE_DIR [--timeout-ms 1..30000] [--json]

Runs only help/version arguments through one explicitly selected trusted launcher.
--command is an owned private JSON file containing an absolute executable argv
array, not shell text. --cwd must be an existing private canonical directory.
Wrappers must forward arguments; their behavior is operator-trusted. Native
configuration/cache side effects are not attested by a help-only check.
No login, auth status, model prompt, quota probe, API fallback or update is requested.
Supported means required flags advertised, not working argument combinations,
minimum-version proof when version is unknown, or authenticated model execution.
Grok's upstream ACP evidence is separate: Hub's Grok transport is not implemented.
No report, enrollment, ledger or service is installed. Exit codes: 0 required
flags advertised for a Hub transport, 1 incompatible/unavailable,
2 invalid arguments, 130 cancellation.
`;

export async function cmdResourceLauncher(args: string[]): Promise<number> {
  const controller = new AbortController(); const abort = (): void => controller.abort();
  try {
    const options = resourceCheckOptions(args, ['--provider', '--command', '--cwd', '--timeout-ms']);
    if (options.help) { console.log(USAGE); return 0; }
    const commandPath = resourceCheckPath(options.values, '--command');
    const cwd = resourceCheckPath(options.values, '--cwd');
    const provider = options.values.get('--provider');
    if (provider !== 'codex' && provider !== 'claude' && provider !== 'grok') throw new ResourceCheckUsageError('Expected codex, claude or grok provider');
    const timeoutText = options.values.get('--timeout-ms') ?? '10000'; const timeoutMs = Number(timeoutText);
    if (!/^[1-9][0-9]*$/.test(timeoutText) || !Number.isSafeInteger(timeoutMs) || timeoutMs > 30_000) {
      throw new ResourceCheckUsageError('Expected timeout from 1 to 30000 milliseconds');
    }
    process.once('SIGINT', abort); process.once('SIGTERM', abort);
    const [{ readResourceJson }, { checkResourceLauncherCompatibility }] = await Promise.all([
      import('../core/resources/pool-runtime.js'), import('../core/resources/launcher-compatibility.js'),
    ]);
    if (controller.signal.aborted) return 130;
    const command = readResourceJson(commandPath) as string[];
    const report = await checkResourceLauncherCompatibility({ provider, command, cwd, timeoutMs, signal: controller.signal });
    console.log(options.json ? JSON.stringify(report, null, 2) : [
      `Native launcher · ${report.provider} · ${report.status} · ${report.reason}`,
      `Version: ${report.version ?? 'unverified'} · Hub transport: ${report.hubTransport}`,
      `Missing flags: ${report.missingFlags.join(', ') || 'none'}`,
      'Help/version evidence only. Authentication, billing route, quota and model execution remain unverified.',
    ].join('\n'));
    return controller.signal.aborted ? 130 : report.status === 'supported' ? 0 : 1;
  } catch (error) {
    const message = error instanceof ResourceCheckUsageError ? error.message : 'Native launcher compatibility check unavailable';
    if (args.includes('--json')) console.log(JSON.stringify({ error: message }));
    else console.error(message);
    return controller.signal.aborted ? 130 : error instanceof ResourceCheckUsageError ? 2 : 1;
  } finally {
    process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort);
  }
}
