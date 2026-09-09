import guide from '../data/documentation.json';
import { SiteHeader } from '../site-header';
import { CopyCommand } from '../copy-command';
import { pageMetadata } from '../seo';
import Link from 'next/link';

export const metadata = pageMetadata(
  '/docs/',
  'Ashlrverse field guide — For engineers and coding agents',
  'Start a local experiment, discover agent commands, configure worker resources, and interpret campaign and delivery evidence.',
);

export default function Docs() {
  return (
    <main id="top" className="guide-page">
      <a className="skip-link" href="#guide-content">
        Skip to the field guide
      </a>
      <SiteHeader guide />
      <section className="guide-intro">
        <div>
          <p className="release-note">For engineers and their agents</p>
          <h1>The field guide.</h1>
          <p className="lead">
            Give the fleet a clear objective.
            <br />
            Give your agent a reliable starting point.
          </p>
        </div>
        <div className="guide-downloads">
          <span>Take the context with you</span>
          <a href="/agent-guide.md" download>
            Plain-text guide
          </a>
          <a href="/agent-map.json" download>
            Structured task index
          </a>
          <a href="/llms.txt" download>
            Compact link index
          </a>
        </div>
      </section>
      <div id="guide-content" className="guide-layout">
        <aside className="guide-nav">
          <nav aria-label="Field guide">
            <a href="#before-you-start">Before you start</a>
            {guide.tasks.map((task) => (
              <a key={task.id} href={'#' + task.id}>
                {task.title}
              </a>
            ))}
            <a href="#evidence">Read the evidence</a>
          </nav>
        </aside>
        <div className="guide-content">
          <section id="before-you-start" className="guide-start">
            <h2>
              A small first step.
              <br />A reproducible result.
            </h2>
            <p>{guide.prerequisites}</p>
            <p>
              Ashlrverse is the public name. The package remains{' '}
              <code>{guide.compatibility.package}</code>; commands remain{' '}
              <code>{guide.compatibility.cli}</code>.
            </p>
            <div className="guide-command">
              <p>Discover the selected binary’s agent commands</p>
              <pre>
                <code>{guide.discoveryCommand}</code>
              </pre>
              <CopyCommand command={guide.discoveryCommand} />
              <p className="command-note">{guide.discoveryNote}</p>
            </div>
          </section>
          {guide.tasks.map((task) => (
            <section key={task.id} id={task.id} className="guide-task">
              <span className="task-effect">{task.effect}</span>
              <h2>{task.title}</h2>
              <p>{task.description}</p>
              <a className="text-link" href={task.href}>
                {task.label}
              </a>
            </section>
          ))}
          <section id="evidence" className="guide-evidence">
            <h2>
              Read the evidence.
              <br />
              Not just the status.
            </h2>
            <ul>
              {guide.interpretation.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
            <p>
              The observatory replays a fixed-worker experiment recorded at{' '}
              <code>{guide.evidence.sourceCommit}</code>.{' '}
              {guide.evidence.measurementScope}
            </p>
            <a className="text-link" href={guide.evidence.path}>
              Download the recorded evidence
            </a>
          </section>
        </div>
      </div>
      <footer>
        <Link className="wordmark" href="/">
          ashlrverse<span aria-hidden="true">✳</span>
        </Link>
        <Link href="/#experiment">Return to the observatory</Link>
        <a href="https://github.com/ashlrai/ashlr-hub/blob/master/docs/README.md">
          Complete repository documentation
        </a>
      </footer>
    </main>
  );
}
