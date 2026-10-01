import { describe, expect, it } from 'vitest';
import { assessResetOpportunity, opportunityPriority, validResetProvenance } from '../src/core/routing/reset-pressure.js';
import { forecastWork, observedPercentiles } from '../src/core/routing/work-estimates.js';
import { buildSchedulingView, historySamples } from '../src/core/routing/scheduling.js';
import { routeSeat } from '../src/core/routing/router.js';
import type { SeatCapacity } from '../src/core/routing/headroom.js';
import type { BudgetPolicy } from '../src/core/routing/types.js';
import type { WorkHistorySample } from '../src/core/routing/work-estimates.js';
import type { DispatchProductionEvent } from '../src/core/fleet/dispatch-production-ledger.js';

const now = Date.parse('2026-10-01T12:00:00.000Z');
const at = (delta:number) => new Date(now+delta).toISOString();
const seat = (id='a', over:Partial<SeatCapacity> = {}):SeatCapacity => ({seatId:id,engine:'grok',label:id,free:false,signedOut:false,
  reachable:true,contextWindow:256000,observedAt:at(0),spentTodayUsd:null,
  windows:[{id:'grok_weekly',usedPercent:20,resetsAt:at(3600000),resetDescription:null,limitReached:false,
    resetProvenance:{kind:'fixed-period',startsAt:at(-6*86400000),at:at(3600000),description:'Weekly period.',source:'grok-native-billing'}}],...over});
const policy:BudgetPolicy={mode:'all-in',updatedAt:at(0),seats:{}};
const enabled={seatId:'a',enabled:true,reservePercent:0};
const request={task:'code' as const,difficulty:'high' as const,autonomous:true};
const cohort={engine:'grok-cli',model:'model-a',seatId:null,taskKind:'todo'};
const sample=(id:string,over:Partial<WorkHistorySample>={}):WorkHistorySample=>({id,...cohort,completed:true,durationMs:10000,tokens:1000,...over});

