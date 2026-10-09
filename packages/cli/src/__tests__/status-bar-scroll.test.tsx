import React from 'react';
import {expect,it} from 'vitest';
import {render} from 'ink-testing-library';
import stringWidth from 'string-width';
import {Header} from '../ui/Header.js';
import {StatusBar} from '../ui/StatusBar.js';
import {getTheme} from '../ui/theme.js';
const caps={unicode:false,colorLevel:0} as const;
const theme=getTheme('cool',caps);
it('keeps the detail affordance and history in both header variants at minimum width',()=>{
 for(const variant of ['mini','bar'] as const) for(const expanded of [false,true]) {
 const view=render(<Header columns={40} cwd="/long/path" provider="provider" model="long model"
 hasKey variant={variant} theme={theme} caps={caps} statusExpanded={expanded} scrolledLines={10000}/>);
 const text=view.lastFrame()!;
 expect(text).toContain('^9999+');expect(text).toContain(expanded?'^G less':'^G more');
 expect(text.split('\n')).toHaveLength(1);expect(stringWidth(text)).toBeLessThanOrEqual(40);
 view.rerender(<Header columns={40} cwd="/" provider="p" model="m" hasKey variant={variant}
 theme={theme} caps={caps} statusExpanded={expanded} scrolledLines={10000} overlayOpen/>);
 expect(view.lastFrame()).not.toContain('^G');expect(view.lastFrame()).toContain(expanded ? 'Details on' : 'Details off');
 view.unmount();
 }
});
it('retains the redraw carrier but keeps history and service metadata out of the primary row',()=>{
 const node=(nonce:number)=><StatusBar columns={40} speedKnown={false} reducedMotion model="m" provider="p"
 status="running" thinkingLevel="off" usageTotal={{inputTokens:0,outputTokens:0,cacheReadTokens:0,cacheWriteTokens:0,costUsd:0}}
 context={{occupied:0,window:100,pct:0,source:'usage',deltaTokens:0,windowKnown:true,windowOverridden:false}}
 elapsedMs={0} tokPerSec={0} theme={theme} caps={caps} servicesActive={{live:2}} scrolledLines={100} redrawNonce={nonce}/>;
 const view=render(node(1));const text=view.lastFrame()!;
 expect(text.startsWith(String.fromCharCode(0xa0))).toBe(true);
 expect(text).not.toContain('^100');expect(text).not.toContain('Svc');expect(text).toContain('C0%');
 expect(stringWidth(text)).toBeLessThanOrEqual(40);view.unmount();
});
