import { expect, test } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { z } from 'zod';
import { ObservationBroker } from '../../app/desktop/observation-broker';
import { ExecutionProtocol } from '../../app/desktop/execution-protocol';
import { InputGate } from '../../app/desktop/input-gate';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// 独立协议接收端：记录实际收到的输入，不读取产品资料或替产品去重。
const receiver = `
const fs = require('node:fs');
const input = fs.createReadStream(null, {fd:3});
const output = fs.createWriteStream(null, {fd:4});
const send = v => output.write(JSON.stringify(v)+'\\0');
let buffer='', sequence=0;
input.on('data', chunk => {
  buffer += chunk.toString();
  let end;
  while ((end=buffer.indexOf('\\0'))>=0) {
    const m=JSON.parse(buffer.slice(0,end)); buffer=buffer.slice(end+1);
    process.send(m);
    let result={};
    if (m.method==='Target.getTargets') result={targetInfos:[{targetId:'page-A'},{targetId:'page-B'}]};
    if (m.method==='Target.getTargetInfo') result={targetInfo:{targetId:m.params.targetId,type:'page'}};
    if (m.method==='Target.attachToTarget') result={sessionId:'s-'+(++sequence)};
    send({id:m.id,result});
    if (m.method==='Runtime.enable') send({sessionId:m.sessionId,method:'Runtime.executionContextCreated',params:{context:{id:sequence*10,auxData:{frameId:'f-'+sequence}}}});
  }
});
`;
function fixture(
  gate?: InputGate,
  beforeInput?: (taskId: string) => Promise<void>,
) {
  const child = spawn(process.execPath, ['-e', receiver], {
    stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe', 'ipc'],
  });
  const received: { method: string; sessionId?: string }[] = [];
  child.on('message', (m) => {
    received.push(
      z
        .object({ method: z.string(), sessionId: z.string().optional() })
        .parse(m),
    );
  });
  const pipe = new ObservationBroker(child, gate, beforeInput);
  pipe.register('A', 'page-A', 1);
  pipe.register('B', 'page-B', 1);
  const protocol = new ExecutionProtocol(pipe);
  return {
    pipe,
    protocol,
    received,
    close: async () => {
      protocol.dispose();
      pipe.dispose();
      child.kill();
      await once(child, 'exit');
    },
  };
}
test.skipIf(process.platform !== 'darwin')(
  '原生宿主先撤销跨进程资格，控制通知尚未到达时旧输入也不能送出，B不受影响',
  async () => {
    const folder = mkdtempSync(path.join(tmpdir(), 'helpr-native-gate-'));
    const binary = path.resolve('dist/native/input-bridge.node');
    const file = path.join(folder, 'gate');
    const gate = new InputGate(binary, file, true);
    gate.available(true);
    for (const id of ['A', 'B'])
      expect(gate.allow(id, gate.state(id).epoch)).toBe(true);
    let reached = false;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = fixture(gate, async (taskId) => {
        if (taskId === 'A') {
          reached = true;
          await waiting;
        }
      }),
      replies: unknown[] = [];
    const open = (taskId: string) =>
      f.protocol.open(
        taskId,
        { targetId: 'page-' + taskId, generation: 1 },
        () => true,
        (p) => replies.push(p),
        () => {},
      );
    const a = open('A'),
      b = open('B');
    try {
      const sessions: string[] = [];
      for (const [client, task] of [
        [a, 'A'],
        [b, 'B'],
      ] as const) {
        await f.protocol.command(client, {
          id: 1,
          method: 'Target.attachToTarget',
          params: { targetId: 'page-' + task },
        });
        sessions.push(
          z
            .object({ result: z.object({ sessionId: z.string() }) })
            .parse(replies.at(-1)).result.sessionId,
        );
      }
      const queued = f.protocol.command(a, {
        id: 2,
        method: 'Input.insertText',
        sessionId: sessions[0],
        params: { text: '迟到的旧输入' },
      });
      await expect.poll(() => reached, { timeout: 1000 }).toBe(true);
      const host = spawn(
        process.execPath,
        [
          '-e',
          "const n=require(process.argv[1]);n.open(process.argv[2],false);n.trip('A');",
          binary,
          file,
        ],
        { stdio: 'ignore' },
      );
      expect((await once(host, 'exit'))[0]).toBe(0);
      release();
      await queued;
      await f.protocol.command(b, {
        id: 2,
        method: 'Input.insertText',
        sessionId: sessions[1],
        params: { text: 'B继续' },
      });
      await expect
        .poll(() => f.received.filter((p) => p.method.startsWith('Input.')))
        .toEqual([{ method: 'Input.insertText', sessionId: sessions[1] }]);
    } finally {
      release();
      await f.close();
      rmSync(folder, { recursive: true, force: true });
    }
  },
);
test('私有网页入口拒绝跨任务、浏览器能力、重复及已撤销输入，另一个任务仍可操作', async () => {
  const f = fixture();
  const replies: unknown[] = [];
  const a = f.protocol.open(
    'A',
    { targetId: 'page-A', generation: 1 },
    () => true,
    (p) => replies.push(p),
    () => {},
  );
  const b = f.protocol.open(
    'B',
    { targetId: 'page-B', generation: 1 },
    () => true,
    (p) => replies.push(p),
    () => {},
  );
  try {
    await f.protocol.command(a, { id: 1, method: 'Target.getTargets' });
    expect(replies.at(-1)).toMatchObject({
      result: { targetInfos: [{ targetId: 'page-A' }] },
    });
    await f.protocol.command(a, {
      id: 2,
      method: 'Target.attachToTarget',
      params: { targetId: 'page-B' },
    });
    expect(replies.at(-1)).toHaveProperty('error');
    await f.protocol.command(a, {
      id: 3,
      method: 'Target.attachToTarget',
      params: { targetId: 'page-A' },
    });
    const sessionA = z
      .object({ result: z.object({ sessionId: z.string() }) })
      .parse(replies.at(-1)).result.sessionId;
    await f.protocol.command(b, {
      id: 1,
      method: 'Target.attachToTarget',
      params: { targetId: 'page-B' },
    });
    const sessionB = z
      .object({ result: z.object({ sessionId: z.string() }) })
      .parse(replies.at(-1)).result.sessionId;
    for (const packet of [
      { id: 4, method: 'Input.dispatchMouseEvent', sessionId: sessionB },
      { id: 5, method: 'Browser.close' },
      {
        id: 6,
        method: 'Runtime.evaluate',
        sessionId: sessionA,
        params: { contextId: 999, expression: '1' },
      },
    ]) {
      await f.protocol.command(a, packet);
      expect(replies.at(-1)).toHaveProperty('error');
    }
    await f.protocol.command(a, {
      id: 7,
      method: 'Input.dispatchMouseEvent',
      sessionId: sessionA,
      params: { type: 'mousePressed' },
    });
    await f.protocol.command(a, {
      id: 7,
      method: 'Input.dispatchMouseEvent',
      sessionId: sessionA,
      params: { type: 'mousePressed' },
    });
    f.protocol.revoke('A');
    await f.protocol.command(a, {
      id: 8,
      method: 'Input.insertText',
      sessionId: sessionA,
      params: { text: '旧输入' },
    });
    await f.protocol.command(b, {
      id: 2,
      method: 'Input.insertText',
      sessionId: sessionB,
      params: { text: 'B输入' },
    });
    await expect
      .poll(() => f.received.filter((p) => p.method.startsWith('Input.')))
      .toEqual([
        { method: 'Input.dispatchMouseEvent', sessionId: sessionA },
        { method: 'Input.insertText', sessionId: sessionB },
      ]);
    expect(
      f.received.some(
        (p) => p.method === 'Browser.close' || p.method === 'Runtime.evaluate',
      ),
    ).toBe(false);
  } finally {
    await f.close();
  }
});

