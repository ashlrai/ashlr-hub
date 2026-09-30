/**
 * routes/verse/wiki/WikiView.tsx — the private repo wiki (3.15).
 *
 * One page: pick an enrolled repo, read its architecture pages (overview,
 * module map, key flows, data stores, commands, "how to change X"), click a
 * citation to open that file at that line (editor, or GitHub at the commit
 * the page was written at), and Ask the codebase with cited answers.
 *
 * Honest about freshness: "Generated at abc1234 · 3 pages stale" is computed
 * by the server from git blob ids, and a stale page is marked in the tree.
 * Building never blocks this view: the server runs it in the background and
 * this view polls the job while it runs.
 *
 * Split in three so each read only runs when it can succeed (the query hook
 * has no "enabled" flag): the view (repos, picker, Ask), the repo panel (one
 * repo's freshness, job and page tree) and the page panel (one page).
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import type { WikiAskResult, WikiCitation, WikiRepoView } from '../../../../core/knowledge/wiki/types.js';
import { MutationTokenDialog } from '../../../components/auth/MutationTokenDialog.js';
import { Button } from '../../../components/primitives/Button.js';
import { EmptyState } from '../../../components/primitives/EmptyState.js';
import { IconRefresh, IconSearch } from '../../../components/primitives/icons.js';
import { SkeletonLine } from '../../../components/primitives/Skeleton.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { describeContextError, useTokenGate, type TokenGate } from '../context/use-token-gate.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { WikiMarkdown } from './WikiMarkdown.js';
import { WikiGraph } from './WikiGraph.js';
import { getWikiFocus, isWikiFocusLive, subscribeWikiFocus, takeWikiFocus } from './wiki-focus.js';
import { freshness, githubCitationUrl, initialRepo, jobLine, modelLabel, pageTree, repoForProject, shortSha, type WikiRepoRow, type WikiTreePage } from './wiki-model.js';
import { askWikiQuestion, invalidateWikiRepo, openWikiCitation, startWikiBuild, wikiPageQuery, wikiRepoQuery, wikiReposQuery } from './wiki-queries.js';
import styles from './Wiki.module.css';

const REPO_STORAGE_KEY = 'verse.wiki.repo';
const TARGET_STORAGE_KEY = 'verse.wiki.citeTarget';
export const WIKI_JOB_POLL_MS = 2_500;

type CiteTarget = 'editor' | 'github';
type Notice = { tone: 'neutral' | 'danger'; text: string } | null;

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // private mode / quota: the choice just is not remembered
  }
}

function citeLabel(c: WikiCitation): string {
  return c.endLine && c.endLine > c.line ? `${c.file}:${c.line}-${c.endLine}` : `${c.file}:${c.line}`;
}

/** Open a citation: GitHub at the page's commit when chosen and possible, else the editor (gated). */
function useCitationOpener(gate: TokenGate, target: CiteTarget, setNotice: (n: Notice) => void) {
  return useCallback(
    async (cite: WikiCitation, repoKey: string | null, githubUrl: string | null, commit: string | null) => {
      const url = target === 'github' ? githubCitationUrl(githubUrl, commit, cite) : null;
      if (url) {
        window.open(url, '_blank', 'noopener,noreferrer');
        return;
      }
      if (!repoKey) return;
      try {
        const done = await gate.run(`Open ${citeLabel(cite)} in your editor`, async () => {
          await openWikiCitation(repoKey, cite.file, cite.line);
          return true;
        });
        if (done) setNotice({ tone: 'neutral', text: `Opened ${citeLabel(cite)} in your editor.` });
      } catch (err) {
        setNotice({ tone: 'danger', text: describeContextError(err) });
      }
    },
    [gate, target, setNotice],
  );
}

