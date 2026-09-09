import { Experiment } from './experiment';
import Image from 'next/image';
import { ProductSections } from './product-sections';
import evidence from './data/demo.json';

const source = 'https://github.com/ashlrai/ashlr-hub';
export default function Home() {
  return (
    <main id="top">
      <a className="skip-link" href="#experiment">
        Skip to the experiment
      </a>
      <header className="masthead">
        <a className="wordmark" href="#top" aria-label="Ashlrverse home">
          ashlrverse<span aria-hidden="true">✳</span>
        </a>
        <nav aria-label="Main">
          <a href="#experiment">Observatory</a>
          <a href="#mission">Mission</a>
          <a className="nav-source" href={source}>
            Open source <span aria-hidden="true">↗</span>
          </a>
        </nav>
      </header>
      <section className="hero" aria-labelledby="hero-title">
        <Image
          className="hero-art"
          src="/ashlrverse-orbital.png"
          width={1672}
          height={941}
          alt=""
          fetchPriority="high"
          unoptimized
        />
        <div className="hero-copy">
          <p className="release-note">An open frontier for builders</p>
          <h1 id="hero-title">
            Ideas deserve
            <br />a universe.
          </h1>
          <p className="lead">
            An open-source engineering fleet that explores possibilities, tests
            its work, and builds on what it learns. Your ambition. Many minds.
            One evolving mission.
          </p>
          <div className="actions">
            <a className="primary-link" href="#experiment">
              Enter the observatory <span aria-hidden="true">↗</span>
            </a>
            <a className="text-link" href="#run">
              Build your fleet
            </a>
          </div>
          <p className="scope-note">
            Local-first runtime. Open models and native workers.
            <br />
            Real evidence, not a simulated live fleet.
          </p>
        </div>
        <div className="hero-coordinate" aria-hidden="true">
          <span>Beyond the single agent</span>
          <span>Ashlrverse / engineering frontier</span>
        </div>
      </section>
      <section className="section" id="experiment">
        <div className="section-heading">
          <div>
            <p className="release-note">The observatory</p>
            <h2>
              Progress leaves
              <br />a trace.
            </h2>
          </div>
          <p>
            Inspect two generations of a real code experiment. Follow what
            passed, what failed, and what the next attempt inherited. Fixed
            workers make this demonstration reproducible; it is not a measure of
            AI intelligence.
          </p>
        </div>
        <Experiment evidence={evidence} />
      </section>
      <ProductSections />
      <footer>
        <a className="wordmark" href="#top">
          ashlrverse<span aria-hidden="true">✳</span>
        </a>
        <span>A frontier worth building together.</span>
        <a href={source + '/blob/master/LICENSE'}>MIT-licensed source</a>
      </footer>
    </main>
  );
}
