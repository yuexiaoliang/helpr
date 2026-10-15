import pino from 'pino';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import type { StartupStage } from './contracts';

export function diagnostics(
  folder: string,
  role: 'controller' | 'host' | 'records',
) {
  const dir = path.join(folder, 'diagnostics');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const transport = pino.transport({
    target: 'pino-roll',
    options: {
      file: path.join(dir, `${role}.log`),
      size: '2m',
      frequency: 'daily',
      mkdir: true,
      limit: { count: 4, removeOtherLogFiles: true },
      mode: 0o600,
    },
  });
  transport.on('error', () => {
    /* 诊断故障不能改变已保存的业务事实。 */
  });
  const logger = pino(
    {
      base: { role, pid: process.pid },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    transport,
  );
  // 固定参数阻止调用方把 URL、目标、消息、任意异常和凭据写入日志。
  return {
    event(
      event: 'ready' | 'command' | 'failure' | 'exit' | 'page',
      fields: {
        taskId?: string;
        code?: string;
        durationMs?: number;
        stage?: StartupStage;
        exitCode?: number;
        signal?: number;
      } = {},
    ) {
      logger.info({
        event,
        taskId: fields.taskId,
        code: fields.code,
        durationMs: fields.durationMs,
        stage: fields.stage,
        exitCode: fields.exitCode,
        signal: fields.signal,
      });
    },
    close: (onClosed?: () => void) => {
      if (onClosed) transport.once('close', onClosed);
      transport.end();
    },
  };
}