describe('reset provenance and opportunity',()=>{
  it('fixed provider period retains the real interval; date-only reset is ordinary',()=>{
    const reported=seat();expect(assessResetOpportunity(reported,enabled,now).opportunity.kind).toBe('before-reset');
    const dateOnly=seat('b',{windows:reported.windows.map(({resetProvenance:_,...window})=>window)});
    expect(assessResetOpportunity(dateOnly,enabled,now)).toMatchObject({admission:'eligible',reset:{kind:'unknown',at:at(3600000)},opportunity:{kind:'ordinary'}});
  });
  it.each(['pro','max'] as const)('uses qualified native %s weekly deadline without inventing a period start', plan => {
    const weekly = {kind:'weekly-deadline' as const,at:at(60000),description:null,source:'claude-native-usage-report',plan};
    const claude = seat('claude',{engine:'claude',windows:[
      {id:'five_hour',usedPercent:5,resetsAt:at(3600000),resetDescription:null,limitReached:false,
        resetProvenance:{kind:'rolling-release',at:at(3600000),description:null,source:'claude-native-usage-report'}},
      {id:'seven_day',usedPercent:20,resetsAt:weekly.at,resetDescription:null,limitReached:false,resetProvenance:weekly},
    ]});
    expect(validResetProvenance(weekly)).toBe(true);
    const known = forecastWork('task',{...cohort,engine:'claude',model:'opus'},[sample('short',{engine:'claude',model:'opus',durationMs:10000})]);
    const view = assessResetOpportunity(claude,{...enabled,seatId:'claude'},now,known);
    expect(view).toMatchObject({admission:'eligible',reset:weekly,opportunity:{kind:'before-reset'},forecast:{fit:'likely-before-reset'}});
    expect(view.reset).not.toHaveProperty('startsAt');
    expect(assessResetOpportunity(claude,{...enabled,seatId:'claude',reservePercent:90},now,known).admission).toBe('held');
    claude.observedAt=at(-16*60000);
    expect(assessResetOpportunity(claude,{...enabled,seatId:'claude'},now,known).admission).toBe('unknown');
  });
  it.each(['wrong-provider','model-window','deadline-mismatch','ended','conflicting-window'] as const)('does not promote %s weekly evidence', fault => {
    const s=seat('claude',{engine:'claude',windows:[{id:'seven_day',usedPercent:20,resetsAt:at(60000),resetDescription:null,limitReached:false,
      resetProvenance:{kind:'weekly-deadline',at:at(60000),description:null,source:'claude-native-usage-report',plan:'max'}}]});
    if(fault==='wrong-provider')s.engine='codex';
    if(fault==='model-window')s.windows[0]!.id='seven_day_fable';
    if(fault==='deadline-mismatch')s.windows[0]!.resetsAt=at(120000);
    if(fault==='ended'){s.windows[0]!.resetsAt=at(-1);s.windows[0]!.resetProvenance!.at=at(-1);}
    if(fault==='conflicting-window')s.windows.push({id:'five_hour',usedPercent:5,resetsAt:at(-1),resetDescription:null,limitReached:false});
    const view=assessResetOpportunity(s,{...enabled,seatId:'claude'},now);
    expect(view.opportunity.kind).not.toBe('before-reset');
  });
  it.each([
    {source:'other',plan:'max'},{source:'claude-native-usage-report',plan:'team'},
    {source:'claude-native-usage-report'},{source:'claude-native-usage-report',plan:'max',startsAt:at(-7*86400000)},
  ])('rejects unqualified weekly policy %j', extra => {
    expect(validResetProvenance({kind:'weekly-deadline',at:at(60000),description:null,...extra})).toBe(false);
  });
  it('rolling release is carried as rolling, without allowance-expiry urgency',()=>{
    const s=seat();s.windows[0]!.resetProvenance={kind:'rolling-release',at:at(3600000),description:'Rolling release.',source:'fixture'};
    expect(assessResetOpportunity(s,enabled,now)).toMatchObject({reset:{kind:'rolling-release'},opportunity:{kind:'ordinary'}});
  });
  it.each(['old','future-observation','ended-period','not-started','conflicting-window'] as const)('does not schedule from %s evidence',kind=>{
    const s=seat();
    if(kind==='old')s.observedAt=at(-16*60000);
    if(kind==='future-observation')s.observedAt=at(1);
    if(kind==='ended-period')s.windows[0]!.resetsAt=at(-1);
    if(kind==='not-started')s.windows[0]!.resetProvenance!.startsAt=at(1);
    if(kind==='conflicting-window')s.windows.push({id:'grok_other',usedPercent:10,resetsAt:at(-1),resetDescription:null,limitReached:false});
    const view=assessResetOpportunity(s,enabled,now);
    expect(view.admission).toBe('unknown');expect(view.opportunity.kind).toBe('unknown');
    expect(routeSeat(request,[s],policy,{nowMs:now,scheduling:{a:view}}).seatId).toBeNull();
  });
  it('retains policy reserves and unknown usage instead of treating them as unused allowance',()=>{
    expect(assessResetOpportunity(seat(),{...enabled,reservePercent:90},now)).toMatchObject({admission:'held',opportunity:{kind:'held'}});
    const s=seat();s.windows[0]!.usedPercent=null;
    expect(assessResetOpportunity(s,enabled,now).admission).toBe('unknown');
  });
  it('does not let a per-model expired window block an otherwise current Claude account',()=>{
    const s=seat('claude',{engine:'claude',windows:[{id:'five_hour',usedPercent:5,resetsAt:null,resetDescription:'in two hours',limitReached:false},
      {id:'seven_day',usedPercent:10,resetsAt:null,resetDescription:'Friday',limitReached:false},
      {id:'seven_day_fable',usedPercent:100,resetsAt:at(-1),resetDescription:null,limitReached:true}]});
    expect(assessResetOpportunity(s,{...enabled,seatId:'claude'},now).admission).toBe('eligible');
  });
  it.each([{kind:'fixed-period',at:at(1),startsAt:null,description:null,source:'fixture'},
    {kind:'balance',at:at(1),description:null,source:'fixture'},
    {kind:'fixed-period',at:at(1),startsAt:at(2),description:null,source:'fixture'}])('refuses unsupported/inconsistent semantics %j',value=>{
    expect(validResetProvenance(value)).toBe(false);
  });
});

