import { expect,it } from 'vitest';
import {createRunMetrics,updateRunMetrics,projectRunMetrics,freezeRunMetrics} from '../ui/run-metrics.js';
it('isolates main tokens, recognizes zero, freezes termination and resets contiguous runs',()=>{
 let s=updateRunMetrics(createRunMetrics(),{type:'agent_start'},100);
 expect(projectRunMetrics(s,1000).speedKnown).toBe(false);
 s=updateRunMetrics(s,{type:'turn_end',usage:{outputTokens:0}},200);
 expect(projectRunMetrics(s,700)).toMatchObject({speedKnown:true,tokPerSec:0});
 for(const type of ['team_usage','fast_usage','compaction_usage','usage','message_update']) s=updateRunMetrics(s,{type,usage:{outputTokens:999}},800);
 s=updateRunMetrics(s,{type:'turn_end',usage:{outputTokens:60}},900);
 s=updateRunMetrics(s,{type:'turn_end',usage:{outputTokens:NaN}},950);
 expect(projectRunMetrics(s,1100)).toMatchObject({elapsedMs:1000,tokPerSec:60});
 s=freezeRunMetrics(s,1200);
 s=updateRunMetrics(s,{type:'turn_end',usage:{outputTokens:99}},1300);
 expect(projectRunMetrics(s,5000)).toMatchObject({elapsedMs:1100,speedKnown:false});
 s=updateRunMetrics(s,{type:'agent_start'},5000);
 expect(projectRunMetrics(s,5000)).toMatchObject({elapsedMs:0,speedKnown:false});
});
it('same-tick completion is zero, error freezes, and a fresh session forgets old metrics',()=>{
 let s=updateRunMetrics(createRunMetrics(),{type:'agent_start'},0);
 s=updateRunMetrics(s,{type:'agent_end'},0);
 expect(projectRunMetrics(s,1000)).toEqual({elapsedMs:0,speedKnown:false,tokPerSec:0});
 s=updateRunMetrics(s,{type:'agent_start'},500);
 s=updateRunMetrics(s,{type:'error'},1500);
 expect(projectRunMetrics(s,9000).elapsedMs).toBe(1000);
 expect(projectRunMetrics(createRunMetrics(),9000).elapsedMs).toBe(0);
});
