import {expect,it} from 'vitest';
import {interactionCopy} from '../ui/interaction-copy.js';
import {buildQueueLayout} from '../ui/layout/queue-layout.js';
it('built-in copy is ASCII English while user Unicode survives queue formatting',()=>{
 const visit=(v:unknown):void=>{if(typeof v==='string')expect(v).toMatch(/^[\x20-\x7e]*$/);
 else if(v&&typeof v==='object')Object.values(v).forEach(visit);};
 visit(interactionCopy);
 expect(interactionCopy.idlePlaceholder).toBe('Ask a question or describe a task...');
 const layout=buildQueueLayout({pending:[{queueId:'q',text:'\u4e2d\u6587\nsecond'}],columns:80,terminalRows:24,availableRows:4,paused:true});
 expect(layout.title).toContain('Queue: 1 pending paused');
 expect(layout.items[0]!.label).toContain('\u4e2d\u6587');
 expect(layout.items[0]!.label).toContain('(+1 lines)');
});
