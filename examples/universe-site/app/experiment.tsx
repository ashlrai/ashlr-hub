'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { LineageGraph } from './lineage-graph';

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
  const surface = useRef<HTMLDivElement>(null);
  const [playback, setPlayback] = useState<
    'idle' | 'playing' | 'paused' | 'complete'
  >('idle');
  const timeline = useMemo(
    () =>
      evidence.generations.flatMap((g) =>
        g.trials.map((trial) => ({ ...trial, generation: g.generation })),
      ),
    [evidence],
  );
  const [generation, setGeneration] = useState(2);
  const [selectedId, setSelectedId] = useState<string | undefined>(
    evidence.generations[1]?.trials[0]?.id,
  );
  const all = evidence.generations.flatMap((g) => g.trials);
  const chosen = all.find((t) => t.id === selectedId);
  const parent = all.find((t) => t.id === chosen?.parentTrialId);
  const maxBytes = Math.max(1, ...all.map((t) => t.artifactBytes ?? 0));
  const step = timeline.findIndex((trial) => trial.id === selectedId);
  const pauseForSelection = () =>
    setPlayback((state) => (state === 'idle' ? 'idle' : 'paused'));
  const selectStep = (index: number) => {
    const trial = timeline[index];
    if (!trial) return;
    setGeneration(trial.generation);
    setSelectedId(trial.id);
  };
  const play = () => {
    if (timeline.length === 0) return;
    if (playback !== 'paused' || step < 0 || step === timeline.length - 1)
      selectStep(0);
    setPlayback(timeline.length === 1 ? 'complete' : 'playing');
  };
  useEffect(() => {
    if (playback !== 'playing') return;
    // Playback only walks immutable recorded results. It never dispatches a
    // worker, fetches evidence or synthesizes intermediate measurements.
    const timer = window.setTimeout(() => {
      const next = timeline[step + 1];
      if (!next) {
        setPlayback('complete');
        return;
      }
      setGeneration(next.generation);
      setSelectedId(next.id);
      if (step + 1 === timeline.length - 1) setPlayback('complete');
    }, 4000);
    return () => window.clearTimeout(timer);
  }, [playback, step, timeline]);
  useEffect(() => {
    const pause = () =>
      setPlayback((state) => (state === 'playing' ? 'paused' : state));
    const onVisibility = () => {
      if (document.hidden) pause();
    };
    document.addEventListener('visibilitychange', onVisibility);
    const observer =
      typeof IntersectionObserver === 'undefined'
        ? undefined
        : new IntersectionObserver((entries) => {
            if (entries.some((entry) => !entry.isIntersecting)) pause();
          });
    if (surface.current) observer?.observe(surface.current);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      observer?.disconnect();
    };
  }, []);
  const selectGeneration = (value: unknown) => {
    const next = Number(value);
    if (next !== 1 && next !== 2) return;
    pauseForSelection();
    setGeneration(next);
    setSelectedId(
      evidence.generations.find((g) => g.generation === next)?.trials[0]?.id,
    );
  };
  return (
    <div className="experiment-surface" ref={surface}>
      <div className="experiment-toolbar">
        <div>
          <strong>Stable deduplication</strong>
          <p>Recorded deterministic demonstration</p>
        </div>
        <a className="text-link" href="/evidence/demo.json" download>
          Download evidence
        </a>
      </div>
      <div className="replay-deck">
        <div className="replay-heading">
          <strong>Follow the search</strong>
          <span>Recorded data. No live agents.</span>
        </div>
        <fieldset
          className="replay-controls"
          aria-label="Recorded search playback"
        >
          <button
            type="button"
            className="replay-primary"
            disabled={timeline.length === 0}
            onClick={
              playback === 'playing' ? () => setPlayback('paused') : play
            }
          >
            {playback === 'playing'
              ? 'Pause replay'
              : playback === 'paused' && step < timeline.length - 1
                ? 'Resume replay'
                : playback === 'complete'
                  ? 'Replay again'
                  : 'Play recorded search'}
          </button>
          <button
            type="button"
            aria-label="Previous recorded trial"
            disabled={step <= 0}
            onClick={() => {
              setPlayback('paused');
              selectStep(step - 1);
            }}
          >
            Previous
          </button>
          <button
            type="button"
            aria-label="Next recorded trial"
            disabled={step < 0 || step >= timeline.length - 1}
            onClick={() => {
              setPlayback('paused');
              selectStep(step + 1);
            }}
          >
            Next
          </button>
        </fieldset>
        <output className="replay-status" aria-live="polite">
          {timeline[step]
            ? `Step ${step + 1} of ${timeline.length}: generation ${timeline[step].generation}, ${timeline[step].variant}. ${playback === 'complete' ? 'Replay complete.' : playback === 'paused' ? 'Paused.' : playback === 'playing' ? 'Playing.' : 'Ready to replay.'}`
            : 'No recorded trials available.'}
        </output>
        <ol className="replay-track" aria-label="Recorded trial sequence">
          {timeline.map((trial, index) => (
            <li key={trial.id}>
              <button
                type="button"
                aria-current={step === index ? 'step' : undefined}
                aria-label={`Go to recorded step ${index + 1}: generation ${trial.generation}, ${trial.variant}`}
                onClick={() => {
                  setPlayback('paused');
                  selectStep(index);
                }}
              >
                <span className="replay-dot" aria-hidden="true" />
                <span>
                  G{trial.generation} / {trial.variant}
                </span>
              </button>
            </li>
          ))}
        </ol>
      </div>
      <LineageGraph
        evidence={evidence}
        selectedId={selectedId}
        onSelect={(id, nextGeneration) => {
          pauseForSelection();
          setGeneration(nextGeneration);
          setSelectedId(id);
        }}
      />
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
                    onClick={() => {
                      pauseForSelection();
                      setSelectedId(t.id);
                    }}
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
              <aside
                className="trial-inspector"
                aria-live={playback === 'playing' ? 'off' : 'polite'}
              >
                <p className="release-note">Trial inspector</p>
                <h3>{chosen?.variant ?? 'Select a trial'}</h3>
                <p>
                  {!chosen
                    ? 'Choose a recorded trial to inspect its evidence.'
                    : chosen.selected
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