describe('continuous deadline proximity',()=>{
  function opportunity(remaining:number,durations:number[]) {
    const s=seat();s.windows[0]!.resetsAt=at(remaining);s.windows[0]!.resetProvenance!.at=at(remaining);
    const forecast=forecastWork('task',cohort,durations.map((durationMs,i)=>sample(String(i),{durationMs})));
    return assessResetOpportunity(s,enabled,now,forecast);
  }
  it('prioritizes work near its p75 boundary over a much shorter task a week before reset',()=>{
    const far=opportunity(7*86400000,[10000]);const near=opportunity(660000,[600000]);
    expect(far.forecast?.fit).toBe('likely-before-reset');expect(near.forecast?.fit).toBe('likely-before-reset');
    expect(opportunityPriority(near,now)).toBeGreaterThan(opportunityPriority(far,now));
    expect(opportunityPriority(near,now+30000)).toBeGreaterThan(opportunityPriority(near,now));
    expect(opportunityPriority(near,now+660000)).toBe(0);
  });
  it('preserves likely-over-uncertain fit and refuses unlikely, unknown and invalid-time priority',()=>{
    const likely=opportunity(7*86400000,[10000]);const uncertain=opportunity(500,[100,1000]);
    expect(uncertain.forecast?.fit).toBe('uncertain');
    expect(opportunityPriority(uncertain,now)).toBeGreaterThan(0);
    expect(opportunityPriority(likely,now)).toBeGreaterThan(opportunityPriority(uncertain,now));
    expect(opportunityPriority(opportunity(50,[100,1000]),now)).toBe(0);
    expect(opportunityPriority(opportunity(1000,[]),now)).toBe(0);
    expect(opportunityPriority(likely,NaN)).toBe(0);
    expect(opportunityPriority({...likely,admission:'held'},now)).toBe(0);
    expect(opportunityPriority({...likely,admission:'unknown'},now)).toBe(0);
  });
  it('uses relative work fit rather than only the earliest calendar deadline in actual same-tier routing',()=>{
    const earlier=seat('a');earlier.windows[0]!.resetsAt=at(60000);earlier.windows[0]!.resetProvenance!.at=at(60000);
    const nearWork=seat('b');nearWork.windows[0]!.resetsAt=at(660000);nearWork.windows[0]!.resetProvenance!.at=at(660000);
    const short=forecastWork('short',cohort,[sample('short',{durationMs:1000})]);
    const long=forecastWork('long',cohort,[sample('long',{durationMs:600000})]);
    const scheduling=Object.fromEntries(buildSchedulingView([earlier,nearWork],policy,now,{a:short,b:long}).accounts.map(v=>[v.seatId,v]));
    expect(routeSeat(request,[earlier,nearWork],policy,{nowMs:now,scheduling}).seatId).toBe('b');
    expect(routeSeat(request,[earlier,nearWork],{...policy,seats:{b:{...enabled,seatId:'b',reservePercent:90}}},{nowMs:now,scheduling}).seatId).toBe('a');
  });
});

