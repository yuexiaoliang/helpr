import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

type RuntimeNative = {
  ownerGroup: () => number;
  runtimeLease: (file: string) => number;
  runtimeGroup: (pid: number) => number;
};

/** 独占租约由控制者与独立监督共同持有，旧运行组清空后才释放。 */
export async function acquireRuntimeOwnership(
  folder: string,
  nativeFile: string,
) {
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const native = createRequire(path.resolve(nativeFile))(
    nativeFile,
  ) as RuntimeNative;
  const group = native.ownerGroup();
  const end = Date.now() + 8000;
  for (;;) {
    const fd = native.runtimeLease(path.join(folder, '.runtime-lease'));
    if (fd >= 0)
      return {
        fd,
        owns: (pid: number | undefined) =>
          pid !== undefined && native.runtimeGroup(pid) === group,
      };
    if (Date.now() >= end) throw Error('RUNTIME_OWNERSHIP_BUSY');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
