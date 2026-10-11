import { readFile } from 'node:fs/promises';
import path from 'node:path';
const read = async file => JSON.parse(await readFile(file, 'utf8'));
export const historicalStudies = ['artifacts/2026-10-11T03-38-56-107Z', 'artifacts/chromium-missing-cases'];

// 固定实验问题的登记资料；更换输出目录不会改变问题身份或原始上限。
export async function historicalRegistration(directory) {
  const original = await read(path.join(directory, historicalStudies[0], 'model-meta.json'));
  const audit = await read(path.join(directory, historicalStudies[0], 'post-run-audit.json'));
  const requests = [];
  for (const study of historicalStudies) {
    const meta = await read(path.join(directory, study, 'model-meta.json'));
    for (const call of meta.calls) {
      let tokens = 0;
      if (call.usage?.total_tokens === undefined) {
        const name = call.label.split(':')[0].padStart(3, '0');
        const input = await read(path.join(directory, study, 'model', name + '-input.json'));
        tokens = Buffer.byteLength(JSON.stringify({ messages: input.messages, schema: input.schema })) + 700;
      }
      requests.push({ ...call, id: requests.length + 1, tokens, output: study, status: 'settled' });
    }
  }
  return { id: 'helpr-first-release/ai-parallel-binding', limits: original.limits,
    deadline: original.deadline, priorRevisions: audit.programRevisions.length, requests };
}
