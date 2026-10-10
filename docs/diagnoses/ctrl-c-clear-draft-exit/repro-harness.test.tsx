/**
 * DIAGNOSIS REPRO HARNESS (diagnosis node output; not part of the test suite).
 * To run: copy this file into packages/cli/src/__tests__/ (imports are relative
 * to that directory), then: cd packages/cli && npx vitest run src/__tests__/<name>
 * Current-HEAD expectation: every case below PASSES, i.e. the bug reproduces.
 */
   import React from 'react';
   import { PassThrough } from 'node:stream';
   import { afterEach, describe, expect, it, vi } from 'vitest';
   import { render } from 'ink';
   import { createStdinFilter } from '../input/stdin-filter.js';
   import { PromptInput } from '../ui/PromptInput.js';
   import { getTheme } from '../ui/theme.js';

   const caps = { colorLevel: 0 as const, unicode: false };
   const delay = () => new Promise<void>((resolve) => setTimeout(resolve, 60));
   const cleanups: (() => void)[] = [];
   afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

   async function mount(element: React.ReactElement) {
     const source = Object.assign(new PassThrough(), {
       isTTY: true, setRawMode: () => source, ref: () => source, unref: () => source,
     });
     const filter = createStdinFilter(source as unknown as NodeJS.ReadStream,
       { mouse: false, paste: true });
     const output = Object.assign(new PassThrough(), { columns: 80, rows: 40, isTTY: true });
     let frame = '';
     output.on('data', (chunk) => { frame += String(chunk); });
     const app = render(element, {
       stdin: filter.stdin, stdout: output as unknown as NodeJS.WriteStream,
       stderr: output as unknown as NodeJS.WriteStream, exitOnCtrlC: false, patchConsole: false,
     });
     cleanups.push(() => { app.unmount(); app.cleanup(); filter.dispose(); source.destroy(); });
     await delay();
     return { frame: () => frame, send: async (bytes: string) => { source.write(bytes); await delay(); } };
   }

   describe('DIAG-3 Ctrl+C ladder cannot see or clear the draft', () => {
     it('PromptInput yields every Ctrl+chord to App; the draft survives Ctrl+C input bytes', async () => {
       const onDraftChange = vi.fn();
       const view = await mount(<PromptInput
         isActive running={false} history={[]} commands={[]} cwd={process.cwd()}
         caps={caps} theme={getTheme('cool', caps)} cols={80}
         onSubmit={() => ({ accepted: true })} onDraftChange={onDraftChange} />);
       await view.send('draft text');
       expect(onDraftChange).toHaveBeenLastCalledWith(
         expect.objectContaining({ hasDraft: true }));        // 草稿事实存在且可上报
       await view.send('\x03');                               // Ctrl+C 字节到达输入组件
       expect(view.frame()).toContain('draft text');          // 草稿仍在（组件层无清空语义）
       expect(onDraftChange).toHaveBeenLastCalledWith(
         expect.objectContaining({ hasDraft: true }));        // 仍是非空草稿
     });
   });
   