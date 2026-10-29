import {expect,it} from 'vitest';
import stringWidth from 'string-width';
import {planStatusDetail} from '../ui/layout/status-detail-layout.js';
const status={columns:40,phase:'thinking' as const,pendingCount:2,thinkingLevel:'off',elapsedMs:1000,tokPerSec:0,speedKnown:false,
 context:{occupied:10,window:100,pct:10,source:'usage' as const,deltaTokens:0,windowKnown:true,windowOverridden:false},
 usageTotal:{inputTokens:1,outputTokens:2,cacheReadTokens:3,cacheWriteTokens:4,costUsd:0.1},
 feedback:{kind:'copy-error' as const,text:'Copy failed: '+ '中文'.repeat(100),level:'error' as const},escapeAction:'menu' as const};
it('reserves actual Escape action and detail toggle ahead of a long feedback',()=>{
 const plan=planStatusDetail({status,hints:{cols:40,interactionPhase:'running',completion:'slash',hintsEnabled:false},model:'m',provider:'p'});
 const text=plan.fields.map(f=>f.text).join(plan.separator);
 expect(text).toContain('Copy failed');expect(text).toContain('Esc menu');expect(text).toContain('^G then d');
 expect(text).not.toContain('Esc stop');expect(stringWidth(text)).toBeLessThanOrEqual(39);
});
it('keeps full context, session usage and cost in a sufficiently wide detail row',()=>{
 const plan=planStatusDetail({status:{...status,columns:350,feedback:undefined,escapeAction:undefined},
 hints:{cols:350,interactionPhase:'idle',hintsEnabled:false},model:'m',provider:'p'});
 const text=plan.fields.map(f=>f.text).join(plan.separator);
 expect(text).toContain('Context 10/100 tokens');expect(text).toContain('Session input 8 output 2');
 expect(text).toContain('Cost $0.1000');expect(text).not.toContain('newline');expect(text).toContain('^G then d');
});

it('names the mode in uppercase with the accent tone, pending included',()=>{
  const plan=planStatusDetail({status:{...status,columns:250,feedback:undefined,escapeAction:undefined,mode:'plan',pendingMode:'build'},
  hints:{cols:250,interactionPhase:'idle',hintsEnabled:false},model:'m',provider:'p'});
  const mode=plan.fields.find(f=>f.id==='mode');
  expect(mode?.text).toBe('PLAN>BUILD');expect(mode?.tone).toBe('accent');
  const plain=planStatusDetail({status:{...status,columns:250,feedback:undefined,escapeAction:undefined,mode:'build'},
  hints:{cols:250,interactionPhase:'idle',hintsEnabled:false},model:'m',provider:'p'});
  expect(plain.fields.find(f=>f.id==='mode')?.text).toBe('BUILD');
});

// AC-39 (todo-acceptance-criteria): the acceptance counter sits AFTER `Todo`, and the
// detail row's `add()` ladder appends only while the whole row still fits - so field
// order IS priority order. The sweep documents the invariant instead of pinning one
// terminal width: an acceptance counter can never outlive the todo counter that
// precedes it, and there really are widths where the older field survives alone.
it('AC-39: `Accept` degrades before `Todo`, at every width',()=>{
  const counters={todoActive:{done:3,total:7},acceptanceActive:{checked:2,total:5,failed:0}};
  let both=0;let todoOnly=0;
  for(let columns=20;columns<=200;columns+=1){
    const plan=planStatusDetail({status:{...status,columns,feedback:undefined,escapeAction:undefined,...counters},
      hints:{cols:columns,interactionPhase:'idle',hintsEnabled:false},model:'m',provider:'p'});
    const hasTodo=plan.fields.some(f=>f.id==='todo');
    const hasAccept=plan.fields.some(f=>f.id==='acceptance');
    if(hasAccept) expect(hasTodo,`columns=${columns}`).toBe(true);
    if(hasAccept) expect(plan.fields.find(f=>f.id==='acceptance')?.text).toBe('Accept 2/5');
    if(hasTodo&&hasAccept) both+=1;
    if(hasTodo&&!hasAccept) todoOnly+=1;
  }
  expect(both).toBeGreaterThan(0);
  expect(todoOnly).toBeGreaterThan(0);
});

it('AC-39: a failed criterion turns the acceptance counter into an error tone',()=>{
  const plan=planStatusDetail({status:{...status,columns:200,feedback:undefined,escapeAction:undefined,
    acceptanceActive:{checked:2,total:5,failed:1}},
    hints:{cols:200,interactionPhase:'idle',hintsEnabled:false},model:'m',provider:'p'});
  const field=plan.fields.find(f=>f.id==='acceptance');
  expect(field?.text).toBe('Accept 2/5 !1');
  expect(field?.tone).toBe('error');
});
