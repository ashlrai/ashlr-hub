import { useRef, useState } from 'react';
import { ADOPTION_REASON_TEXT, ADOPTION_TARGET, type AdoptionReading, type AdoptionTraffic } from '../../../../core/verse/adoption-types.js';
import { BarStack } from '../../../components/charts/BarStack.js';
import { CHART_SEQUENTIAL } from '../../../components/charts/colors.js';
import { Button } from '../../../components/primitives/Button.js';
import { MutationTokenDialog } from '../../../components/auth/MutationTokenDialog.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { useGuardedAction } from '../autonomy/use-guarded-action.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { Card, CardNote } from '../command/Surface.js';
import { adoptionQuery, refreshAdoption } from './adoption-data.js';
import { adoptionSourceNote, adoptionStatus, trafficDays } from './adoption-model.js';
import styles from './adoption.module.css';
const SEGMENTS = [{ id: 'count', label: 'Count', color: CHART_SEQUENTIAL }];
const formatCount = (n: number | null | undefined) => n == null ? '—' : n.toLocaleString();
function SourceNote({ reading }: { reading: AdoptionReading<unknown> | undefined }) {
  return <CardNote tone={reading?.reason ? 'unknown' : 'muted'}>{adoptionSourceNote(reading)}</CardNote>;
}
function TrafficChart({ title, reading, unavailable }: { title: string; reading: AdoptionReading<AdoptionTraffic> | undefined; unavailable: string }) {
  const value = reading?.value, days = trafficDays(value?.days ?? []);
  return <div>
    <BarStack title={title} description={`GitHub rolling 14 days · ${formatCount(value?.count)} events · ${formatCount(value?.uniques)} unique ${title === 'Repository views' ? 'visitors' : 'cloners'}`}
      status={adoptionStatus(reading, unavailable)} categories={days.map((d) => d.day)} segments={SEGMENTS} values={days.map((d) => [d.count])}
      caveat={`${adoptionSourceNote(reading)} UTC dates. GitHub aggregates; unique visitors and cloners are separate populations.`} height={180} />
  </div>;
}
export function AdoptionPanel() {
  const query = useQuery(adoptionQuery, { freshMs: 60_000 }), refetch = useRefetch(adoptionQuery);
  const warmingSince = useRef(Date.now());
  const warming = query.data?.value && Object.values(query.data.value.sources).some((source) => source.refreshing || (source.state === 'warming' && Date.now() - warmingSince.current < 60_000));
  // Fast cache-only readback during initial collection, then quiet normal cadence.
  // An intentionally disabled collector cannot keep the local startup poll alive forever.
  usePollWhileVisible(refetch, warming ? 5_000 : 300_000);
  const guard = useGuardedAction(), [assetPage, setAssetPage] = useState(0);
  const data = query.data?.value, sources = data?.sources;
  const unavailable = query.data?.reason ?? 'Adoption metadata has not answered.';
  const npm = sources?.npm.value, release = sources?.release.value;
  const assets = release?.assets ?? [], pages = Math.ceil(assets.length / 20), page = Math.min(assetPage, Math.max(0, pages - 1));
  return <div className={styles.panel} aria-label="Adoption">
    <Card title="Adoption" caption={`${ADOPTION_TARGET.repo} · ${ADOPTION_TARGET.packageName}`} actions={<Button size="sm" variant="ghost" disabled={guard.busy || guard.readOnly} onClick={() => guard.request(refreshAdoption, 'Refresh fixed-project GitHub and npm metadata', () => { refetch(); })}>{guard.busy ? 'Refreshing…' : 'Refresh adoption'}</Button>}>
      <CardNote>Public project metadata, separate from fleet output. Downloads and retrievals include automation and verification; they do not measure unique installations or active engineers.</CardNote>
      {!data ? <CardNote tone="unknown">{unavailable}</CardNote> : null}
      {guard.error ? <CardNote tone="danger">{guard.error}</CardNote> : null}
      {guard.readOnly ? <CardNote>Manual refresh requires a dispatch-enabled session. Background metadata reads remain separate from agent execution.</CardNote> : null}
    </Card>
    <div className={styles.grid}>
      <Card title="GitHub repository" caption="Current stocks · not a time series">
        <dl className={styles.metrics}><div><dt>Stars</dt><dd>{formatCount(sources?.repository.value?.stars)}</dd></div><div><dt>Forks</dt><dd>{formatCount(sources?.repository.value?.forks)}</dd></div></dl>
        <SourceNote reading={sources?.repository} />
      </Card>
      <div><BarStack title="npm package retrievals" description={npm ? `${npm.start} to ${npm.end} UTC · ${npm.complete ? `${formatCount(npm.total)} retrievals` : 'Incomplete daily coverage; total unknown'}` : 'Last 30 available UTC days · provider processing can lag'}
        caveat={`${adoptionSourceNote(sources?.npm)} Missing days remain unknown. Retrievals are not unique people or successful installs.`}
        status={adoptionStatus(sources?.npm, unavailable)} categories={npm?.days.map((d) => d.day) ?? []} segments={SEGMENTS} values={npm?.days.map((d) => [d.count]) ?? []} height={180} /></div>
      <TrafficChart title="Repository views" reading={sources?.views} unavailable={unavailable} />
      <TrafficChart title="Repository clones" reading={sources?.clones} unavailable={unavailable} />
    </div>
    <Card title="Latest release asset downloads" caption={release ? `${release.tag} · published ${new Date(release.publishedAt).toLocaleString()}` : 'Latest published release only'}>
      <CardNote>Cumulative count per uploaded asset, including our own verification downloads. Asset IDs distinguish replacements; these are not all-release totals or a daily series.</CardNote>
      {release ? assets.length > 0 ? <>
        <div className={styles.tableWrap}><table><caption className={styles.visuallyHidden}>Latest published release assets</caption><thead><tr><th scope="col">Asset</th><th scope="col">Asset ID</th><th scope="col">Downloads</th></tr></thead><tbody>{assets.slice(page * 20, (page + 1) * 20).map((asset) => <tr key={`${release.id}:${asset.id}`}><th scope="row">{asset.name}</th><td>{asset.id}</td><td>{formatCount(asset.count)}</td></tr>)}</tbody></table></div>
        {pages > 1 ? <nav aria-label="Release asset pages"><Button size="sm" disabled={page === 0} onClick={() => setAssetPage(page - 1)}>Previous assets</Button><span>Page {page + 1} of {pages}</span><Button size="sm" disabled={page + 1 >= pages} onClick={() => setAssetPage(page + 1)}>Next assets</Button></nav> : null}
      </> : <CardNote>The latest published release reports no uploaded assets.</CardNote> : <CardNote tone="unknown">{sources?.release.reason ? ADOPTION_REASON_TEXT[sources.release.reason] : 'No published release reading.'}</CardNote>}
      <SourceNote reading={sources?.release} />
    </Card>
    <MutationTokenDialog open={guard.tokenOpen} reason={guard.tokenReason} onClose={guard.closeToken} />
  </div>;
}
