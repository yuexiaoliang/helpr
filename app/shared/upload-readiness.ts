import { z } from 'zod';
import { downloadCheckSchema } from './publication';
import type { MaterialVersion } from './material';
import type { PageSource, PageObservation } from './model';
type UploadAction = {
  id: string;
  goalVersion: number;
  source: PageSource;
  observedUrls?: string[];
  observedLinks?: { name: string; url: string }[];
  action: { kind: string; materialId?: string };
  uploadCheck?: z.infer<typeof uploadCheckSchema>;
  status: string;
  dispatchState?: string;
  resultSource?: PageSource;
  resultLinks?: { name: string; url: string }[];
  navigation?: unknown;
};

export const uploadCheckSchema = z.strictObject({
  rule: z.literal('unique-new-link-v1'),
  download: downloadCheckSchema,
  targetFactId: z.string().uuid(),
  uploadFactId: z.string().uuid(),
  binding: z.strictObject({
    targetId: z.string().min(1),
    generation: z.number().int().nonnegative(),
  }),
});

/** 只选择实际新增的唯一链接；不猜文件名、地址或逐个下载候选。 */
export function uploadedLink(
  action: Pick<UploadAction, 'source' | 'observedUrls' | 'observedLinks'>,
  source: Pick<PageObservation, 'url' | 'truncated' | 'links'>,
) {
  if (
    action.source.truncated ||
    source.truncated ||
    source.url !== action.source.url ||
    !source.links
  )
    return null;
  const known = new Set([
    action.source.url,
    ...(action.observedUrls ?? []),
    ...(action.observedLinks ?? []).map((l) => l.url),
  ]);
  const fresh = source.links.filter((l) => !known.has(l.url));
  if (fresh.length !== 1) return null;
  const link = fresh[0]!;
  let url: URL;
  try {
    url = new URL(link.url);
  } catch {
    return null;
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.hash ||
    url.username ||
    url.password ||
    url.origin !== new URL(source.url).origin ||
    source.links.filter((l) => l.name === link.name).length !== 1
  )
    return null;
  return link;
}

export function validUploadCheck(a: UploadAction): boolean {
  const c = a.uploadCheck;
  if (!c) return true; // 旧格式的历史确认不补造字节证据。
  if (
    a.action.kind !== 'upload' ||
    a.status !== 'confirmed' ||
    a.dispatchState !== 'possible' ||
    !a.resultSource ||
    a.navigation ||
    c.binding.generation !== a.resultSource.generation ||
    c.download.checkedAt < a.resultSource.observedAt
  )
    return false;
  return (
    uploadedLink(a, { ...a.resultSource, links: a.resultLinks })?.url ===
    c.download.url
  );
}

export function validUploadReferences(e: {
  actions: UploadAction[];
  materials?: MaterialVersion[];
  preparation?: {
    id: string;
    kind: string;
    goalVersion: number;
    url: string;
    materialId: string | null;
    actionId: string | null;
  }[];
}): boolean {
  return e.actions.every((a) => {
    const c = a.uploadCheck;
    if (!c) return true;
    const m = e.materials?.find(
      (m) =>
        a.action.kind === 'upload' &&
        m.id === a.action.materialId &&
        m.goalVersion === a.goalVersion,
    );
    return (
      !!m &&
      m.sha256 === c.download.sha256 &&
      m.bytes === c.download.bytes &&
      !!e.preparation?.some(
        (f) =>
          f.id === c.targetFactId &&
          f.kind === 'target' &&
          f.goalVersion === a.goalVersion &&
          f.url === a.source.url,
      ) &&
      !!e.preparation.some(
        (f) =>
          f.id === c.uploadFactId &&
          f.kind === 'upload' &&
          f.goalVersion === a.goalVersion &&
          f.materialId === m.id &&
          f.actionId === a.id &&
          f.url === c.download.url,
      )
    );
  });
}
