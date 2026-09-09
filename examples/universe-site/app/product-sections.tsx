const docs =
  'https://github.com/ashlrai/ashlr-hub/blob/codex/universe-account-connections/docs/';
export function ProductSections() {
  return (
    <>
      <section className="section system">
        <div className="section-heading">
          <h2>
            One loop.
            <br />
            Your choice of engines.
          </h2>
          <p>
            The engine supplies candidates. The runtime preserves the objective,
            evaluates artifacts, and records what actually happened.
          </p>
        </div>
        <div className="system-grid">
          <article>
            <h3>Resources with a reserve</h3>
            <p>
              Enroll native Codex and Claude Code workers or a local model.
              Apply shared-capacity limits, inspect quota windows, and keep an
              account available for your own work.
            </p>
            <a className="text-link" href={`${docs}RESOURCE-POOLS.md`}>
              Commission workers
            </a>
          </article>
          <article>
            <h3>Evidence before confidence</h3>
            <p>
              Freeze the evaluator, isolate trials, retain different useful
              approaches, and feed measured results into the next generation.
              Passing unchanged work is not new value.
            </p>
            <a className="text-link" href={`${docs}ASHLR-UNIVERSE.md`}>
              Understand the runtime
            </a>
          </article>
          <article>
            <h3>Stay in command</h3>
            <p>
              Inspect recorded lineage and resource use. Give campaigns explicit
              scope and budgets; pause or cancel owned work without confusing
              historical receipts with live agents.
            </p>
            <a className="text-link" href={`${docs}ARCHITECTURE.md`}>
              Explore the architecture
            </a>
          </article>
        </div>
      </section>
      <section className="section get-started" id="run">
        <div>
          <p className="release-note">Run the real experiment</p>
          <h2>
            Start with evidence.
            <br />
            Then add intelligence.
          </h2>
          <p>
            Use the current source checkout. The experiment needs Git, Node.js
            22.15+, and macOS sandbox-exec. No model subscription is needed.
          </p>
          <p>
            The npm release and this source preview are separate. Follow the
            release guide before assuming a global installation includes these
            commands.
          </p>
          <a className="text-link" href={`${docs}DEMO.md`}>
            Complete demo guide
          </a>
        </div>
        <div className="terminal">
          <div className="terminal-title">From a trusted source checkout</div>
          <pre>
            <code>
              {
                'npm ci\nnpm run build\n\n# Choose a fresh private directory\nnode bin/ashlr universe demo \\\n  --root /absolute/private/experiments --json\n\n# Inspect the same store\nnode bin/ashlr universe console \\\n  --root /absolute/private/experiments'
              }
            </code>
          </pre>
          <p>
            Creates local files and executes bounded code. The console stays on
            loopback; never publish its token or private store.
          </p>
        </div>
      </section>
      <section className="section limits">
        <h2>Built to be useful. Clear about what’s real.</h2>
        <div className="system-grid">
          <article>
            <h3>Working source</h3>
            <p>
              Local experiments, retained archives, resource admission,
              foreground supervision, and scoped observability.
            </p>
          </article>
          <article>
            <h3>Separate commissioning</h3>
            <p>
              Real accounts need native authentication, fresh quota evidence,
              and explicit bindings. Subscription access is not API credit.
            </p>
          </article>
          <article>
            <h3>Not a universal autopilot</h3>
            <p>
              This page does not start work. Unattended provider operations,
              production publication, and accepted engineering yield require
              their own verified setup.
            </p>
          </article>
        </div>
        <a className="text-link" href={`${docs}NORTH-STAR.md`}>
          Read the North Star
        </a>
      </section>
    </>
  );
}
