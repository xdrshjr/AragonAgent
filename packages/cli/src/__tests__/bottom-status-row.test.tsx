import React from 'react';
import {expect,it} from 'vitest';
import {render} from 'ink-testing-library';
import {BottomStatusRow} from '../ui/BottomStatusRow.js';
import {statusField,statusLinePlan} from '../ui/layout/status-layout.js';
import {getTheme} from '../ui/theme.js';
const theme=getTheme('cool',{unicode:false,colorLevel:0});
it('renders exactly the allocated plan with its measured separator in one row',()=>{
 for(const separator of [' | ',' ']) {
 const plan=statusLinePlan([statusField('feedback','Copy sent'),statusField('escape','Esc menu'),statusField('toggle','^G less')],separator);
 const view=render(<BottomStatusRow plan={plan} columns={40} theme={theme}/>);
 expect(view.lastFrame()).toBe(' '+plan.fields.map(f=>f.text).join(separator));
 expect(view.lastFrame()!.split('\n')).toHaveLength(1);view.unmount();
 }
});
