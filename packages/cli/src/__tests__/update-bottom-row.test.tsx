import {describe,expect,it} from 'vitest';
import {shouldRenderUpdateLine} from '../update/types.js';
import {UPDATE_LIMITS} from '../update/limits.js';
import type {UpdateSnapshot} from '../update/types.js';
import {planStatusDetail} from '../ui/layout/status-detail-layout.js';
import {buildFrameBudget} from '../ui/layout/budget.js';
function snap(over:Partial<UpdateSnapshot>={}):UpdateSnapshot {
 return {phase:'ready',currentVersion:'0.5.9',latestVersion:'0.6.0',source:'npm-global',
 nextCheckAt:null,consecutiveFailures:0,...over};
}
it('update discovery stays within the optional detail row and never affects frame budget',()=>{
 for(const statusExpanded of [false,true]){
 const before=buildFrameBudget({rows:24,cols:80,draftRows:1,popupRows:0,statusExpanded});
 const detail=planStatusDetail({status:{columns:250,phase:'idle',pendingCount:0,thinkingLevel:'off',elapsedMs:0,tokPerSec:0,speedKnown:false,
 context:{occupied:0,window:100,pct:0,source:'usage',deltaTokens:0,windowKnown:true,windowOverridden:false},
 usageTotal:{inputTokens:0,outputTokens:0,cacheReadTokens:0,cacheWriteTokens:0,costUsd:0}},
 hints:{cols:250,interactionPhase:'idle',updateAvailable:true},model:'m',provider:'p'});
 expect(detail.fields.some(f=>f.id==='update'&&f.text==='/update')).toBe(true);
 expect(before.statusRows).toBe(statusExpanded?2:1);
 expect(before.viewportRows).toBe(statusExpanded?17:18);
 }
});
describe('shouldRenderUpdateLine — the presence rule itself', () => {
  it('is true exactly for available / installing / ready', () => {
    expect(shouldRenderUpdateLine(snap({ phase: 'available' }))).toBe(true);
    expect(shouldRenderUpdateLine(snap({ phase: 'installing' }))).toBe(true);
    expect(shouldRenderUpdateLine(snap({ phase: 'ready' }))).toBe(true);
    expect(shouldRenderUpdateLine(snap({ phase: 'idle' }))).toBe(false);
    expect(shouldRenderUpdateLine(snap({ phase: 'checking' }))).toBe(false);
  });

  it('holds `failed` back until the threshold (D-7)', () => {
    for (let n = 0; n < UPDATE_LIMITS.failuresBeforeNotice; n += 1) {
      expect(shouldRenderUpdateLine(snap({ phase: 'failed', consecutiveFailures: n })), `n=${n}`)
        .toBe(false);
    }
    expect(
      shouldRenderUpdateLine(
        snap({ phase: 'failed', consecutiveFailures: UPDATE_LIMITS.failuresBeforeNotice }),
      ),
    ).toBe(true);
  });
});
