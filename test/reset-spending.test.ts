import { describe, expect, it } from 'vitest';
import { applyBudgetUpdate, defaultBudgetPolicy, parseBudgetUpdate, sanitizeBudgetPolicy } from '../src/core/routing/policy.js';
import { nextResetSpendingWake, projectResetSpendingStatus, reserveTaperEnabled, resetPriorityEnabled, taskResetBudget } from '../src/core/routing/reset-spending.js';
import { subscriptionOnlyCurrent, validSubscriptionOnlyBoundary } from '../src/core/routing/subscription-only.js';
import { sanitizeSeatCapacity } from '../src/core/routing/budget-store.js';
import type { SeatCapacity } from '../src/core/routing/headroom.js';
import type { BudgetPolicy } from '../src/core/routing/types.js';
import type { TaskWorkForecast } from '../src/core/routing/scheduling-types.js';
import type { EffectivePolicy } from '../src/core/authority/types.js';
const now = Date.parse('2026-10-05T12:00:00.000Z');
const at = (delta: number) => new Date(now + delta).toISOString();
const hint = 'a'.repeat(64);
const policy = (): BudgetPolicy => ({mode:'balanced',updatedAt:at(0),resetSpending:{enabled:true},seats:{claude:{seatId:'claude',enabled:true,reservePercent:40,maxSessionWindowPercent:70}}});
const standing = (floor=0): Pick<EffectivePolicy,'spend'> => ({spend:{maxMode:'all-in',meteredUsdPerDay:0,seats:{claude:{seatId:'claude',enabled:true,reserveFloorPercent:floor,maxSessionWindowPercent:70,roles:['producer']}}}});
const seat = (): SeatCapacity => ({seatId:'claude',engine:'claude',label:'Claude',free:false,signedOut:false,reachable:true,contextWindow:200000,observedAt:at(0),spentTodayUsd:null,
  accountHint:hint,subscriptionOnlyBoundary:{source:'claude-native-extra-usage',accountHint:hint,observedAt:at(0),expiresAt:at(60000),creditsEnabled:false},
  windows:[{id:'five_hour',usedPercent:10,resetsAt:at(3600000),resetDescription:null,limitReached:false},
    {id:'seven_day',usedPercent:65,resetsAt:at(45000),resetDescription:null,limitReached:false,resetProvenance:{kind:'weekly-deadline',at:at(45000),description:'Weekly.',source:'claude-native-usage-report',plan:'max'}}]});
