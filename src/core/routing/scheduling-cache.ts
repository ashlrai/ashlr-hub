/** Private advisory cache. Never read as authority; GET only reuses recorded task estimates. */
import { constants } from 'node:fs';
import { mkdir, open, rename, rm, lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SchedulingView, SchedulingAdviceView, TaskWorkForecast, ObservedPercentiles } from './scheduling-types.js';

// Same finite cache-byte class as routing capacity snapshots; not a task/account quota.
const MAX_CACHE_BYTES = 1024 * 1024;
const cachePath = () => join(homedir(), '.ashlr', 'routing', 'scheduling.json');
const owned = (uid: number) => typeof process.getuid !== 'function' || uid === process.getuid();
function stats(value: unknown): value is ObservedPercentiles | null {
  if (value === null) return true;
  if (!value || typeof value !== 'object') return false;
  const v = value as ObservedPercentiles;
  return Number.isSafeInteger(v.samples) && v.samples > 0 && [v.p25,v.p50,v.p75].every((n) => Number.isFinite(n) && n > 0 && n <= Number.MAX_SAFE_INTEGER) &&
    v.p25 <= v.p50 && v.p50 <= v.p75;
}
function forecast(value: unknown): value is TaskWorkForecast {
  if (!value || typeof value !== 'object') return false;
  const v = value as TaskWorkForecast;
  const text = (s: unknown) => typeof s === 'string' && s.length > 0 && s.length <= 4096;
  return text(v.taskId) && (v.recordedAt===undefined || typeof v.recordedAt==='string' && Number.isFinite(Date.parse(v.recordedAt)) && new Date(v.recordedAt).toISOString()===v.recordedAt) && !!v.cohort && text(v.cohort.engine) && text(v.cohort.taskKind) &&
    (v.cohort.model === null || text(v.cohort.model)) && (v.cohort.seatId === null || text(v.cohort.seatId)) &&
    stats(v.durationMs) && stats(v.tokens) && ['likely-before-reset','uncertain','unlikely-before-reset','unknown'].includes(v.fit) &&
    Array.isArray(v.limitations) && v.limitations.every(text);
}

export async function readRecordedScheduling(path = cachePath()): Promise<{forecasts:Record<string,TaskWorkForecast>;advisory?:SchedulingAdviceView}> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || !owned(info.uid) || process.platform !== 'win32' && (info.mode & 0o077) !== 0 ||
      info.size <= 0 || info.size > MAX_CACHE_BYTES) return {forecasts:{}};
    const bytes = Buffer.alloc(info.size); const { bytesRead } = await handle.read(bytes,0,bytes.length,0);
    const after = await handle.stat();
    if (bytesRead !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs) return {forecasts:{}};
    const value: unknown = JSON.parse(bytes.toString('utf8'));
    if (!value || typeof value !== 'object' || !Array.isArray((value as SchedulingView).accounts)) return {forecasts:{}};
    const out: Record<string,TaskWorkForecast> = Object.create(null) as Record<string,TaskWorkForecast>;
    const seen = new Set<string>();
    for (const row of (value as SchedulingView).accounts) {
      if (!row || typeof row.seatId !== 'string' || seen.has(row.seatId) || ['__proto__','constructor','prototype'].includes(row.seatId)) return {forecasts:{}};
      seen.add(row.seatId);
      if (row.forecast !== null && !forecast(row.forecast)) return {forecasts:{}};
      if (row.forecast) {
        const v = row.forecast;
        const metric = (m: ObservedPercentiles | null) => m === null ? null : ({p25:m.p25,p50:m.p50,p75:m.p75,samples:m.samples});
        out[row.seatId] = { taskId:v.taskId,...(v.recordedAt ? {recordedAt:v.recordedAt} : {}),cohort:{engine:v.cohort.engine,model:v.cohort.model,seatId:v.cohort.seatId,taskKind:v.cohort.taskKind},
          durationMs:metric(v.durationMs),tokens:metric(v.tokens),fit:v.fit,limitations:[...v.limitations] };
      }
    }
    const raw = (value as SchedulingView).advisory;
    const validAdvice = raw && typeof raw.observedAt==='string' && Number.isFinite(Date.parse(raw.observedAt)) &&
      ['choice-returned','fallback','skipped'].includes(raw.state) &&
      ['signed-metered-unavailable','metered-allowance-exhausted','no-comparable-pairs','no-eligible-choice','eligible-choice-returned'].includes(raw.reason);
    return {forecasts:out,...(validAdvice ? {advisory:{observedAt:raw.observedAt,state:raw.state,reason:raw.reason}} : {})};
  } catch { return {forecasts:{}}; }
  finally { await handle?.close().catch(() => undefined); }
}

export async function readRecordedForecasts(path = cachePath()): Promise<Record<string,TaskWorkForecast>> {
  return (await readRecordedScheduling(path)).forecasts;
}

export async function writeRecordedScheduling(view: SchedulingView, path = cachePath()): Promise<void> {
  const bytes = Buffer.from(JSON.stringify(view));
  if (bytes.length > MAX_CACHE_BYTES) return; // Advice can be absent; never truncate into misleading samples.
  await mkdir(dirname(path),{recursive:true,mode:0o700});
  const dir = await lstat(dirname(path));
  if (!dir.isDirectory() || dir.isSymbolicLink() || !owned(dir.uid) || process.platform !== 'win32' && (dir.mode & 0o077) !== 0) return;
  const temp = join(dirname(path),`.scheduling-${process.pid}-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temp,constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),0o600);
    await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = undefined;
    const currentDir = await lstat(dirname(path));
    if (!currentDir.isDirectory() || currentDir.isSymbolicLink() || currentDir.dev !== dir.dev || currentDir.ino !== dir.ino) return;
    await rename(temp,path);
  } finally { await handle?.close().catch(() => undefined); await rm(temp,{force:true}).catch(() => undefined); }
}