export function WikiView() {
  const repos = useQuery(wikiReposQuery);
  const gate = useTokenGate();
  const rows = useMemo(() => repos.data?.repos ?? [], [repos.data]);

  const [chosenKey, setChosenKey] = useState<string | null>(() => readStored(REPO_STORAGE_KEY));
  const selected = useMemo(() => initialRepo(rows, chosenKey), [rows, chosenKey]);
  const [target, setTarget] = useState<CiteTarget>(() => (readStored(TARGET_STORAGE_KEY) === 'github' ? 'github' : 'editor'));
  const [notice, setNotice] = useState<Notice>(null);
  const [question, setQuestion] = useState('');
  const [allRepos, setAllRepos] = useState(false);
  const [asking, setAsking] = useState(false);
  const [answer, setAnswer] = useState<WikiAskResult | null>(null);
  const [repoView, setRepoView] = useState<WikiRepoView | null>(null);
  const askRef = useRef<HTMLInputElement>(null);
  const openCite = useCitationOpener(gate, target, setNotice);

  const chooseRepo = useCallback((next: string) => {
    setChosenKey(next);
    writeStored(REPO_STORAGE_KEY, next);
    setAnswer(null);
  }, []);

  // ⌘K hand-off: "Open repo wiki…" (a repo) / "Ask the codebase…" (focus Ask).
  const focus = useSyncExternalStore(subscribeWikiFocus, getWikiFocus, getWikiFocus);
  useEffect(() => {
    if (!focus || !repos.data) return;
    if (isWikiFocusLive(focus)) {
      const match = repoForProject(rows, focus.projectPath);
      if (match) chooseRepo(match.key);
      else if (focus.projectPath) setNotice({ tone: 'neutral', text: 'That project is not enrolled, so it has no wiki. Enroll it with `ashlr enroll add <path>`.' });
      if (focus.kind === 'ask') askRef.current?.focus();
    }
    takeWikiFocus(focus.seq);
  }, [focus, repos.data, rows, chooseRepo]);

  const onAsk = async (event: FormEvent) => {
    event.preventDefault();
    const q = question.trim();
    if (!q) return;
    setAsking(true);
    setNotice(null);
    try {
      const res = await gate.run('Ask the codebase', () => askWikiQuestion(q, allRepos ? null : selected?.key ?? null));
      if (res) setAnswer(res);
    } catch (err) {
      setNotice({ tone: 'danger', text: describeContextError(err) });
    } finally {
      setAsking(false);
    }
  };

  const setCiteTarget = (next: CiteTarget) => {
    setTarget(next);
    writeStored(TARGET_STORAGE_KEY, next);
  };

  // An answer's citations can link to GitHub only when it is about the repo on screen.
  const answerGithub = answer && repoView && answer.repoKey === selected?.key ? repoView.githubUrl : null;
  const answerCommit = answer && repoView && answer.repoKey === selected?.key ? repoView.status.generatedCommit : null;

  return (
    <section className={styles.section} aria-label="Repo wiki">
      <div className={styles.scroll}>
        <div className={styles.page}>
          <header className={styles.header}>
            <div className={styles.headerText}>
              <h2 className={styles.title}>Repo wiki</h2>
              <p className={styles.lede}>
                Architecture pages for your enrolled repos, written on your own models and kept on this Mac. Every citation is checked against the code.
              </p>
            </div>
            <div className={styles.segmented} role="radiogroup" aria-label="Citations open in">
              <button type="button" role="radio" aria-checked={target === 'editor'} onClick={() => setCiteTarget('editor')}>Editor</button>
              <button type="button" role="radio" aria-checked={target === 'github'} onClick={() => setCiteTarget('github')}>GitHub</button>
            </div>
          </header>

          {repos.data === undefined && !repos.error ? (
            <div aria-busy="true" aria-label="Loading repos">
              <SkeletonLine width="40%" />
              <SkeletonLine width="70%" />
            </div>
          ) : repos.error ? (
            <p className={styles.banner} data-tone="danger">{describeContextError(repos.error)}</p>
          ) : rows.length === 0 || !selected ? (
            <EmptyState
              title="No enrolled repos"
              body={<>The wiki only reads repos you enrolled. Enroll one with <code>ashlr enroll add &lt;path&gt;</code>, then build its wiki here or with <code>ashlr wiki build</code>.</>}
            />
          ) : (
            <>
              <p className={notice ? styles.banner : styles.visuallyHidden} data-tone={notice?.tone} role="status" aria-live="polite">{notice?.text ?? ''}</p>

              <form className={styles.ask} onSubmit={(e) => void onAsk(e)} role="search" aria-label="Ask the codebase">
                <IconSearch size={14} />
                <input
                  ref={askRef}
                  type="text"
                  value={question}
                  maxLength={1000}
                  placeholder={allRepos ? 'Ask across every enrolled repo…' : `Ask ${selected.name}… e.g. “where are sessions persisted?”`}
                  onChange={(e) => setQuestion(e.target.value)}
                  aria-label="Question"
                />
                <label className={styles.scope}>
                  <input type="checkbox" checked={allRepos} onChange={(e) => setAllRepos(e.target.checked)} />
                  All repos
                </label>
                <Button type="submit" variant="primary" size="sm" busy={asking} disabled={!question.trim()}>Ask</Button>
              </form>

              {answer ? (
                <AnswerCard
                  answer={answer}
                  onDismiss={() => setAnswer(null)}
                  onCite={(c) => void openCite(c, answer.repoKey, answerGithub, answerCommit)}
                />
              ) : null}

              <WikiRepoPanel
                key={selected.key}
                repo={selected}
                rows={rows}
                gate={gate}
                target={target}
                onChoose={chooseRepo}
                onNotice={setNotice}
                onView={setRepoView}
                openCite={openCite}
              />
            </>
          )}
        </div>
      </div>
      <MutationTokenDialog
        open={gate.dialog.open}
        reason={gate.dialog.reason}
        tokenLabel="Mutation token"
        tokenHelp="the mutation token ashlr verse printed"
        onClose={gate.dialog.onClose}
        onUnlocked={gate.dialog.onUnlocked}
      />
    </section>
  );
}

