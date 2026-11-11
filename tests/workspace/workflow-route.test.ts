import { expect, test } from 'vitest';
import type { PageObservation } from '../../app/shared/model';
import type { WorkflowUse } from '../../app/shared/workflow';
import { workflowNavigationMatches } from '../../app/shared/workflow-replay';

test('跨页重放仅替换本次已绑定的地址参数，保留链接原有用途', () => {
  const base = 'https://example.com';
  const entry = base + '/list?item=A';
  const current = base + '/list?item=B';
  const oldEditor = base + '/draft/old-id/edit';
  const editor = base + '/draft/new-id/edit';
  const use = {
    targetUrl: current,
    workflow: {
      recovery: { targetUrl: oldEditor },
      steps: [
        {
          navigation: { kind: 'link' },
          before: { source: { url: entry } },
          after: { source: { url: base + '/new?item=A&mode=create' } },
        },
        {
          navigation: { kind: 'link' },
          before: { source: { url: oldEditor } },
          after: { source: { url: base + '/media?draft=old-id&mode=attach' } },
        },
      ],
    },
  } as unknown as WorkflowUse;
  const action = {
    kind: 'click',
    target: { role: 'link', name: '继续操作', exact: true },
  } as const;
  const matches = (index: number, url: string, href: string) => {
    const source: PageObservation = {
      url,
      title: '当前页面',
      text: '继续操作',
      fingerprint: 'example',
      generation: 1,
      observedAt: 1,
      truncated: false,
      links: [{ name: '继续操作', url: base + href }],
    };
    return workflowNavigationMatches(
      use,
      index,
      source,
      action,
      editor,
      undefined,
    );
  };
  expect(matches(0, current, '/new?item=B&mode=create')).toBe(true);
  expect(matches(0, current, '/new?item=B&mode=other')).toBe(false);
  expect(matches(0, current, '/new?item=C&mode=create')).toBe(false);
  expect(matches(0, current, '/new?item=A&mode=create')).toBe(false);
  expect(matches(1, editor, '/media?draft=new-id&mode=attach')).toBe(true);
  expect(matches(1, editor, '/media?draft=other-id&mode=attach')).toBe(false);
});
