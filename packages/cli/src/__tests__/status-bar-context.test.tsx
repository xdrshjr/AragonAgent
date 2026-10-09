import React from 'react';
import {expect,it} from 'vitest';
import {render} from 'ink-testing-library';
import stringWidth from 'string-width';
import {StatusBar} from '../ui/StatusBar.js';
import {getTheme} from '../ui/theme.js';
import type {ContextUsageSnapshot} from '../compaction/types.js';
const caps={unicode:false,colorLevel:0} as const;
function bar(columns:number,over:Partial<ContextUsageSnapshot>={}):string {
 const view=render(<StatusBar columns={columns} speedKnown={false} model="m" provider="p" status="idle"
 usageTotal={{inputTokens:1e6,outputTokens:999,cacheReadTokens:0,cacheWriteTokens:0,costUsd:3}}
 context={{occupied:86000,window:200000,pct:43,source:'usage',deltaTokens:0,windowKnown:true,windowOverridden:false,...over}}
 elapsedMs={62000} thinkingLevel="off" tokPerSec={999} theme={getTheme('cool',caps)} caps={caps}/>);
 const frame=view.lastFrame()!;view.unmount();return frame;
}
it('renders all primary concepts at 40 to 200 columns with the explicit width',()=>{
 for(const columns of [40,60,72,96,200]){
 const text=bar(columns);expect(text).toContain('43%');expect(text).toMatch(/Th:O|Think off/);
 expect(text).toMatch(/--(?: tok\/s|t\/s)/);expect(text).toContain('1m02s');
 expect(text).not.toContain('Session');expect(text).not.toContain('86000');
 expect(text.split('\n')).toHaveLength(1);expect(stringWidth(text)).toBeLessThanOrEqual(columns);
 }
});
it('separates measured, estimated and unknown context without inventing a window',()=>{
 expect(bar(80)).not.toContain('~43%');
 expect(bar(80,{source:'estimate'})).toContain('~43%');
 expect(bar(80,{deltaTokens:4000})).toContain('~43%');
 for(const over of [{windowKnown:false},{pct:-1},{deltaTokens:NaN}]) {
 const text=bar(40,over);expect(text).toContain('C?');expect(text).not.toContain('43%');
 }
 expect(bar(40,{source:'estimate',pct:1000})).toContain('C~>999%');
});
