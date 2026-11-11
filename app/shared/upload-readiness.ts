import { z } from 'zod';
import { downloadCheckSchema } from './publication';
import type { MaterialVersion } from './material';
import type { PageSource, PageObservation } from './model';
import type { ActionFact, TaskExecution } from './execution';
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
  departureActionId: z.string().min(1).optional(),
});

export function uniqueLinkTo(
  source: Pick<PageObservation, 'truncated' | 'links'>,
  url: string,
) {
  if (source.truncated) return;
  const matches = source.links?.filter((l) => l.url === url);
  if (
    matches?.length === 1 &&
    source.links?.filter((l) => l.name === matches[0]!.name).length === 1
  )
    return matches[0];
}

/** 从同一编辑目标的已核对跳转进入附件页面，并且当前页面能唯一返回该目标。 */
export function attachmentDeparture(
  actions: ActionFact[],
  goalVersion: number,
  targetUrl: string,
  source: Pick<PageObservation, 'url' | 'truncated' | 'links'>,
) {
  if (source.url === targetUrl || !uniqueLinkTo(source, targetUrl)) return;
  const lastNavigation = actions.findLast(
    (a) =>
      a.goalVersion === goalVersion && a.navigation && a.status !== 'cancelled',
  );
  if (
    lastNavigation?.status === 'confirmed' &&
    lastNavigation.source.url === targetUrl &&
    lastNavigation.navigationResolution?.source.url === source.url
  )
    return lastNavigation;
}

export function attachmentStillPresent(
  e: TaskExecution,
  action: ActionFact,
  source: PageObservation,
) {
  const check = action.uploadCheck;
  if (!check) return true;
  if (!check.departureActionId)
    return uploadedLink(action, source)?.url === check.download.url;
  const target = e.preparation?.find((f) => f.id === check.targetFactId);
  if (source.url === action.source.url)
    return (
      !!target &&
      !!uniqueLinkTo(source, target.url) &&
      uploadedLink(action, source)?.url === check.download.url
    );
  return (
    target?.url === source.url && !!uniqueLinkTo(source, check.download.url)
  );
}

export function attachmentOnEditor(
  e: TaskExecution,
  attachment: { url: string; targetUrl: string; materialId: string },
  source?: PageObservation,
) {
  const upload = e.actions.find(
    (a) =>
      a.goalVersion === e.goalVersion &&
      a.action.kind === 'upload' &&
      a.action.materialId === attachment.materialId &&
      a.uploadCheck?.departureActionId,
  );
  if (!upload) return true;
  return (
    !!source &&
    source.url === attachment.targetUrl &&
    upload.uploadCheck!.download.url === attachment.url &&
    attachmentStillPresent(e, upload, source)
  );
}

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
  actions: ActionFact[];
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
  return e.actions.every((a, index) => {
    const c = a.uploadCheck;
    if (!c) return true;
    const m = e.materials?.find(
      (m) =>
        a.action.kind === 'upload' &&
        m.id === a.action.materialId &&
        m.goalVersion === a.goalVersion,
    );
    const target = e.preparation?.find(
      (f) =>
        f.id === c.targetFactId &&
        f.kind === 'target' &&
        f.goalVersion === a.goalVersion,
    );
    const departure =
      target &&
      attachmentDeparture(
        e.actions.slice(0, index),
        a.goalVersion,
        target.url,
        { ...a.source, links: a.observedLinks },
      );
    return (
      !!m &&
      m.sha256 === c.download.sha256 &&
      m.bytes === c.download.bytes &&
      !!target &&
      (target.url === a.source.url
        ? !c.departureActionId
        : !!departure &&
          departure.id === c.departureActionId &&
          !departure.observedLinks?.some((l) => l.url === c.download.url)) &&
      !!e.preparation?.some(
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
