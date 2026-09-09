export function SiteHeader({ guide = false }: { guide?: boolean }) {
  return (
    <header className="masthead">
      <Link className="wordmark" href="/" aria-label="Ashlrverse home">
        ashlrverse<span aria-hidden="true">✳</span>
      </Link>
      <nav aria-label="Main">
        <Link href="/#experiment">Observatory</Link>
        <Link href="/docs/" aria-current={guide ? 'page' : undefined}>
          Field guide
        </Link>
        <a className="nav-source" href="https://github.com/ashlrai/ashlr-hub">
          Open source <span aria-hidden="true">↗</span>
        </a>
      </nav>
    </header>
  );
}
import Link from 'next/link';
