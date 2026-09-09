import { Experiment } from './experiment';
import Image from 'next/image';
import { ProductSections } from './product-sections';
import evidence from './data/demo.json';
import { SiteHeader } from './site-header';
import { projectSchema } from './seo';
import Link from 'next/link';

const source = 'https://github.com/ashlrai/ashlr-hub';
export default function Home() {
  return (
    <main id="top">
      <a className="skip-link" href="#experiment">
        Skip to the experiment
      </a>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(projectSchema).replace(/</g, '\\u003c'),
        }}
      />
      <SiteHeader />
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
          <p className="release-note">Open-source AI engineering</p>
          <h1 id="hero-title">
            Your next idea.
            <br />
            An entire fleet.
          </h1>
          <p className="lead">
            Turn a repository objective into competing approaches, tested
            artifacts, and a record of what worked. Built for a future where
            your engineering fleet keeps improving alongside its models.
          </p>
          <div className="actions">
            <a className="primary-link" href="#experiment">
              Enter the observatory <span aria-hidden="true">↗</span>
            </a>
            <Link className="text-link" href="/docs/">
              Start with the field guide
            </Link>
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
      <section
        className="section agent-entry"
        aria-labelledby="agent-entry-title"
      >
        <div>
          <p className="release-note">A shared starting point</p>
          <h2 id="agent-entry-title">
            Built for you.
            <br />
            Readable by your agent.
          </h2>
          <p>
            One task map, in human-readable HTML, Markdown and JSON. Find the
            right command, understand its effects, and follow the same evidence.
          </p>
          <Link className="primary-link" href="/docs/">
            Open the field guide
          </Link>
        </div>
        <div className="agent-files">
          <a href="/agent-guide.md" download>
            <span>agent-guide.md</span>
            <small>Plain-text context and operating boundaries</small>
          </a>
          <a href="/agent-map.json" download>
            <span>agent-map.json</span>
            <small>Versioned task index and canonical guide links</small>
          </a>
          <a href="/llms.txt" download>
            <span>llms.txt</span>
            <small>Compact documentation directory</small>
          </a>
        </div>
      </section>
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
