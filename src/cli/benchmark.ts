const HELP = `ashlr benchmark — recorded local-agent trials and offline receipt comparison

  ashlr benchmark --help
  ashlr benchmark --compare-reports BASELINE.json CANDIDATE.json
  ashlr benchmark run [--set core|heldout] [--task ID] [--trials N] [--concurrency N]
    [--base-url URL] [--upstream URL] [--model REF] [--agent EXECUTABLE]
    [--timeout-ms N] [--out FILE] [--trace|--no-trace]
    [--cache-state cold|warm|uncontrolled] [--cache-protocol DESCRIPTION]
  ashlr benchmark run --experiments [--fleet-busy] [runtime options]

Help and comparison are offline and do not probe a runtime or invoke an agent.
Only run starts agent/model work. It reuses the local-eval core/held-out tasks,
real checker exits, observed configuration and private trace artifacts.
Defaults: 3 trials/task, concurrency 2, cache state uncontrolled.
Cache labels record your procedure; they do not flush or verify caches.
Exit 0: all recorded trials passed (or a valid descriptive comparison).
Exit 1: trial/runtime/artifact failure or resource-allocation refusal.
Exit 2: invalid options, unknown task or refused offline comparison.
Experiment mode retains the existing queue and adoption policy; no fleet gate is added.`;

type Runner = Pick<typeof import('../core/local-eval/main.js'), 'parseArgs' | 'runLocalEval'>;
type Comparator = Pick<typeof import('../core/local-eval/compare.js'), 'compareReportsCli'>;
export interface BenchmarkCliDeps {
  loadRunner(): Promise<Runner>;
  loadComparator(): Promise<Comparator>;
  out(text: string): void;
  err(text: string): void;
}

/** No default execution: runtime work requires the explicit run subcommand. */
export async function runBenchmarkCli(args: string[], overrides: Partial<BenchmarkCliDeps> = {}): Promise<number> {
  const deps: BenchmarkCliDeps = { loadRunner: () => import('../core/local-eval/main.js'),
    loadComparator: () => import('../core/local-eval/compare.js'), out: console.log, err: console.error, ...overrides };
  if (!args.length || args.length === 1 && ['help', '--help', '-h'].includes(args[0])
    || args.length === 2 && args[0] === 'run' && ['--help', '-h'].includes(args[1])) {
    deps.out(HELP); return 0;
  }
  const usage = (): number => { deps.err(HELP); return 2; };
  if (args[0] === '--compare-reports') {
    if (args.length !== 3 || args.slice(1).some((value) => !value || value.startsWith('-'))) return usage();
    try {
      const comparator = await deps.loadComparator();
      const result = comparator.compareReportsCli(args);
      deps.out(result.output); return result.exitCode;
    } catch { deps.err('Benchmark receipts could not be read; no comparison was inferred.'); return 2; }
  }
  if (args[0] !== 'run') return usage();
  try {
    const runner = await deps.loadRunner();
    try { runner.parseArgs(args.slice(1)); } catch { return usage(); }
    return await runner.runLocalEval(args.slice(1), { out: deps.out, err: deps.err });
  } catch { deps.err('Benchmark execution could not complete; no successful result was inferred.'); return 1; }
}
