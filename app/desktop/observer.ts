import { z } from 'zod';
import { ProcessClient } from '../shared/rpc';
import { errorCode } from '../shared/contracts';

const port = process.parentPort;
if (!port) throw new Error('WORKER_CHANNEL_REQUIRED');
const client = new ProcessClient({
  send: (message) => port.postMessage(message),
  listen: (listener) =>
    port.on('message', ({ data }: { data: unknown }) => listener(data)),
  onExit: (listener) => process.on('disconnect', listener),
});
port.on('message', ({ data }: { data: unknown }) => {
  const job = z
    .object({
      job: z.object({
        taskId: z.string(),
        token: z.string(),
        method: z.string(),
      }),
    })
    .safeParse(data);
  if (!job.success) return;
  void client
    .request(job.data.job)
    .then((value) => port.postMessage({ result: value }))
    .catch((error) => port.postMessage({ error: errorCode(error) }));
});
