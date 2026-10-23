import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

/** 仅已通过启动校验的隔离验证资料允许指定本机HTTPS夹具，不读取生产环境变量。 */
export function versionFixture(
  validation: boolean,
  folder: string,
): { source?: string; ca?: Buffer } {
  const file = path.join(folder, 'version-fixture.json');
  if (!validation || !existsSync(file)) return {};
  const config = z
    .strictObject({
      source: z
        .string()
        .regex(/^https:\/\/127\.0\.0\.1:[1-9]\d{0,4}\/stable\.json$/),
      ca: z.string().min(1).max(16384),
    })
    .parse(JSON.parse(readFileSync(file, 'utf8')));
  return { source: config.source, ca: Buffer.from(config.ca) };
}