describe('observed task estimates',()=>{
  it('keeps duration and token observation counts independent and deduplicates runs',()=>{
    const f=forecastWork('task',cohort,[sample('1'),sample('1'),sample('2',{durationMs:20000,tokens:null}),sample('3',{durationMs:null,tokens:3000})]);
    expect(f.durationMs).toMatchObject({samples:2});expect(f.tokens).toMatchObject({samples:2});
    expect(f.cohort.seatId).toBeNull();expect(f.limitations.join(' ')).toMatch(/pooled/);
  });
  it('ignores failed, zero, mismatched model/engine/task/account history without all-history fallback',()=>{
    const f=forecastWork('task',cohort,[sample('failed',{completed:false}),sample('zero',{durationMs:0,tokens:0}),
      sample('model',{model:'other'}),sample('engine',{engine:'codex'}),sample('task',{taskKind:'ci-fail'})]);
    expect(f.durationMs).toBeNull();expect(f.tokens).toBeNull();
    expect(forecastWork('task',{...cohort,seatId:'a'},[sample('pooled')]).durationMs).toBeNull();
    expect(forecastWork('task',{...cohort,model:null},[sample('unknown',{model:null})]).durationMs).toBeNull();
  });
  it('distinguishes a short useful task from one unlikely to finish before this period',()=>{
    const s=seat();s.windows[0]!.resetProvenance!.at=at(100000);s.windows[0]!.resetsAt=at(100000);
    const short=forecastWork('short',cohort,[sample('short',{durationMs:10000})]);
    const long=forecastWork('long',cohort,[sample('long',{durationMs:200000})]);
    expect(assessResetOpportunity(s,enabled,now,short).forecast?.fit).toBe('likely-before-reset');
    expect(assessResetOpportunity(s,enabled,now,long)).toMatchObject({forecast:{fit:'unlikely-before-reset'},opportunity:{kind:'ordinary'}});
  });
  it('uses conservative nearest-rank upper quartiles for sparse observations',()=>{
    expect(observedPercentiles([1000,100000])).toEqual({p25:1000,p50:1000,p75:100000,samples:2});
  });
  it('never projects another provider/account estimate into a current account',()=>{
    const wrong=forecastWork('task',{...cohort,engine:'codex'},[sample('codex',{engine:'codex'})]);
    expect(buildSchedulingView([seat()],policy,now,{a:wrong}).accounts[0]!.forecast).toBeNull();
    const wrongAccount={...forecastWork('task',cohort,[sample('ok')]),cohort:{...cohort,seatId:'another'}};
    expect(buildSchedulingView([seat()],policy,now,{a:wrongAccount}).accounts[0]!.forecast).toBeNull();
  });
  it('uses only completed reported metadata, with initialized zeros unknown',()=>{
    const event={backend:'grok-cli',model:'model-a',source:'todo',attemptId:'attempt',runEventSummary:{status:'done',durationMs:30000,tokensIn:400,tokensOut:10}} as DispatchProductionEvent;
    expect(historySamples([event])).toMatchObject([{durationMs:30000,tokens:410,seatId:null}]);
    expect(historySamples([{...event,runEventSummary:{status:'running',durationMs:30000}}])).toEqual([]);
    expect(forecastWork('task',cohort,historySamples([{...event,runEventSummary:{status:'done',durationMs:0,tokensIn:0,tokensOut:0}}])).durationMs).toBeNull();
  });
});

