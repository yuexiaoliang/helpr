import { expect, test } from 'vitest';
import { FormRequestChainWatch } from '../../app/desktop/form-request-chain';
import { HostFormChains } from '../../app/desktop/host-form-chain';
import {
  formChainEpoch,
  validFormRequestChain,
  type FormRequestChain,
} from '../../app/shared/form-navigation-chain';
const source = 'https://example.com/new',
  post = 'https://example.com/post',
  final = 'https://example.com/edit/123';
const n = {
  id: '00000000-0000-4000-8000-000000000000',
  association: 'during-action' as const,
  targetId: 'page',
  sourceGeneration: 1,
  generation: 2,
  inputEpoch: 4,
  observedAt: 1,
  url: post,
  mainFrame: true,
  sameDocument: false,
};
function network(variant = 'valid') {
  const watch = new FormRequestChainWatch(source, post, 'main', 'cdp');
  const request = (
    url: string,
    method: string,
    redirectResponse?: { url: string; status: number },
    change = {},
  ) =>
    watch.event('Network.requestWillBeSent', {
      requestId: 'req',
      loaderId: 'loader',
      frameId: 'main',
      type: 'Document',
      request: { url, method },
      redirectResponse,
      ...change,
    });
  request(post, 'POST');
  if (variant === 'extra-navigation')
    watch.event('Page.frameRequestedNavigation', {});
  if (variant === 'extra-document')
    request(final, 'GET', undefined, { requestId: 'other' });
  request(
    variant === 'cross-site' ? 'https://other.example/edit' : final,
    variant === 'repost' ? 'POST' : 'GET',
    {
      url: variant === 'wrong-from' ? source : post,
      status: variant === '302' ? 302 : 303,
    },
    variant === 'request-id'
      ? { requestId: 'other' }
      : variant === 'loader'
        ? { loaderId: 'other' }
        : variant === 'subframe'
          ? { frameId: 'child' }
          : {},
  );
  if (variant === 'failed')
    watch.event('Network.loadingFailed', { requestId: 'req' });
  watch.event('Network.responseReceived', {
    requestId: 'req',
    loaderId: 'loader',
    frameId: 'main',
    type: 'Document',
    response: { url: final, status: variant === 'error' ? 500 : 200 },
  });
  watch.event('Page.frameNavigated', {
    frame: {
      id: 'main',
      loaderId: variant === 'commit-loader' ? 'other' : 'loader',
      url: final,
    },
  });
  return watch.event('Network.loadingFinished', {
    requestId: variant === 'unfinished' ? 'other' : 'req',
  });
}
test.each([
  'valid',
  'extra-navigation',
  'extra-document',
  'cross-site',
  'repost',
  'wrong-from',
  '302',
  'request-id',
  'loader',
  'subframe',
  'failed',
  'error',
  'commit-loader',
  'unfinished',
])('CDP完整POST303链与不明/失败请求：%s', (variant) => {
  const chain = network(variant);
  expect(!!chain).toBe(variant === 'valid');
  if (chain)
    expect(chain).toMatchObject({
      requestId: 'req',
      loaderId: 'loader',
      frameId: 'main',
      sessionId: 'cdp',
      finalUrl: final,
      requests: [
        { url: post, method: 'POST' },
        { url: final, method: 'GET', redirectStatus: 303 },
      ],
    });
});
test('宿主首个导航、同target/代次重定向、失效与时限独立核对', () => {
  let now = 0;
  const h = new HostFormChains(() => now);
  const event = { taskId: 't', runId: 'r', actionId: 'a', navigation: n };
  h.start(event, { requestId: 'start', before: 4, after: 5 });
  h.redirect('t', 'page', 2, final, true, {
    requestId: 'redirect',
    before: 6,
    after: 7,
  });
  expect(h.get('t')?.events.map((e) => e.url)).toEqual([post, final]);
  for (const change of [
    { target: 'other', generation: 2, main: true },
    { target: 'page', generation: 3, main: true },
    { target: 'page', generation: 2, main: false },
  ]) {
    h.start(event, { requestId: 'start', before: 4, after: 5 });
    h.redirect('t', change.target, change.generation, final, change.main, {
      requestId: 'r',
      before: 6,
      after: 7,
    });
    expect(h.get('t')).toBeUndefined();
  }
  h.start(event, { requestId: 'start', before: 4, after: 6 });
  expect(h.get('t')).toBeUndefined();
  h.start(event, { requestId: 'start', before: 4, after: 5 });
  h.invalidate('t');
  expect(h.get('t')).toBeUndefined();
  h.start(event, { requestId: 'start', before: 4, after: 5 });
  now = 16000;
  expect(h.get('t')).toBeUndefined();
});
test('原生回执必须精确覆盖每个epoch；相同次数不能替代URL、事件身份或连续性', () => {
  const chain = network()!;
  const host = {
    navigationId: n.id,
    targetId: 'page',
    generation: 2,
    events: [
      {
        kind: 'start' as const,
        url: post,
        requestId: 'start',
        before: 4,
        after: 5,
      },
      {
        kind: 'redirect' as const,
        url: final,
        requestId: 'redirect',
        before: 6,
        after: 7,
      },
    ],
  };
  const evidence = {
    host,
    control: [{ requestId: 'start', before: 5, after: 6 }],
  };
  expect(formChainEpoch(chain, evidence, n)).toBe(7);
  for (const changed of [
    { ...evidence, control: [] },
    { ...evidence, control: [{ requestId: 'unknown', before: 5, after: 6 }] },
    { ...evidence, control: [{ requestId: 'start', before: 5, after: 7 }] },
    { ...evidence, control: [{ requestId: 'start', before: 6, after: 7 }] },
    { ...evidence, host: { ...host, navigationId: 'other' } },
    {
      ...evidence,
      host: {
        ...host,
        events: [host.events[0]!, { ...host.events[1]!, url: post }],
      },
    },
    {
      ...evidence,
      host: {
        ...host,
        events: [host.events[0]!, { ...host.events[1]!, before: 7, after: 8 }],
      },
    },
  ])
    expect(formChainEpoch(chain, changed, n)).toBeUndefined();
});
test('同一网络请求可经多跳GET回原POSTURL，首跳仍只准303，拒绝凭跳数吸收其它协议', () => {
  const chain: FormRequestChain = {
    ...network()!,
    requests: [
      { url: post, method: 'POST' },
      { url: final, method: 'GET', redirectStatus: 303 },
      { url: post, method: 'GET', redirectStatus: 302 },
    ],
    finalUrl: post,
  };
  expect(validFormRequestChain(chain, source, post)).toBe(true);
  for (const status of [301, 302, 307, 308])
    expect(
      validFormRequestChain(
        {
          ...chain,
          requests: [
            chain.requests[0]!,
            { ...chain.requests[1]!, redirectStatus: status },
            chain.requests[2]!,
          ],
        },
        source,
        post,
      ),
    ).toBe(false);
});