function AnswerCard({ answer, onDismiss, onCite }: { answer: WikiAskResult; onDismiss: () => void; onCite: (c: WikiCitation) => void }) {
  const tone = answer.status === 'answered' ? 'success' : answer.status === 'extractive' ? 'neutral' : 'warning';
  const label = answer.status === 'answered' ? 'Answer' : answer.status === 'extractive' ? 'Best passages' : 'Not found';
  return (
    <div className={styles.answer} data-status={answer.status} aria-label="Answer">
      <div className={styles.answerHead}>
        <span className={styles.badge} data-tone={tone}>{label}</span>
        {answer.repoName ? <span className={styles.meta}>{answer.repoName}</span> : null}
        {answer.engine !== 'none' ? <span className={styles.meta}>{modelLabel(answer.engine)}{answer.local ? '' : ' · left this Mac'}</span> : null}
        {answer.droppedCitations > 0 ? (
          <span className={styles.meta}>{answer.droppedCitations} unverifiable citation{answer.droppedCitations === 1 ? '' : 's'} removed</span>
        ) : null}
        <span className={styles.spacer} />
        <Button variant="ghost" size="sm" onClick={onDismiss}>Dismiss</Button>
      </div>
      <WikiMarkdown markdown={answer.answer} label="Answer text" onCite={onCite} />
      {answer.sources.length > 0 ? (
        <ul className={styles.sources} aria-label="Sources">
          {answer.sources.slice(0, 8).map((s, i) => {
            const cite: WikiCitation = { file: s.file, line: s.line, ...(s.endLine ? { endLine: s.endLine } : {}) };
            return (
              <li key={`${s.file}:${s.line}:${i}`}>
                <button type="button" className={styles.cite} onClick={() => onCite(cite)}>{citeLabel(cite)}</button>
                <span className={styles.meta}>{s.via === 'wiki' ? s.title ?? 'wiki' : s.via === 'index' ? 'code' : 'genome'}</span>
              </li>
            );
          })}
        </ul>
      ) : null}
      {answer.alsoIn.length > 0 ? <p className={styles.meta}>Also relevant: {answer.alsoIn.map((a) => a.repoName).join(', ')}</p> : null}
    </div>
  );
}