const forecast = (): TaskWorkForecast => ({taskId:'task',recordedAt:at(0),cohort:{engine:'claude',model:'fable',seatId:'claude',taskKind:'todo'},durationMs:{p25:15000,p50:20000,p75:30000,samples:4},tokens:null,fit:'unknown',limitations:[]});
const project = (s=seat(),p=policy(),g:Pick<EffectivePolicy,'spend'>|null=standing(),f:TaskWorkForecast|undefined=forecast(),time=now) => projectResetSpendingStatus(p,[s],g,time,f?{claude:f}:{}).accounts.claude!;
describe('reset spending enrollment and current task admission',()=>{
  it('preserves legacy priority without silently enrolling taper, and OFF blocks both',()=>{
    const old=defaultBudgetPolicy(); expect(resetPriorityEnabled(old)).toBe(true);expect(reserveTaperEnabled(old,'claude')).toBe(false);
    const off=applyBudgetUpdate(old,{resetSpending:{enabled:false}},at(0)); expect(resetPriorityEnabled(off)).toBe(false);
    expect(reserveTaperEnabled({...off,seats:{claude:{seatId:'claude',enabled:true,reservePercent:40,resetSpending:true}}},'claude')).toBe(false);
    expect(project(seat(),off).state).toBe('disabled');
  });
  it('roundtrips explicit controls and inheritance across mode and seat edits',()=>{
    let p=applyBudgetUpdate(policy(),{seatId:'claude',policy:{resetSpending:false}},at(0));
    p=applyBudgetUpdate(p,{mode:'reserve'},at(1));expect(p.resetSpending?.enabled).toBe(true);expect(p.seats.claude?.resetSpending).toBe(false);
    p=applyBudgetUpdate(p,parseBudgetUpdate({seatId:'claude',policy:{resetSpending:null}}),at(2)); expect(p.seats.claude?.resetSpending).toBeUndefined();
    expect(sanitizeBudgetPolicy(JSON.parse(JSON.stringify(p)))).toEqual(p);
    expect(()=>parseBudgetUpdate({resetSpending:{enabled:true,source:'fake'}})).toThrow();
  });
  it('uses current observed work slack, retains the saved reserve and signed floor',()=>{
    const before=policy();const result=taskResetBudget(before,[seat()],standing(),now,{claude:forecast()});
    expect(result.status.accounts.claude).toMatchObject({state:'ready',savedReservePercent:40,effectiveReservePercent:20,signedFloorPercent:0});
    expect(result.budget.seats.claude?.reservePercent).toBe(20);expect(before.seats.claude?.reservePercent).toBe(40);
    expect(project(seat(),before,standing(40)).state).toBe('signed-floor');
    expect(project(seat(),before,standing(10),forecast(),now+10000).effectiveReservePercent).toBe(15);
  });
  it('never claims an applied reserve from a GET without an actual task or inactive authority',()=>{
    expect(projectResetSpendingStatus(policy(),[seat()],standing(),now).accounts.claude?.effectiveReservePercent).toBeNull();
    const paused=projectResetSpendingStatus(policy(),[seat()],standing(),now,{}, {authorityState:'paused'}).accounts.claude!;
    expect(paused).toMatchObject({state:'authority-paused',effectiveReservePercent:null,signedFloorPercent:0});
  });
  it('holds unknown billing, stale evidence, account changes, no samples and work too long',()=>{
    const unknown=seat();delete unknown.subscriptionOnlyBoundary;expect(project(unknown).state).toBe('overage-unverified');
    const changed=seat();changed.accountHint='b'.repeat(64);expect(project(changed).state).toBe('overage-unverified');
    expect(project(seat(),policy(),standing(),forecast(),now+60000).state).toBe('unqualified');
    const noHistory=forecast();noHistory.durationMs=null;expect(project(seat(),policy(),standing(),noHistory).state).toBe('waiting-for-estimate');
    const long=forecast();long.durationMs={p25:50000,p50:55000,p75:60000,samples:3};expect(project(seat(),policy(),standing(),long).state).toBe('cannot-fit');
  });
  it('retains every binding usage constraint and excludes purchased billing',()=>{
    const short=seat();short.windows[0]!.usedPercent=71;expect(project(short).state).toBe('held');
    const denied=seat();denied.windows[1]!.limitReached=true;denied.windows[1]!.usedPercent=100;expect(project(denied).state).toBe('held');
    const credits=seat();credits.costBasis='credits';expect(project(credits).state).toBe('unqualified');
    const noRole=standing();noRole.spend.seats.claude!.roles=['judge'];expect(project(seat(),policy(),noRole).state).toBe('producer-not-granted');
  });
  it('never converts billing visibility or falsy malformed native data into a capability',()=>{
    const s=seat();expect(subscriptionOnlyCurrent(s,now)).toBe(true);
    expect(validSubscriptionOnlyBoundary({...s.subscriptionOnlyBoundary,creditsEnabled:0})).toBe(false);
    expect(validSubscriptionOnlyBoundary({...s.subscriptionOnlyBoundary,creditsEnabled:true})).toBe(false);
    expect(validSubscriptionOnlyBoundary({...s.subscriptionOnlyBoundary,source:'grok-native-billing'})).toBe(false);
    const clean=sanitizeSeatCapacity({...s,subscriptionOnlyBoundary:{...s.subscriptionOnlyBoundary,accountHint:'b'.repeat(64)}})!;
    expect(clean.subscriptionOnlyBoundary).toBeUndefined();
  });
  it('schedules only a positive work-derived boundary and labels pooled forecasts',()=>{
    const status=projectResetSpendingStatus(policy(),[seat()],standing(),now,{claude:forecast()});
    expect(nextResetSpendingWake(status,now)).toBe(now+15000);
    const pooled=forecast();pooled.cohort.seatId=null;expect(project(seat(),policy(),standing(),pooled).forecastBasis?.pooled).toBe(true);
    expect(nextResetSpendingWake(projectResetSpendingStatus({...policy(),resetSpending:{enabled:false}},[seat()],standing(),now,{claude:forecast()}),now)).toBeNull();
  });
});
