import { get } from 'node:https';
import { z } from 'zod';
import {
  VERSION_SOURCE,
  versionCurrentSchema,
  versionManifestSchema,
  versionUICommandSchema,
  type VersionCurrent,
  type VersionStatus,
  type VersionResult,
} from '../shared/version';

type Options = {
  current: VersionCurrent;
  source?: string;
  ca?: Buffer;
  timeoutMs?: number;
  publish: (status: VersionStatus) => void;
  open: (url: string) => Promise<void>;
};
const compare = (a: string, b: string) => {
  const left = a.split('.').map(Number),
    right = b.split('.').map(Number);
  for (let i = 0; i < 3; i++)
    if (left[i] !== right[i]) return left[i]! - right[i]!;
  return 0;
};
const downloadURL = (version: string) =>
  `https://github.com/yuexiaoliang/helpr/releases/tag/v${version}`;

/** 只读版本边界；不接触任务、记录、登录、模型、安装器或下载API。 */
export class VersionService {
  private status: VersionStatus;
  private pending: Promise<VersionStatus> | null = null;
  private abort: AbortController | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  private dismissed: string | null = null;
  constructor(private readonly options: Options) {
    const source = new URL(options.source ?? VERSION_SOURCE);
    if (
      source.protocol !== 'https:' ||
      source.username ||
      source.password ||
      source.search ||
      source.hash
    )
      throw Error('VERSION_SOURCE_DENIED');
    this.status = {
      revision: 0,
      current: versionCurrentSchema.parse(options.current),
      source: source.href,
      phase: 'idle',
      origin: null,
      result: null,
      checkedAt: null,
      lastSuccess: null,
      noticeVisible: false,
      openFailed: false,
    };
  }
  get(): VersionStatus {
    return structuredClone(this.status);
  }
  private publish(): void {
    this.status.revision++;
    // 提醒投递失败不能丢掉已取得的检查事实；状态入口仍返回当前结果。
    try {
      this.options.publish(this.get());
    } catch {
      /* 设置仍可主动读取。 */
    }
  }
  start(): void {
    if (this.interval || this.disposed) return;
    void this.check('automatic');
    this.interval = setInterval(
      () => {
        void this.check('automatic');
      },
      24 * 60 * 60 * 1000,
    );
    this.interval.unref();
  }
  async handle(input: unknown): Promise<VersionStatus> {
    const command = versionUICommandSchema.parse(input);
    if (command.kind === 'version-check') void this.check('manual');
    if (command.kind === 'version-dismiss') {
      this.dismissed = this.status.result?.release?.version ?? null;
      this.status.noticeVisible = false;
      this.publish();
    }
    if (command.kind === 'version-open') {
      const result = this.status.result;
      if (
        this.disposed ||
        command.revision !== this.status.revision ||
        this.status.phase !== 'done' ||
        result?.kind !== 'available' ||
        !result.release ||
        result.release.downloadURL !== downloadURL(result.release.version)
      )
        throw Error('VERSION_LINK_UNAVAILABLE');
      this.status.openFailed = false;
      try {
        await this.options.open(result.release.downloadURL);
      } catch {
        this.status.openFailed = true;
      }
      this.publish();
    }
    return this.get();
  }
  check(origin: 'automatic' | 'manual'): Promise<VersionStatus> {
    if (this.pending) return this.pending;
    if (this.disposed) return Promise.resolve(this.get());
    this.status.phase = 'checking';
    this.status.origin = origin;
    this.status.noticeVisible = false;
    this.status.openFailed = false;
    this.publish();
    this.abort = new AbortController();
    this.pending = this.complete(this.abort.signal).finally(() => {
      this.pending = null;
      this.abort = null;
    });
    return this.pending;
  }
  private async complete(signal: AbortSignal): Promise<VersionStatus> {
    let result: VersionResult;
    try {
      const release = versionManifestSchema.parse(
        JSON.parse(await this.read(signal)),
      );
      const current = this.status.current;
      const difference = compare(release.version, current.version);
      const kind =
        (release.downloadURL !== null &&
          release.downloadURL !== downloadURL(release.version)) ||
        (difference > 0 && release.downloadURL === null)
          ? 'link'
          : release.platform !== current.platform ||
              release.arch !== current.arch
            ? 'architecture'
            : compare(release.minOS, current.osVersion) > 0
              ? 'system'
              : !release.dataFormats.includes(current.dataFormat) ||
                  !release.stateModels.includes(current.stateModel)
                ? 'data'
                : difference > 0
                  ? 'available'
                  : difference === 0
                    ? 'latest'
                    : 'older';
      result = { kind, release };
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      result = {
        kind:
          error instanceof z.ZodError || error instanceof SyntaxError
            ? 'format'
            : code === 'VERSION_TIMEOUT'
              ? 'timeout'
              : code === 'VERSION_SOURCE'
                ? 'source'
                : code === 'VERSION_FORMAT'
                  ? 'format'
                  : 'offline',
      };
    }
    if (this.disposed) return this.get();
    const now = Date.now();
    this.status.phase = 'done';
    this.status.result = result;
    this.status.checkedAt = now;
    if (
      ['available', 'latest', 'older'].includes(result.kind) &&
      result.release
    )
      this.status.lastSuccess = {
        kind: result.kind,
        version: result.release.version,
        checkedAt: now,
      };
    this.status.noticeVisible =
      result.kind === 'available' && this.dismissed !== result.release?.version;
    this.publish();
    return this.get();
  }
  private read(signal: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
      const request = get(
        this.status.source,
        {
          agent: false,
          ca: this.options.ca,
          signal,
          headers: { Accept: 'application/json' },
        },
        (response) => {
          if (response.statusCode !== 200) {
            response.destroy();
            reject(
              Error(
                response.statusCode &&
                  response.statusCode >= 300 &&
                  response.statusCode < 400
                  ? 'VERSION_SOURCE'
                  : 'VERSION_OFFLINE',
              ),
            );
            return;
          }
          const type = response.headers['content-type']?.split(';')[0]?.trim();
          if (
            !['application/json', 'text/plain'].includes(type ?? '') ||
            (response.headers['content-encoding'] &&
              response.headers['content-encoding'] !== 'identity')
          ) {
            response.destroy();
            reject(Error('VERSION_FORMAT'));
            return;
          }
          let size = 0;
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > 32768) {
              response.destroy();
              reject(Error('VERSION_FORMAT'));
            } else chunks.push(chunk);
          });
          response.on('error', () => reject(Error('VERSION_OFFLINE')));
          response.on('end', () =>
            resolve(Buffer.concat(chunks).toString('utf8')),
          );
        },
      );
      const timer = setTimeout(() => {
        request.destroy();
        reject(Error('VERSION_TIMEOUT'));
      }, this.options.timeoutMs ?? 8000);
      request.once('close', () => clearTimeout(timer));
      request.on('error', (error: NodeJS.ErrnoException) => {
        const trust = /CERT|TLS|SELF_SIGNED|UNABLE_TO_VERIFY/.test(
          error.code ?? '',
        );
        reject(Error(trust ? 'VERSION_SOURCE' : 'VERSION_OFFLINE'));
      });
    });
  }
  dispose(): void {
    this.disposed = true;
    if (this.interval) clearInterval(this.interval);
    this.abort?.abort();
  }
}
