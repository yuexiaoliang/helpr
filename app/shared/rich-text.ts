import type { PageObservation } from './model';
import type { WebAction } from './web-action';

/** 富文本仅支持显式命名且已有 DOM 证明的同站 textbox，纯文本整体替换；不承诺保留格式。 */
export function richTextControl(
  action: WebAction,
  source: PageObservation,
  required = false,
) {
  if (action.kind !== 'fill') {
    if (required) throw Error('EXECUTION_RICH_TEXT_UNVERIFIED');
    return undefined;
  }
  const { target } = action;
  const matches =
    source.controls?.filter(
      (c) =>
        c.role === target.role &&
        c.name === target.name &&
        c.frameUrl === (target.frameUrl ?? source.url),
    ) ?? [];
  if (!required && !matches.some((c) => c.richText || c.richTextUnavailable))
    return undefined;
  const control = matches[0];
  if (
    source.truncated ||
    target.role !== 'textbox' ||
    !target.exact ||
    target.within ||
    (target.frameUrl &&
      new URL(target.frameUrl).origin !== new URL(source.url).origin) ||
    matches.length !== 1 ||
    !control?.richText ||
    control.richTextUnavailable ||
    control.disabled ||
    control.readOnly !== false ||
    control.textValue === undefined ||
    !!control.emptyValue ||
    (control.richText.valueSource === 'empty-dom' &&
      control.textValue !== '') ||
    action.value.length > 4000
  )
    throw Error('EXECUTION_RICH_TEXT_UNVERIFIED');
  return control;
}

export function verifiedRichText(action: WebAction, source: PageObservation) {
  const control = richTextControl(action, source, true)!;
  if (action.kind !== 'fill' || control.textValue !== action.value)
    throw Error('EXECUTION_RICH_TEXT_UNVERIFIED');
  return control;
}

export function validRichTextFact(a: {
  action: WebAction;
  source: Omit<PageObservation, 'text'>;
  status: string;
  navigation?: unknown;
  richTextSource?: NonNullable<PageObservation['controls']>[number];
  richTextResult?: NonNullable<PageObservation['controls']>[number];
  resultSource?: Omit<PageObservation, 'text'>;
}) {
  if (!a.richTextSource) return !a.richTextResult;
  try {
    richTextControl(
      a.action,
      { ...a.source, text: '', controls: [a.richTextSource] },
      true,
    );
    if (a.status !== 'confirmed') return !a.richTextResult;
    if (
      !a.richTextResult ||
      !a.resultSource ||
      a.navigation ||
      a.source.url !== a.resultSource.url
    )
      return false;
    verifiedRichText(a.action, {
      ...a.resultSource,
      text: '',
      controls: [a.richTextResult],
    });
    return true;
  } catch {
    return false;
  }
}
