import {expect,it} from 'vitest';
import stringWidth from 'string-width';
import {buildActionClauses} from '../ui/interaction-hints.js';
it('keeps actual Esc ownership for overlays, completion, armed stop and force stop',()=>{
 for(const [extra,expected] of [
 [{overlay:'confirm'},'Esc close'],[{completion:'slash' as const},'Esc menu'],
 [{interruptPhase:'armed' as const},'Esc stop'],[{interruptPhase:'stopping' as const},'Esc force'],
 ] as const) {
 const text=buildActionClauses({cols:40,interactionPhase:'running',...extra}).join(' | ');
 expect(text).toContain(expected);expect(stringWidth(text)).toBeLessThanOrEqual(39);
 }
});
it('hides teaching but retains cancellation, confirmation, and copy feedback',()=>{
 const confirm=buildActionClauses({cols:100,interactionPhase:'running',overlay:'confirm',hintsEnabled:false}).join(' | ');
 expect(confirm).toContain('y approve');expect(confirm).toContain('n/Enter reject');
 const cleanup=buildActionClauses({cols:40,interactionPhase:'running',completion:'slash',copyCleanupPending:true,hintsEnabled:false}).join(' | ');
 expect(cleanup).toContain('Copy failed');expect(cleanup).toContain('Esc menu');
 expect(cleanup).not.toContain('Copying');
});
it('selection owns Ctrl+C before service cancellation',()=>{
 const text=buildActionClauses({cols:100,interactionPhase:'running',services:2,selectionPending:true}).join(' | ');
 expect(text).toContain('Ctrl+C copy');expect(text).not.toContain('stop services');
});
it('ordinary text cannot fake interrupt state',()=>{
 const text=buildActionClauses({cols:100,interactionPhase:'running',interruptHint:'force confirm again'}).join(' | ');
 expect(text).toContain('Esc x2 stop');expect(text).not.toContain('Esc force');
});
