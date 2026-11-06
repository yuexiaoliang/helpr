import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  mkdir,
  open,
  link,
  unlink,
  readdir,
  lstat,
  realpath,
} from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import {
  MATERIAL_LIMIT,
  materialSelectionSchema,
  type MaterialVersion,
} from '../shared/material';

export const materialDigest = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');
/** 文件由记录拥有者先同步并核验，再提交引用。上传只读取摘要命名的副本。 */
export class MaterialFiles {
  constructor(private readonly folder: string) {}
  private location(sha256: string) {
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw Error('MATERIAL_CORRUPT');
    return path.join(this.folder, 'materials', sha256);
  }
  async read(version: Pick<MaterialVersion, 'sha256' | 'bytes'>) {
    const fd = await open(
      this.location(version.sha256),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const stat = await fd.stat();
      if (
        !stat.isFile() ||
        stat.size !== version.bytes ||
        stat.size > MATERIAL_LIMIT
      )
        throw Error('MATERIAL_CORRUPT');
      const bytes = await fd.readFile();
      if (materialDigest(bytes) !== version.sha256)
        throw Error('MATERIAL_CORRUPT');
      return bytes;
    } finally {
      await fd.close();
    }
  }
  async put(bytes: Buffer, sha256 = materialDigest(bytes)) {
    if (bytes.length > MATERIAL_LIMIT || materialDigest(bytes) !== sha256)
      throw Error('MATERIAL_CORRUPT');
    const destination = this.location(sha256),
      directory = path.dirname(destination);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if ((await lstat(directory)).isSymbolicLink())
      throw Error('MATERIAL_ACCESS_DENIED');
    const parent = await open(this.folder, 'r');
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
    const temporary = destination + '.' + randomUUID() + '.partial';
    const fd = await open(temporary, 'wx', 0o600);
    try {
      await fd.writeFile(bytes);
      await fd.chmod(0o400);
      await fd.sync();
      await fd.close();
      try {
        await link(temporary, destination);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      const dir = await open(directory, 'r');
      try {
        await dir.sync();
      } finally {
        await dir.close();
      }
      await this.read({ sha256, bytes: bytes.length });
    } finally {
      await fd.close().catch(() => {});
      await unlink(temporary).catch(() => {});
    }
    return sha256;
  }
  async select(
    input: unknown,
    userTexts: string[],
    goalVersion: number,
  ): Promise<MaterialVersion> {
    const selection = materialSelectionSchema.parse(input);
    const { scope, basis, rule, name, extension } = selection;
    // 只接受用户原文中的完整路径；网页文本和模型新造路径不能赋予本机读取资格。
    const escaped = scope.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const boundary = new RegExp(
      '(?:^|[\\s"\'“「（(：:])' + escaped + '(?=$|[\\s"\'”」），,；;。])',
      'u',
    );
    if (
      !userTexts.some((t) => t.includes(basis) && boundary.test(t)) ||
      !(path.isAbsolute(scope) || scope.startsWith('~/')) ||
      (name &&
        (path.basename(name) !== name || name === '.' || name === '..')) ||
      (name && !userTexts.some((t) => t.includes(name))) ||
      (rule === 'latest' &&
        !/(最新|最近修改|最后修改|latest|newest|most recent)/iu.test(basis))
    )
      throw Error('MATERIAL_SCOPE_REQUIRED');
    const resolved = path.resolve(
      scope.startsWith('~/') ? path.join(homedir(), scope.slice(2)) : scope,
    );
    try {
      const stat = await lstat(resolved);
      if (stat.isSymbolicLink()) throw Error('MATERIAL_ACCESS_DENIED');
      const canonicalScope = await realpath(resolved);
      let source = resolved;
      if (stat.isDirectory()) {
        if (rule === 'exact' && !name) throw Error('MATERIAL_AMBIGUOUS');
        const entries = await readdir(resolved, { withFileTypes: true });
        if (entries.length > 1000) throw Error('MATERIAL_AMBIGUOUS');
        const candidates = entries.filter(
          (e) =>
            e.isFile() &&
            (!name || e.name === name) &&
            (!extension ||
              path.extname(e.name).toLowerCase() === extension.toLowerCase()),
        );
        if (!candidates.length) throw Error('MATERIAL_MISSING');
        if (rule !== 'latest' && candidates.length !== 1)
          throw Error('MATERIAL_AMBIGUOUS');
        const files = await Promise.all(
          candidates.map(async (e) => ({
            file: path.join(resolved, e.name),
            stat: await lstat(path.join(resolved, e.name)),
          })),
        );
        files.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
        if (
          rule === 'latest' &&
          files[1]?.stat.mtimeMs === files[0]!.stat.mtimeMs
        )
          throw Error('MATERIAL_AMBIGUOUS');
        source = files[0]!.file;
      } else if (!stat.isFile() || name || rule !== 'exact')
        throw Error('MATERIAL_SCOPE_REQUIRED');
      const canonicalSource = await realpath(source);
      if (
        stat.isDirectory() &&
        path.dirname(canonicalSource) !== canonicalScope
      )
        throw Error('MATERIAL_ACCESS_DENIED');
      const expected = await lstat(canonicalSource);
      const fd = await open(
        canonicalSource,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      let bytes: Buffer;
      try {
        const before = await fd.stat();
        if (before.ino !== expected.ino || before.dev !== expected.dev)
          throw Error('MATERIAL_CHANGED');
        if (!before.isFile()) throw Error('MATERIAL_ACCESS_DENIED');
        if (before.size > MATERIAL_LIMIT) throw Error('MATERIAL_TOO_LARGE');
        bytes = Buffer.alloc(before.size);
        let offset = 0;
        while (offset < bytes.length) {
          const read = await fd.read(
            bytes,
            offset,
            bytes.length - offset,
            offset,
          );
          if (!read.bytesRead) throw Error('MATERIAL_CHANGED');
          offset += read.bytesRead;
        }
        const after = await fd.stat(),
          current = await lstat(source);
        if (
          before.size !== after.size ||
          before.mtimeMs !== after.mtimeMs ||
          before.ctimeMs !== after.ctimeMs ||
          current.ino !== before.ino ||
          current.dev !== before.dev ||
          current.isSymbolicLink()
        )
          throw Error('MATERIAL_CHANGED');
      } finally {
        await fd.close();
      }
      const sha256 = await this.put(bytes);
      return {
        id: randomUUID(),
        goalVersion,
        sha256,
        bytes: bytes.length,
        name: path.basename(source),
        source,
        selectedAt: Date.now(),
        selection,
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') throw Error('MATERIAL_MISSING');
      if (['EACCES', 'EPERM', 'ELOOP', 'ENOTDIR'].includes(code ?? ''))
        throw Error('MATERIAL_ACCESS_DENIED');
      throw error;
    }
  }
}
