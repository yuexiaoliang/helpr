import { z } from 'zod';
import { WorkspaceRecords } from './workspace';
import { rpcRequestSchema, errorCode } from '../shared/contracts';
import { diagnostics } from '../shared/diagnostics';

const [folder, migrations] = process.argv.slice(2);
if (!folder || !migrations) throw new Error('INVALID_RECORDS_LOCATION');
const log = diagnostics(folder, 'records');
const port = process.parentPort;
const send = (message: unknown) => {
  if (port) port.postMessage(message);
  else process.send?.(message);
};
let records: WorkspaceRecords;
try {
  records = new WorkspaceRecords(folder, migrations);
  send({ ready: true });
  log.event('ready');
} catch (error) {
  send({ startupError: errorCode(error) });
  log.event('failure', { code: errorCode(error) });
  log.close();
  process.exit(1);
}
function handle(input: unknown): void {
  const parsed = rpcRequestSchema.safeParse(input);
  if (!parsed.success) return;
  const { id, command } = parsed.data;
  try {
    const kind = z.object({ kind: z.string() }).parse(command).kind;
    const value =
      kind === 'snapshot'
        ? records.snapshot()
        : kind === 'model'
          ? records.model(
              z.object({ command: z.unknown() }).parse(command).command,
            )
          : kind === 'lookup'
            ? records.lookupRequest(
                z.object({ command: z.unknown() }).parse(command).command,
              )
            : kind === 'close'
              ? null
              : records.execute(command);
    send({ id, value });
    log.event('command');
    if (kind === 'close') {
      records.close();
      log.close();
      process.exit(0);
    }
  } catch (error) {
    send({ id, error: errorCode(error) });
    log.event('failure', { code: errorCode(error) });
  }
}
if (port) port.on('message', ({ data }: { data: unknown }) => handle(data));
else process.on('message', handle);
process.on('disconnect', () => {
  records.close();
  log.close();
  process.exit(0);
});