interface RepoPanelProps {
  repo: WikiRepoRow;
  rows: readonly WikiRepoRow[];
  gate: TokenGate;
  target: CiteTarget;
  onChoose: (key: string) => void;
  onNotice: (n: Notice) => void;
  onView: (v: WikiRepoView | null) => void;
  openCite: (cite: WikiCitation, repoKey: string | null, githubUrl: string | null, commit: string | null) => Promise<void>;
}

function WikiRepoPanel({ repo, rows, gate, target, onChoose, onNotice, onView, openCite }: RepoPanelProps) {
  const def = useMemo(() => wikiRepoQuery(repo.key), [repo.key]);
  const q = useQuery(def, { freshMs: 5_000 });
  const refetch = useRefetch(def);
  const refetchRepos = useRefetch(wikiReposQuery);
  const view = q.data;
  const status = view?.status;
  const job = view?.job ?? null;
  const running = job?.state === 'running';
  usePollWhileVisible(refetch, WIKI_JOB_POLL_MS, { enabled: running });
  const [building, setBuilding] = useState(false);
  const [pageId, setPageId] = useState('overview');
  const [pageEpoch, setPageEpoch] = useState(0);
  const [surface, setSurface] = useState<'pages' | 'map'>('pages');

  useEffect(() => {
    onView(view ?? null);
  }, [view, onView]);

  // A finished build changed pages: drop the cached reads it touched.
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !running) {
      invalidateWikiRepo(repo.key, (status?.pages ?? []).map((p) => p.id));
      refetch();
      refetchRepos();
      setPageEpoch((n) => n + 1);
    }
    wasRunning.current = running;
  }, [running, repo.key, status, refetch, refetchRepos]);

  const tree = useMemo(() => pageTree(status?.pages ?? []), [status]);
  const active = tree.find((t) => t.page.id === pageId)?.page ?? tree[0]?.page ?? null;
  const fresh = freshness(status);

  const onBuild = async () => {
    setBuilding(true);
    onNotice(null);
    try {
      const started = await gate.run(`Build the wiki for ${repo.name}`, () => startWikiBuild(repo.key));
      if (started) refetch();
    } catch (err) {
      onNotice({ tone: 'danger', text: describeContextError(err) });
    } finally {
      setBuilding(false);
    }
  };

  return (
    <>
      <div className={styles.toolbar}>
        <label className={styles.picker}>
          <span className={styles.visuallyHidden}>Repo</span>
          <select value={repo.key} onChange={(e) => onChoose(e.target.value)} aria-label="Repo">
            {rows.map((r) => (
              <option key={r.key} value={r.key}>{r.name}{r.exists ? '' : ' — no wiki yet'}</option>
            ))}
          </select>
        </label>
        <span className={styles.badge} data-tone={fresh.tone} aria-label="Freshness">{fresh.text}</span>
        {status?.exists && status.currentCommit && status.currentCommit !== status.generatedCommit ? (
          <span className={styles.meta}>HEAD is {shortSha(status.currentCommit)}</span>
        ) : null}
        {target === 'github' && view && !view.githubUrl ? <span className={styles.meta}>No GitHub origin — citations open in your editor</span> : null}
        <span className={styles.spacer} />
        {status?.exists ? (
          <Button variant="subtle" size="sm" icon={<IconRefresh size={14} />} busy={building || running} disabled={running} onClick={() => void onBuild()}>
            {status.stalePages > 0 || status.pendingPages > 0 ? 'Refresh stale pages' : 'Check for changes'}
          </Button>
        ) : null}
      </div>

      <p className={styles.privacy}>
        Local models first; Grok only where your grant and this repo allow it; never Claude. Pages live in <code>~/.ashlr/knowledge/wiki</code>, never in the repo.
      </p>

      <div className={styles.segmented} role="group" aria-label="Wiki view">
        <button type="button" aria-pressed={surface === 'pages'} onClick={() => setSurface('pages')}>Pages</button>
        <button type="button" aria-pressed={surface === 'map'} onClick={() => setSurface('map')}>Module map</button>
      </div>

      {job ? <p className={styles.job} data-state={job.state} role="status" aria-live="polite">{jobLine(job)}</p> : null}

      {surface === 'map' ? (
        <WikiGraph repoKey={repo.key} onCite={(c, commit) => void openCite(c, repo.key, view?.githubUrl ?? null, commit)} />
      ) : view === undefined && !q.error ? (
        <div aria-busy="true" aria-label="Loading wiki">
          <SkeletonLine width="30%" />
          <SkeletonLine width="85%" />
        </div>
      ) : q.error || !status ? (
        <p className={styles.banner} data-tone="danger">{q.error ? describeContextError(q.error) : 'The wiki could not be read.'}</p>
      ) : !status.exists ? (
        <EmptyState
          title={`No wiki for ${repo.name} yet`}
          body="Build it once: overview, module map, key flows, data stores, commands and change guides, each with checked file:line citations. After that, only pages whose code changed are rewritten."
          action={
            <Button variant="primary" size="sm" busy={building || running} disabled={running} onClick={() => void onBuild()}>
              Build wiki
            </Button>
          }
        />
      ) : (
        <div className={styles.body}>
          <nav className={styles.tree} aria-label="Wiki pages">
            <ul>
              {tree.map(({ page: p, depth }) => (
                <li key={p.id} data-depth={depth}>
                  <button type="button" aria-current={active?.id === p.id ? 'page' : undefined} onClick={() => setPageId(p.id)}>
                    <span className={styles.treeTitle}>{p.title}</span>
                    {p.stale ? <span className={styles.staleDot} role="img" aria-label="stale" title="Its code changed since this page was written" /> : null}
                  </button>
                </li>
              ))}
            </ul>
          </nav>
          {active ? (
            <WikiPagePanel
              key={`${active.id}:${pageEpoch}`}
              repoKey={repo.key}
              page={active}
              onPage={setPageId}
              onCite={(c, commit) => void openCite(c, repo.key, view?.githubUrl ?? null, commit)}
            />
          ) : null}
        </div>
      )}
    </>
  );
}

