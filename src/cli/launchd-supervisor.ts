/**
 * Minimal launchd entrypoint. It deliberately has no static project imports so
 * dependency preload failures can be converted to a clean one-shot exit.
 */
async function main(): Promise<void> {
  try {
    const bootstrap = await import('../core/daemon/launchd-supervisor-bootstrap.js');
    process.exitCode = await bootstrap.runLaunchdSupervisorBootstrap(process.argv.slice(2));
  } catch {
    process.exitCode = 0;
  }
}

await main().catch(() => {
  process.exitCode = 0;
});
