import { CopyCommand } from './copy-command';

const docs = 'https://github.com/ashlrai/ashlr-hub/blob/master/docs/';
const command =
  'npm ci\nnpm run build\n\n# Choose a fresh private directory\nnode bin/ashlr universe demo \\\n  --root /absolute/private/experiments --json\n\n# Inspect the same store\nnode bin/ashlr universe console \\\n  --root /absolute/private/experiments';

export function ProductSections() {
  return (
    <>
      <section className="section mission" id="mission">
        <div className="mission-statement">
          <p className="release-note">The mission</p>
          <h2>
            Build the system
            <br />
            that keeps
            <br />
            getting better.
          </h2>
        </div>
        <div className="mission-body">
          <p className="mission-lead">
            A better model should make your whole engineering fleet better.
          </p>
          <p>
            Ashlrverse is the open-source infrastructure between ambition and
            execution: persistent objectives, competing approaches, independent
            evaluation, and a memory of what actually worked.
          </p>
          <p>
            The goal is more than generating code. It is a fleet that discovers
            useful work, learns from outcomes, and steadily improves the
            product—and its own way of building it.
          </p>
          <a className="text-link" href={docs + 'NORTH-STAR.md'}>
            Read the North Star
          </a>
        </div>
      </section>
      <section className="section system">
        <div className="section-heading">
          <h2>
            Many engines.
            <br />
            One mission.
          </h2>
          <p>
            Keep the intelligence interchangeable. Keep the evidence,
            objectives, and control in your hands.
          </p>
        </div>
        <ul className="engine-list" aria-label="Supported worker types">
          <li>
            Codex <span>Native workers</span>
          </li>
          <li>
            Claude Code <span>Native workers</span>
          </li>
          <li>
            Local models <span>Your own compute</span>
          </li>
        </ul>
        <div className="system-grid">
          <article>
            <span className="feature-symbol" aria-hidden="true">
              ◷
            </span>
            <h3>Spend with intention</h3>
            <p>
              Pool enrolled workers, respect shared quota windows, and reserve
              capacity for your own work. More tokens are useful only when they
              produce better outcomes.
            </p>
            <a className="text-link" href={docs + 'RESOURCE-POOLS.md'}>
              Configure resources
            </a>
          </article>
          <article>
            <span className="feature-symbol" aria-hidden="true">
              ⌘
            </span>
            <h3>Explore, then prove</h3>
            <p>
              Run different approaches against a fixed evaluator. Preserve
              useful differences, reject broken artifacts, and feed measured
              feedback into the next attempt.
            </p>
            <a className="text-link" href={docs + 'ASHLR-UNIVERSE.md'}>
              Explore the runtime
            </a>
          </article>
          <article>
            <span className="feature-symbol" aria-hidden="true">
              ⊹
            </span>
            <h3>Autonomy you can inspect</h3>
            <p>
              Give the fleet a mission and budget. Follow lineage, inspect
              results, and pause owned work. Deliver improvements to declared
              branches with evidence-bound receipts.
            </p>
            <a className="text-link" href={docs + 'ASHLR-UNIVERSE.md'}>
              Operate the fleet
            </a>
          </article>
        </div>
      </section>
      <section className="section get-started" id="run">
        <div>
          <p className="release-note">Your first expedition</p>
          <h2>
            Make the loop
            <br />
            your own.
          </h2>
          <p>
            Start with a reproducible experiment. Then connect your models and
            turn a repository objective into a bounded engineering campaign.
          </p>
          <p>
            The demo needs a trusted source checkout, Git, Node.js 24+, and
            macOS sandbox-exec. No model account is needed for this first run.
          </p>
          <a className="text-link" href={docs + 'DEMO.md'}>
            Open the complete setup guide
          </a>
        </div>
        <div className="terminal">
          <div className="terminal-title">
            <span className="terminal-dots" aria-hidden="true">
              ● ● ●
            </span>
            <span>Local launch sequence</span>
          </div>
          <CopyCommand command={command} />
          <pre>
            <code>{command}</code>
          </pre>
          <p>
            Creates local files and runs bounded code. The console stays on
            loopback. Keep its token and private store off the public internet.
          </p>
        </div>
      </section>
      <section className="section limits">
        <div className="section-heading">
          <h2>
            Ambition without
            <br />
            make-believe.
          </h2>
          <p>The frontier is open. The evidence stays specific.</p>
        </div>
        <div className="system-grid">
          <article>
            <h3>Working today</h3>
            <p>
              Local experiments, multi-generation campaigns, retained archives,
              resource admission, foreground supervision, and opt-in verified
              branch delivery.
            </p>
          </article>
          <article>
            <h3>Your fleet, commissioned</h3>
            <p>
              Real accounts need native authentication, current quota evidence,
              and explicit worker bindings. A subscription is not
              interchangeable with API credit.
            </p>
          </article>
          <article>
            <h3>The frontier ahead</h3>
            <p>
              Continuous product discovery, stronger evaluators, and measured
              accepted-change yield. These are the mission—not capabilities
              proved by this recorded demo.
            </p>
          </article>
        </div>
        <div className="closing-call">
          <p>
            What will you build
            <br />
            when you can build more?
          </p>
          <a
            className="primary-link"
            href="https://github.com/ashlrai/ashlr-hub"
          >
            Build with us <span aria-hidden="true">↗</span>
          </a>
        </div>
      </section>
    </>
  );
}
