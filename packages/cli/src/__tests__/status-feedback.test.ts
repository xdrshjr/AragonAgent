import {expect,it} from 'vitest';
import {projectStatusFeedback} from '../ui/status-feedback.js';
it('uses structured copy status and actual Esc and Ctrl+C ownership',()=>{
 const base={interactionPhase:'running' as const,interruptPhase:'stopping' as const};
 expect(projectStatusFeedback({...base,copyResult:{status:'sent',text:'custom'}}).feedback?.kind).toBe('copy-sent');
 expect(projectStatusFeedback({...base,copyResult:{status:'confirmed',text:'custom'}}).feedback?.kind).toBe('copied');
 expect(projectStatusFeedback({...base,copyState:{busy:true,cleanupPending:true},ctrlCArmed:true}).feedback?.kind).toBe('copy-cleanup');
 expect(projectStatusFeedback({...base,completion:'slash'}).escapeAction).toBe('menu');
 expect(projectStatusFeedback({...base,overlay:'confirm',completion:'slash'}).escapeAction).toBeUndefined();
 expect(projectStatusFeedback({...base,ctrlCArmed:true,liveServices:2}).feedback?.kind).not.toBe('exit');
 expect(projectStatusFeedback({...base,ctrlCArmed:true}).feedback?.kind).toBe('exit');
});
it('expires transient receipt feedback but keeps cleanup visible until cleanup completes',()=>{
 const base={interactionPhase:'idle' as const};
 expect(projectStatusFeedback({...base,copyResult:{status:'confirmed',text:'Copied'}}).feedback?.kind).toBe('copied');
 expect(projectStatusFeedback(base).feedback).toBeUndefined();
 expect(projectStatusFeedback({...base,copyState:{busy:false,cleanupPending:true}}).feedback?.kind).toBe('copy-cleanup');
 expect(projectStatusFeedback({...base,copyState:{busy:false,cleanupPending:false}}).feedback).toBeUndefined();
 for(const blocked of [{selectionPending:true},{copyState:{busy:true,cleanupPending:false}},{liveServices:1}]) {
  expect(projectStatusFeedback({...base,ctrlCArmed:true,...blocked}).feedback?.kind).not.toBe('exit');
 }
 expect(projectStatusFeedback({...base,ctrlCArmed:false}).feedback?.kind).not.toBe('exit');
});
