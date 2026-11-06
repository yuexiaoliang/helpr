import { createHash, randomUUID } from 'node:crypto';
import { parse, type DefaultTreeAdapterMap } from 'parse5';
import type { TaskExecution } from '../shared/execution';
import { pageSourceSchema, type PageObservation } from '../shared/model';
import { MATERIAL_LIMIT, type MaterialVersion } from '../shared/material';
import { websiteURL } from '../shared/url-policy';
import {
  type Publication,
  type PublicationResultProposal,
  type PublicationCheck,
  type DownloadCheck,
} from '../shared/publication';

const digest = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');
const normalize = (s: string) => s.replace(/\s+/gu, ' ').trim();
const has = (text: string, value: string) =>
  normalize(text).includes(normalize(value));
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
    links: string[] = [];
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
  visit(parse(html));
  return { text: texts.join(' '), links };
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
  try {
    const bytes = await read(proposal.url, 2 * 1024 * 1024, signal);
    result.pageSha256 = digest(bytes);
    const page = publicContent(bytes.toString('utf8'), proposal.url);
    result.checks.content = has(page.text, p.content);
    result.checks.destination = has(page.text, p.destination);
    result.checks.attachment =
      page.links.filter((link) => link === a.url).length === 1;
    if (
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