describe('routing integration',()=>{
  it('prefers an eligible imminent fixed period within the same quality tier, never a spent account',()=>{
    const later=seat('a');const sooner=seat('b');sooner.windows[0]!.resetsAt=at(60000);sooner.windows[0]!.resetProvenance!.at=at(60000);
    const known=forecastWork('task',cohort,[sample('short',{durationMs:10000})]);
    const views=buildSchedulingView([later,sooner],policy,now,{a:known,b:known});const scheduling=Object.fromEntries(views.accounts.map(v=>[v.seatId,v]));
    expect(routeSeat(request,[later,sooner],policy,{nowMs:now,scheduling}).seatId).toBe('b');
    sooner.windows[0]!.usedPercent=100;
    expect(routeSeat(request,[later,sooner],policy,{nowMs:now,scheduling,advisorySeatId:'b'}).seatId).toBe('a');
  });
  it('uses a qualified weekly deadline for an actual same-tier choice without widening reserves',()=>{
    const ordinary=seat('a',{engine:'claude',windows:[{id:'seven_day',usedPercent:20,resetsAt:null,resetDescription:'Friday',limitReached:false}]});
    const weekly=seat('b',{engine:'claude',windows:[{id:'seven_day',usedPercent:20,resetsAt:at(60000),resetDescription:null,limitReached:false,
      resetProvenance:{kind:'weekly-deadline',at:at(60000),description:null,source:'claude-native-usage-report',plan:'pro'}}]});
    const known=forecastWork('task',{...cohort,engine:'claude',model:'opus'},[sample('short',{engine:'claude',model:'opus'})]);
    const views=Object.fromEntries(buildSchedulingView([ordinary,weekly],policy,now,{b:known}).accounts.map(v=>[v.seatId,v]));
    expect(routeSeat(request,[ordinary,weekly],policy,{nowMs:now,scheduling:views}).seatId).toBe('b');
    const reserved={...policy,seats:{b:{seatId:'b',enabled:true,reservePercent:90}}};
    expect(routeSeat(request,[ordinary,weekly],reserved,{nowMs:now,scheduling:views,advisorySeatId:'b'}).seatId).toBe('a');
  });
  it('a distant fixed date without a compatible duration does not displace ordinary admitted work',()=>{
    const a=seat('a',{windows:[{id:'grok_weekly',usedPercent:10,resetsAt:null,resetDescription:null,limitReached:false}]});
    const b=seat('b');b.windows[0]!.resetsAt=at(90*86400000);b.windows[0]!.resetProvenance!.at=at(90*86400000);
    const scheduling=Object.fromEntries(buildSchedulingView([a,b],policy,now).accounts.map(v=>[v.seatId,v]));
    expect(routeSeat(request,[a,b],policy,{nowMs:now,scheduling}).seatId).toBe('a');
  });
  it('remains a globally defined ranking under interleaved non-default weighted tiers and all permutations',()=>{
    const a=seat('a');a.windows[0]!.usedPercent=5;
    const b=seat('b');b.windows[0]!.usedPercent=75;
    const c=seat('c',{engine:'codex',tier:'frontier'});c.windows[0]!.id='codex_primary';c.windows[0]!.usedPercent=40;
    const options={nowMs:now,weights:{lambdaCost:2,lambdaPressure:5,lambdaLatency:0}};
    const baseline=routeSeat(request,[a,b,c],policy,options).candidates;
    const scheduling=Object.fromEntries(buildSchedulingView([a,b,c],policy,now).accounts.map(v=>[v.seatId,v]));
    const permutations=[[a,b,c],[a,c,b],[b,a,c],[b,c,a],[c,a,b],[c,b,a]];
    for(const seats of permutations){
      const ranked=routeSeat(request,seats,policy,{...options,scheduling,advisorySeatId:'b'}).candidates;
      expect(ranked.indexOf('c')).toBe(baseline.indexOf('c'));
      expect(ranked.filter(id=>id!=='c')).toEqual(['b','a']);
    }
  });
  it('advice actually changes an equal-tier tie but cannot bypass a higher quality tier/context or reserve',()=>{
    const a=seat('a');const b=seat('b');const views=buildSchedulingView([a,b],policy,now);const scheduling=Object.fromEntries(views.accounts.map(v=>[v.seatId,v]));
    expect(routeSeat(request,[a,b],policy,{nowMs:now,scheduling}).seatId).toBe('a');
    expect(routeSeat(request,[a,b],policy,{nowMs:now,scheduling,advisorySeatId:'b'}).seatId).toBe('b');
    b.contextWindow=10;
    expect(routeSeat({...request,contextTokens:1000},[a,b],policy,{nowMs:now,scheduling,advisorySeatId:'b'}).seatId).toBe('a');
    b.engine='local';b.free=true;
    expect(routeSeat(request,[a,b],policy,{nowMs:now,scheduling,advisorySeatId:'b'}).seatId).toBe('a');
  });
});
