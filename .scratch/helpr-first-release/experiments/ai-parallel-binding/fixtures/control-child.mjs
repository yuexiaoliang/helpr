// 仅由本机测试启动；配置通过父进程传入。
import { openRun } from '../control.mjs';
import { modelSession } from '../model.mjs';
process.once('message', async options => {
  try {
    const run = await openRun(options);
    const model = await modelSession(options.output, () => {}, { run, config: options.config, apiKey: 'fixture-key' });
    const execute = () => model.propose({ active: true, abort: new AbortController(), inputs: {}, history: [], goal: '完成',
      lease: { task: 'fixture/A', execution: 'child', generation: 1 } }, [{ pageId: 'fixture-page', snapshot: '完成' }]);
    if (options.mode === 'capture') {
      await run.runCase({ key: 'fixture:one', execute, capture: () => {
        process.send({ phase: 'capture' }); return new Promise(() => {});
      } });
    } else await execute();
    await run.close(); process.disconnect();
  } catch (error) { console.error(error); process.exit(1); }
});
