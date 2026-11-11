import { createHash, randomUUID } from 'node:crypto';
import { parse, type DefaultTreeAdapterMap } from 'parse5';
import type { TaskExecution, ActionFact } from '../shared/execution';
import { pageSourceSchema, type PageObservation } from '../shared/model';
import { MATERIAL_LIMIT, type MaterialVersion } from '../shared/material';
import { websiteURL } from '../shared/url-policy';
import {
  publicationParts,
  containsPublicText,
  validRecoveryEntry,
  type Publication,
  type PublicationResultProposal,
  type PublicationCheck,
  type DownloadCheck,
} from '../shared/publication';

const digest = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');
const linkObserved = (source: PageObservation, url: string) =>
  source.url === url || source.text.split('\n').includes('[link-url] ' + url);
export type VerificationInput = {
  execution: TaskExecution;
  source: PageObservation;
  proposal: PublicationResultProposal;
  actionId: string;
  anomalies?: string[];
  extraResults?: string[];
  signal: AbortSignal;
};

/** 每次仅获取已经观察到的同站地址；不携带登录、不重试、不跟随重定向。 */
async function read(
  url: string,
  limit: number,
  signal: AbortSignal,
): Promise<Buffer> {
  const response = await fetch(websiteURL(url), {
    method: 'GET',
    credentials: 'omit',
    redirect: 'error',
    cache: 'no-store',
    signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
  });
  if (response.status !== 200 || !response.body) {
    await response.body?.cancel();
    throw Error('RESULT_READ_UNAVAILABLE');
  }
  if (Number(response.headers.get('content-length') ?? 0) > limit) {
    await response.body.cancel();
    throw Error('RESULT_TOO_LARGE');
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > limit) throw Error('RESULT_TOO_LARGE');
      chunks.push(chunk.value);
    }
    return Buffer.concat(chunks);
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export async function verifyAttachment(
  publication: Publication,
  material: MaterialVersion,
  signal: AbortSignal,
): Promise<DownloadCheck> {
  const a = publication.attachment;
  if (
    !a ||
    a.materialId !== material.id ||
    new URL(a.url).origin !== new URL(a.targetUrl).origin
  )
    throw Error('PUBLICATION_BINDING_MISMATCH');
  const bytes = await read(a.url, MATERIAL_LIMIT, signal);
  const check = {
    url: a.url,
    bytes: bytes.length,
    sha256: digest(bytes),
    checkedAt: Date.now(),
  };
  if (check.bytes !== material.bytes || check.sha256 !== material.sha256)
    throw Error('PUBLICATION_BYTES_MISMATCH');
  return check;
}

function publicContent(html: string, url: string) {
  const texts: string[] = [],
    links: string[] = [],
    canonical: string[] = [];
  const document = parse(html);
  const identities = (node: DefaultTreeAdapterMap['node']) => {
    if ('tagName' in node && node.tagName === 'link') {
      const attrs = Object.fromEntries(
        node.attrs.map((a) => [a.name, a.value]),
      );
      if (
        attrs.rel?.toLowerCase().split(/\s+/).includes('canonical') &&
        attrs.href
      ) {
        try {
          canonical.push(websiteURL(new URL(attrs.href, url).href));
        } catch {
          /* 非网页地址不作为身份。 */
        }
      }
    }
    if ('childNodes' in node) node.childNodes.forEach(identities);
  };
  identities(document);
  const visit = (node: DefaultTreeAdapterMap['node']) => {
    if ('tagName' in node) {
      const attrs = Object.fromEntries(
        node.attrs.map((a) => [a.name, a.value]),
      );
      if (
        [
          'head',
          'script',
          'style',
          'template',
          'noscript',
          'input',
          'textarea',
          'select',
        ].includes(node.tagName) ||
        'hidden' in attrs ||
        attrs['aria-hidden'] === 'true' ||
        /display\s*:\s*none|visibility\s*:\s*hidden/i.test(attrs.style ?? '')
      )
        return;
      if (node.tagName === 'a' && attrs.href) {
        try {
          links.push(websiteURL(new URL(attrs.href, url).href));
        } catch {
          /* 非网页链接不参与核对。 */
        }
      }
    }
    if ('value' in node && node.nodeName === '#text') texts.push(node.value);
    if ('childNodes' in node) node.childNodes.forEach(visit);
  };
  visit(document);
  return { text: texts.join(' '), links, canonical };
}

