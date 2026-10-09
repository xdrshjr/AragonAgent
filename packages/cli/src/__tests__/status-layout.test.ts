import { expect, it } from 'vitest';
import stringWidth from 'string-width';
import * as layout from '../ui/layout/status-layout.js';
const base = {
 columns: 80, phase: 'thinking' as const, pendingCount: 3,
 context: { occupied: 2100, window: 128000, pct: 2, source: 'estimate' as const, deltaTokens: 0, windowKnown: true, windowOverridden: false },
 usageTotal: { inputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 30, outputTokens: 40, costUsd: 0.0032 },
 thinkingLevel: 'xhigh', elapsedMs: 62000, tokPerSec: 12, speedKnown: true, spinner: '*',
};
it('keeps five core fields and measured separators from 40 to 200 columns', () => {
 expect(layout).toHaveProperty('planPrimaryStatusFields');
 for(let columns=40; columns<=200; columns++) {
 const plan=layout.planPrimaryStatusFields({...base, columns});
 expect(plan.fields.map(f=>f.id)).toEqual(['phase','context','thinking','speed','elapsed']);
 expect(plan.cells).toBe(stringWidth(plan.fields.map(f=>f.text).join(plan.separator)));
 expect(plan.separatorCells).toBe(stringWidth(plan.separator));
 expect(plan.cells).toBeLessThanOrEqual(columns-1);
 }
});
it('fits extreme values and preserves copy error plus force-stop', () => {
 for(const kind of ['copy-error','copy-cleanup','copy-sent','exit'] as const) {
 const plan=layout.planPrimaryStatusFields({...base,columns:40,context:{...base.context,pct:1e300},tokPerSec:1e300,elapsedMs:1e300,
 feedback:{kind,text:'custom',level:'error'},escapeAction:'force-stop',activeTool:{name:'x'.repeat(1000),toolCallId:'t'}});
 expect(plan.fields).toHaveLength(5); expect(plan.cells).toBeLessThanOrEqual(39);
 expect(plan.fields[1]!.text).toBe('C~>999%');
 if(kind==='copy-error'||kind==='copy-cleanup') expect(plan.fields[0]!.text).toMatch(/Err\/EscF|E\/F/);
 }
});
it('rejects invalid contexts', () => {
 for(const key of ['occupied','window','pct','deltaTokens'] as const) for(const value of [NaN,Infinity,-1]) {
 expect(layout.planPrimaryStatusFields({...base,columns:40,context:{...base.context,[key]:value}}).fields[1]!.text).toBe('C?');
 }
 expect(layout.planPrimaryStatusFields({...base,columns:40,context:{...base.context,windowKnown:false}}).fields[1]!.text).toBe('C?');
});
it('shows off and unknown speed while preserving final elapsed', () => {
 expect(layout.planPrimaryStatusFields({...base,phase:'idle',columns:40,thinkingLevel:'off',speedKnown:false}).fields.map(f=>f.text))
 .toEqual(['* Idle','C~2%','Th:O','--t/s','1m02s']);
});
it('fits every phase and thinking code with maximal numeric formats', () => {
 for (const phase of ['idle','starting','waiting','thinking','generating','preparing-tool','tool'] as const) {
  for (const thinkingLevel of ['off','minimal','low','medium','high','xhigh','unknown']) {
   for (const feedback of [undefined, {kind:'copy-error' as const,text:'failure',level:'error' as const}]) {
    const plan=layout.planPrimaryStatusFields({...base,columns:40,phase,thinkingLevel,
     elapsedMs:Number.MAX_VALUE,tokPerSec:Number.MAX_VALUE,context:{...base.context,pct:Number.MAX_VALUE},
     feedback,escapeAction:'force-stop'});
    expect(plan.fields).toHaveLength(5);expect(plan.cells).toBeLessThanOrEqual(39);
    expect(plan.fields[1]!.text).toBe('C~>999%');expect(plan.fields[4]!.text).toBe('>999d');
   }
  }
 }
});
it('keeps copy error plus armed stop distinct from force stop and menu', () => {
 const feedback={kind:'copy-error' as const,text:'failed',level:'error' as const};
 expect(layout.planPrimaryStatusFields({...base,columns:40,feedback,interruptPhase:'armed',escapeAction:'confirm-stop'})
  .fields[0]!.text).toMatch(/Err\/EscS|E\/S/);
 expect(layout.planPrimaryStatusFields({...base,columns:40,feedback,interruptPhase:'stopping',escapeAction:'menu'})
  .fields[0]!.text).not.toMatch(/EscF|E\/F/);
});
it('sanitizes external tool names and never interprets control bytes', () => {
 const plan=layout.planPrimaryStatusFields({...base,columns:300,activeTool:{name:'\x1b[31mtool\nname\x00',toolCallId:'t'}});
 expect(plan.fields[0]!.text).toContain('tool name');
 expect(plan.fields[0]!.text).not.toMatch(/[\x00-\x1f]/);
});
