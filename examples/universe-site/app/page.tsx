import { Experiment } from './experiment';
import { ProductSections } from './product-sections';
import evidence from './data/demo.json';
const source =
  'https://github.com/ashlrai/ashlr-hub/tree/codex/universe-account-connections';
export default function Home() {
  return (
    <main id="top">
      <header className="masthead">
        <a className="wordmark" href="#top">
          Ashlr <span>Universe</span>
        </a>
        <nav aria-label="Main">
          <a href="#experiment">Experiment</a>
          <a href={`${source}/docs/QUICKSTART.md`}>Documentation</a>
          <a href={source}>GitHub</a>
        </nav>
      </header>
      <section className="hero">
        <div>
          <p className="release-note">
            Open source · Local engineering runtime
          </p>
          <h1>
            Give your ideas
            <br />a working universe.
          </h1>
          <p className="lead">
            Turn an objective into competing approaches, tested artifacts, and a
            better next attempt. Keep your models, your tools, and your judgment
            in the loop.
          </p>
          <div className="actions">
            <a className="primary-link" href="#experiment">
              Explore the experiment
            </a>
            <a className="text-link" href={`${source}/docs/QUICKSTART.md`}>
              Run it locally
            </a>
          </div>
          <p className="scope-note">
            Current-source preview. No account connection or paid inference on
            this page.
          </p>
        </div>
        <div
          className="loop"
          aria-label="Engineering loop: objective, candidates, fixed evaluation, retained archive, next generation"
        >
          <div className="loop-heading">
            <span>One objective. Several approaches.</span>
            <span className="signal">Local loop</span>
          </div>
          <div className="objective">
            Preserve order.
            <br />
            Remove duplicates.
            <br />
            <strong>Use less code.</strong>
          </div>
          <div className="candidates">
            <span>Compact</span>
            <span>Readable</span>
            <span className="rejected">Broken</span>
          </div>
          <div className="evaluator">
            Fixed evaluator <span>Correctness before score</span>
          </div>
          <div className="archive">
            <span>Retain useful differences</span>
            <strong>Build the next generation</strong>
          </div>
        </div>
      </section>
      <section className="section" id="experiment">
        <div className="section-heading">
          <div>
            <p className="release-note">The mechanism, made visible</p>
            <h2>Watch evidence shape the next attempt.</h2>
          </div>
          <p>
            A deterministic demonstration executes actual code. It demonstrates
            the runtime, not model intelligence or production yield.
          </p>
        </div>
        <Experiment evidence={evidence} />
      </section>
      <ProductSections />
      <footer>
        <span>Ashlr Universe · Built for builders</span>
        <a href={source}>MIT-licensed source</a>
      </footer>
    </main>
  );
}