test('一个工作者消息通道退出不使独立任务失去私有网页连接', async () => {
  const f = fixture();
  const replies: unknown[] = [];
  const a = f.protocol.open(
    'A',
    { targetId: 'page-A', generation: 1 },
    () => true,
    (p) => {
      if (z.object({ method: z.string() }).safeParse(p).success)
        throw Error('WORKER_EXITED');
      replies.push(p);
    },
    () => {},
  );
  const b = f.protocol.open(
    'B',
    { targetId: 'page-B', generation: 1 },
    () => true,
    (p) => replies.push(p),
    () => {},
  );
  try {
    await f.protocol.command(a, {
      id: 1,
      method: 'Target.attachToTarget',
      params: { targetId: 'page-A' },
    });
    const sessionId = z
      .object({ result: z.object({ sessionId: z.string() }) })
      .parse(replies.at(-1)).result.sessionId;
    await f.protocol.command(a, { id: 2, method: 'Runtime.enable', sessionId });
    await expect.poll(() => a.closed).toBe(true);
    await f.protocol.command(b, { id: 1, method: 'Target.getTargets' });
    expect(replies.at(-1)).toMatchObject({
      result: { targetInfos: [{ targetId: 'page-B' }] },
    });
  } finally {
    await f.close();
  }
});
