'use client';

import { useState } from 'react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';

export type Trial = {
  id: string;
  variant: string;
  niche: string;
  status: string;
  selected: boolean;
  parentTrialId: string | null;
  artifactBytes: number | null;
  casesPassed: number | null;
  delta: number | null;
};
export type Evidence = {
  sourceRevision?: string;
  generatedAt: string;
  verified: boolean;
  checks: Record<string, boolean>;
  generations: { generation: number; status: string; trials: Trial[] }[];
};

export function Experiment({ evidence }: { evidence: Evidence }) {
  const [generation, setGeneration] = useState(2);
  const [selectedId, setSelectedId] = useState<string | undefined>(
    evidence.generations[1]?.trials[0]?.id,
  );
  const all = evidence.generations.flatMap((g) => g.trials);
  const chosen = all.find((t) => t.id === selectedId);
  const parent = all.find((t) => t.id === chosen?.parentTrialId);
  const maxBytes = Math.max(1, ...all.map((t) => t.artifactBytes ?? 0));
  const selectGeneration = (value: unknown) => {
    const next = Number(value);
    if (next !== 1 && next !== 2) return;
    setGeneration(next);
    setSelectedId(
      evidence.generations.find((g) => g.generation === next)?.trials[0]?.id,
    );
  };
  return (
    <div className="experiment-surface">
      <div className="experiment-toolbar">
        <div>
          <strong>Stable deduplication</strong>
          <p>Recorded deterministic demonstration</p>
        </div>
        <a className="text-link" href="/evidence/demo.json" download>
          Download evidence
        </a>
      </div>
      <Tabs value={generation} onValueChange={selectGeneration}>
        <TabsList className="generation-tabs" aria-label="Recorded generation">
          <TabsTrigger value={1}>Generation 1</TabsTrigger>
          <TabsTrigger value={2}>Generation 2</TabsTrigger>
        </TabsList>
        {evidence.generations.map((g) => (
          <TabsContent key={g.generation} value={g.generation}>
            <div className="trial-layout">
              <fieldset
                className="trial-list"
                aria-label={`Generation ${g.generation} trials`}
              >
                <p className="chart-caption">
                  Artifact size · smaller is better after correctness passes
                </p>
                {g.trials.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    aria-label={`Inspect ${t.variant}, generation ${g.generation}`}
                    aria-pressed={selectedId === t.id}
                    className={`trial ${t.selected ? '' : 'failed'}`}
                    onClick={() => setSelectedId(t.id)}
                  >
                    <span className="trial-top">
                      <strong>{t.variant}</strong>
                      <span>{t.selected ? 'Retained' : 'Rejected'}</span>
                    </span>
                    <span className="bar-track">
                      <span
                        className="bar"
                        style={{
                          width: `${((t.artifactBytes ?? 0) / maxBytes) * 100}%`,
                        }}
                      />
                    </span>
                    <span className="trial-bottom">
                      <span>
                        {t.artifactBytes === null
                          ? 'No passing score'
                          : `${t.artifactBytes} bytes`}
                      </span>
                      <span>
                        {t.casesPassed === null
                          ? 'Correctness failed'
                          : `${t.casesPassed}/7 cases passed`}
                      </span>
                    </span>
                  </button>
                ))}
              </fieldset>
              <aside className="trial-inspector" aria-live="polite">
                <p className="release-note">Trial inspector</p>
                <h3>{chosen?.variant ?? 'Select a trial'}</h3>
                <p>
                  {chosen?.selected
                    ? 'This candidate passed the fixed evaluator and was retained in its niche.'
                    : 'The evaluator rejected this candidate. A smaller file cannot compensate for incorrect output.'}
                </p>
                <dl>
                  <div>
                    <dt>Niche</dt>
                    <dd>{chosen?.niche}</dd>
                  </div>
                  <div>
                    <dt>Measured improvement</dt>
                    <dd>
                      {chosen?.delta === null || chosen?.delta === undefined
                        ? 'No prior score'
                        : `${chosen.delta} bytes`}
                    </dd>
                  </div>
                  <div>
                    <dt>Parent</dt>
                    <dd>
                      {parent
                        ? `${parent.variant} · generation 1`
                        : 'Pinned seed'}
                    </dd>
                  </div>
                </dl>
                {parent && (
                  <div className="lineage">
                    <span>{parent.artifactBytes} B</span>
                    <span aria-label="to">→</span>
                    <strong>
                      {chosen?.artifactBytes === null
                        ? 'Rejected'
                        : `${chosen?.artifactBytes} B`}
                    </strong>
                  </div>
                )}
              </aside>
            </div>
          </TabsContent>
        ))}
      </Tabs>
      <div className="checks">
        <strong>Verified in the recorded run</strong>
        <ul>
          <li>Broken variant rejected</li>
          <li>Both useful niches retained</li>
          <li>Previous winners reused</li>
          <li>Second-generation improvement measured</li>
        </ul>
      </div>
      <p className="evidence-caption">
        Captured {evidence.generatedAt.slice(0, 10)}.{' '}
        <a
          href={`https://github.com/ashlrai/ashlr-hub/commit/${evidence.sourceRevision}`}
        >
          Source {evidence.sourceRevision?.slice(0, 8)}
        </a>
        . Fixed workers, not AI-generated proposals. File size is this demo’s
        metric, not a universal measure of code quality.{' '}
        <a href="/evidence/demo.svg" download>
          Download the lineage diagram
        </a>
        .
      </p>
    </div>
  );
}