/** 冷进程仅消费可靠保存的关联；不访问搜索、测试收件或模型服务。 */
export async function verifyRecoveredPublication(
  e: TaskExecution,
  action: ActionFact,
  signal: AbortSignal,
): Promise<PublicationCheck> {
  const submission = action.submission!,
    p = submission.publication,
    a = p.attachment!,
    rule = (action.discoveredRecovery?.recovery ?? submission.recovery)!,
    material = e.materials!.find(
      (m) => m.id === a.materialId && m.goalVersion === action.goalVersion,
    )!;
  const known =
    e.observedAnomalies?.filter((o) => o.goalVersion === action.goalVersion) ??
    [];
  const check: PublicationCheck = {
    id: randomUUID(),
    actionId: action.id,
    approvalId: action.publicationApprovalId!,
    materialId: material.id,
    goalVersion: action.goalVersion,
    status: 'unknown',
    proposal: {
      url: rule.url,
      targetUrl: rule.targetUrl,
      attachmentUrl: rule.attachmentUrl,
      publishedEvidence: ['核对规则：唯一公开地址、确认内容、栏目和附件字节'],
    },
    source: { ...action.source },
    checkedAt: Date.now(),
    checks: {
      target: false,
      published: false,
      content: false,
      destination: false,
      attachment: false,
      bytes: false,
    },
    failure: 'evidence',
    coverage: 'public-page-and-attachment',
    extraResults: known.flatMap((o) => o.extraResults).slice(0, 50),
    anomalies: known.flatMap((o) => o.anomalies).slice(0, 20),
    unobservedWrites: 'unknown',
    screenshot: 'not-required',
    recovery: rule.rule,
  };
  if (check.anomalies.length || check.extraResults.length) return check;
  // 冷开已验证结构与引用；仍不把旧观察当作当前网站证据。
  check.checks.target =
    rule.targetUrl === a.targetUrl &&
    rule.attachmentUrl === a.url &&
    action.source.url === rule.targetUrl &&
    (action.discoveredRecovery
      ? validRecoveryEntry(p, action.discoveredRecovery)
      : !!action.observedUrls?.includes(rule.url)) &&
    new URL(rule.url).origin === new URL(rule.targetUrl).origin;
  if (!check.checks.target) return check;
  return readPublicResult(
    p,
    material,
    check,
    signal,
    true,
    !!action.discoveredRecovery?.entry,
  );
}

async function readPublicResult(
  p: Publication,
  material: MaterialVersion,
  result: PublicationCheck,
  signal: AbortSignal,
  requireCanonical = false,
  requireTargetLink = false,
) {
  try {
    const bytes = await read(result.proposal.url, 2 * 1024 * 1024, signal);
    result.pageSha256 = digest(bytes);
    const page = publicContent(bytes.toString('utf8'), result.proposal.url);
    if (requireCanonical) {
      result.source = {
        ...result.source,
        url: result.proposal.url,
        fingerprint: result.pageSha256,
        observedAt: Date.now(),
        title: '独立公开结果核对',
        truncated: false,
      };
      result.checks.published =
        page.canonical.length === 1 &&
        page.canonical[0] === result.proposal.url;
    }
    if (requireTargetLink) {
      result.checks.target =
        page.links.filter((link) => link === p.attachment!.targetUrl).length ===
        1;
      if (!result.checks.target) return result;
    }
    result.checks.content = publicationParts(p).every((part) =>
      containsPublicText(page.text, part),
    );
    result.checks.destination = containsPublicText(page.text, p.destination);
    result.checks.attachment =
      page.links.filter((link) => link === p.attachment!.url).length === 1;
    if (
      !result.checks.published ||
      !result.checks.content ||
      !result.checks.destination ||
      !result.checks.attachment
    ) {
      result.failure = 'content';
      return result;
    }
    result.download = await verifyAttachment(p, material, signal);
    result.checks.bytes = true;
    result.status = 'verified';
    result.failure = 'none';
  } catch (error) {
    if (signal.aborted) throw error;
    result.failure =
      error instanceof Error && error.message === 'PUBLICATION_BYTES_MISMATCH'
        ? 'bytes'
        : 'network';
  } finally {
    result.checkedAt = Date.now();
  }
  return result;
}

export async function verifyPublication(
  input: VerificationInput,
): Promise<PublicationCheck> {
  const { execution: e, source, proposal, signal } = input,
    p = e.publication!,
    a = p.attachment!;
  const material = e.materials!.find(
    (m) => m.id === a.materialId && m.goalVersion === e.goalVersion,
  )!;
  const knownAnomalies =
    e.observedAnomalies?.filter((o) => o.goalVersion === e.goalVersion) ?? [];
  const result: PublicationCheck = {
    id: randomUUID(),
    actionId: input.actionId,
    approvalId: p.approvalId!,
    materialId: material.id,
    goalVersion: e.goalVersion,
    status: 'unknown',
    proposal,
    source: pageSourceSchema.strip().parse(source),
    checkedAt: Date.now(),
    checks: {
      target: false,
      published: false,
      content: false,
      destination: false,
      attachment: false,
      bytes: false,
    },
    failure: 'evidence',
    coverage: 'public-page-and-attachment',
    extraResults: [
      ...knownAnomalies.flatMap((o) => o.extraResults),
      ...(input.extraResults ?? []),
    ].slice(0, 50),
    anomalies: [
      ...knownAnomalies.flatMap((o) => o.anomalies),
      ...(input.anomalies ?? []),
    ].slice(0, 20),
    unobservedWrites: 'unknown',
    screenshot: 'not-required',
  };
  if (
    result.anomalies.length ||
    result.extraResults.length ||
    !material ||
    !p.approvalId
  )
    return result;
  const origin = new URL(a.targetUrl).origin;
  result.checks.target =
    proposal.targetUrl === a.targetUrl &&
    proposal.attachmentUrl === a.url &&
    [source.url, proposal.url, a.url].every(
      (url) => new URL(url).origin === origin,
    ) &&
    proposal.url !== a.targetUrl &&
    linkObserved(source, proposal.url) &&
    (source.url === a.targetUrl || source.text.includes(a.targetUrl));
  result.checks.published = proposal.publishedEvidence.every((v) =>
    source.text.includes(v),
  );
  if (!result.checks.target || !result.checks.published) return result;
  return readPublicResult(p, material, result, signal);
}
