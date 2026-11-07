import pino from 'pino';
import path from 'node:path';
import { mkdirSync, lstatSync } from 'node:fs';
import { startupFailureCodeSchema, type StartupStage } from './contracts';
import { actionFailureCodeSchema } from './execution';

const diagnosticCodes = new Set([
  ...startupFailureCodeSchema.options,
  ...actionFailureCodeSchema.options,
  'STORAGE_FULL',
  'STORAGE_UNAVAILABLE',
  'SESSION_CHANGE_NOT_SAVED',
  'INPUT_PAUSE_NOT_SAVED',
  'INBOX_UNAVAILABLE',
  'HOST_PROCESS_EXITED',
  'NATIVE_INPUT_RESTORED',
  'BACKUP_STORAGE_FULL',
  'BACKUP_STORAGE_UNAVAILABLE',
  'BACKUP_RECEIPT_UNKNOWN',
  'BACKUP_BUSY',
  'BACKUP_INVALID',
  'BACKUP_INCOMPATIBLE',
  'REQUEST_TIMEOUT',
  'PROCESS_DISCONNECTED',
  'INVALID_REQUEST',
]);

export function diagnostics(
  folder: string,
  role: 'controller' | 'host' | 'records',
) {
  let failed = false;
  let closed = false;
  let failureListener: (() => void) | undefined;
  const fail = () => {
    if (!failed) {
      failed = true;
      failureListener?.();
    }
  };
  let transport: ReturnType<typeof pino.transport> | undefined;
  let logger: ReturnType<typeof pino> | undefined;
  try {
    const dir = path.join(folder, 'diagnostics');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (lstatSync(dir).isSymbolicLink()) throw Error('DIAGNOSTICS_UNAVAILABLE');
    transport = pino.transport({
      target: 'pino-roll',
      options: {
        file: path.join(dir, `${role}.log`),
        size: '2m',
        frequency: 'daily',
        mkdir: true,
        // pino-roll 只匹配当前 role 的日志名，包含前次进程的同类诊断。
        limit: { count: 4, removeOtherLogFiles: true },
        mode: 0o600,
      },
    });
    transport.on('error', fail);
    transport.on('close', () => {
      closed = true;
    });
    logger = pino(
      {
        base: { role, pid: process.pid },
        timestamp: pino.stdTimeFunctions.isoTime,
      },
      transport,
    );
  } catch {
    fail();
  }
  const number = (value: number | undefined) =>
    typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  return {
    onFailure(listener: () => void) {
      failureListener = listener;
      if (failed) listener();
    },
    healthy: () => !failed,
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
      if (
        failed ||
        !['ready', 'command', 'failure', 'exit', 'page'].includes(event)
      )
        return;
      try {
        logger?.info({
          event,
          taskId:
            fields.taskId && /^[a-f0-9-]{36}$/.test(fields.taskId)
              ? fields.taskId
              : undefined,
          code: fields.code
            ? diagnosticCodes.has(fields.code)
              ? fields.code
              : 'DIAGNOSTIC_UNCLASSIFIED'
            : undefined,
          durationMs: number(fields.durationMs),
          stage:
            fields.stage &&
            [
              'image',
              'ownership',
              'application',
              'host-module',
              'controller-init',
              'reopen',
            ].includes(fields.stage)
              ? fields.stage
              : undefined,
          exitCode: number(fields.exitCode),
          signal: number(fields.signal),
        });
      } catch {
        fail();
      }
    },
    close: (onClosed?: () => void) => {
      if (!transport || closed) {
        onClosed?.();
        return;
      }
      if (onClosed) transport.once('close', onClosed);
      transport.end();
    },
  };
}
