import type { PageObservation } from './model';
import type { WebAction } from './web-action';

/** 选项出现在页面上不等于已选中；只认同一 frame 唯一控件的实际 AX 值。 */
export function selectedControl(action: WebAction, source: PageObservation) {
  if (action.kind !== 'select') return undefined;
  const { target } = action;
  const matches = source.controls?.filter(
    (c) =>
      c.role === target.role &&
      c.name === target.name &&
      c.frameUrl === (target.frameUrl ?? source.url),
  );
  if (
    source.truncated ||
    !target.exact ||
    target.within ||
    target.role !== 'combobox' ||
    matches?.length !== 1 ||
    matches[0]!.selectedLabel !== action.value
  )
    throw Error('EXECUTION_SELECTION_UNVERIFIED');
  return matches[0]!;
}

/** 发布前复核每个控件最后一次选择，不从旧确认或页面文字推定它仍然选中。 */
export function verifyCurrentSelections(
  actions: { action: WebAction; source: { url: string } }[],
  source: PageObservation,
) {
  const checked = new Set<string>();
  for (const prior of [...actions].reverse()) {
    if (prior.action.kind !== 'select') continue;
    const target = prior.action.target;
    const key = JSON.stringify({
      ...target,
      frameUrl: target.frameUrl ?? prior.source.url,
    });
    if (checked.has(key)) continue;
    checked.add(key);
    if (prior.source.url !== source.url)
      throw Error('EXECUTION_SELECTION_UNVERIFIED');
    selectedControl(prior.action, source);
  }
}