function WikiPagePanel({ repoKey, page, onPage, onCite }: { repoKey: string; page: WikiTreePage; onPage: (id: string) => void; onCite: (c: WikiCitation, commit: string | null) => void }) {
  const def = useMemo(() => wikiPageQuery(repoKey, page.id), [repoKey, page.id]);
  const q = useQuery(def, { freshMs: 60_000 });
  const data = q.data;
  return (
    <article className={styles.article} aria-label={page.title}>
      {data === undefined && !q.error ? (
        <div aria-busy="true">
          <SkeletonLine width="40%" />
          <SkeletonLine width="90%" />
          <SkeletonLine width="80%" />
        </div>
      ) : q.error || !data ? (
        <p className={styles.banner} data-tone="danger">{q.error ? describeContextError(q.error) : 'This page could not be read.'}</p>
      ) : (
        <>
          <p className={styles.pageMeta}>
            Written by {modelLabel(data.meta.model)} at {shortSha(data.meta.commit)} · {data.meta.citations} citations
            {data.meta.droppedCitations > 0 ? ` · ${data.meta.droppedCitations} unverifiable removed` : ''}
            {page.stale ? ' · stale: its code changed since' : ''}
          </p>
          <WikiMarkdown markdown={data.markdown} label="Page text" onCite={(c) => onCite(c, data.meta.commit)} onPage={onPage} />
        </>
      )}
    </article>
  );
}
