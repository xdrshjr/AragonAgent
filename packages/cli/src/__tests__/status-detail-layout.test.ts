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
 expect(text).toContain('Copy failed');expect(text).toContain('Esc menu');expect(text).toContain('^G less');
 expect(text).not.toContain('Esc stop');expect(stringWidth(text)).toBeLessThanOrEqual(39);
});
it('keeps full context, session usage and cost in a sufficiently wide detail row',()=>{
 const plan=planStatusDetail({status:{...status,columns:350,feedback:undefined,escapeAction:undefined},
 hints:{cols:350,interactionPhase:'idle',hintsEnabled:false},model:'m',provider:'p'});
 const text=plan.fields.map(f=>f.text).join(plan.separator);
 expect(text).toContain('Context 10/100 tokens');expect(text).toContain('Session input 8 output 2');
 expect(text).toContain('Cost $0.1000');expect(text).not.toContain('newline');expect(text).toContain('^G less');
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
