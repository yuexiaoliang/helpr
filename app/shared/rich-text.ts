import type { PageObservation } from './model';
import type { WebAction } from './web-action';
import { isBlobFrameURL, isInlineFrameURL } from './url-policy';

type ObservedControl = NonNullable<PageObservation['controls']>[number];

export const defaultParagraphButton = 'Add default block';
export const emptyParagraphName =
  'Empty block; start writing or type forward slash to choose a block';
const filledParagraphName = 'Block: Paragraph';

export function isEmptyParagraph(control: ObservedControl) {
  return (
    control.role === 'document' &&
    control.name === emptyParagraphName &&
    control.readOnly === false &&
    control.textValue === '' &&
    !!control.richText?.locator
  );
}

export function sameRichTextReadback(
  before: ObservedControl,
  after: ObservedControl,
) {
  return (
    before.role === after.role &&
    (before.name === after.name ||
      (isEmptyParagraph(before) && after.name === filledParagraphName))
  );
}

export function observedDefaultParagraph(source: PageObservation) {
  const origin = new URL(source.url).origin;
  const controls = source.controls?.filter(
    (control) =>
      isBlobFrameURL(control.frameUrl) &&
      new URL(control.frameUrl).origin === origin &&
      ((control.role === 'button' && control.name === defaultParagraphButton) ||
        (control.role === 'document' && control.name === emptyParagraphName)),
  );
  const control = controls?.[0];
  if (
    controls?.length === 1 &&
    control &&
    !control.disabled &&
    source.text.includes(control.name) &&
    (control.role === 'button' || isEmptyParagraph(control))
  )
    return control;
}

/** 富文本仅支持已有 DOM/AX 证明的普通 contenteditable，纯文本整体替换；不承诺保留格式。 */
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
  const structural = 'richTextNodeId' in target;
  const matches =
    source.controls?.filter(
      (c) =>
        (structural
          ? c.richText?.backendNodeId === target.richTextNodeId &&
            c.richText.locator?.richTextNodeId === target.richTextNodeId &&
            c.richText.locator.path === target.path &&
            c.richText.locator.frameUrl === target.frameUrl
          : c.role === target.role && c.name === target.name) &&
        c.frameUrl === (target.frameUrl ?? source.url),
    ) ?? [];
  if (
    !required &&
    !structural &&
    !matches.some((c) => c.richText || c.richTextUnavailable)
  )
    return undefined;
  const control = matches[0];
  if (
    source.truncated ||
    (!structural &&
      (target.role !== 'textbox' || !target.exact || target.within)) ||
    (target.frameUrl &&
      !isInlineFrameURL(target.frameUrl) &&
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

export function verifiedReopenedRichText(
  action: WebAction,
  before: ObservedControl,
  source: PageObservation,
) {
  if (
    action.kind !== 'fill' ||
    !('richTextNodeId' in action.target) ||
    !before.name ||
    !isBlobFrameURL(action.target.frameUrl)
  )
    throw Error('EXECUTION_RICH_TEXT_UNVERIFIED');
  const path = action.target.path;
  const origin = new URL(source.url).origin;
  const matches = source.controls?.filter(
    (control) =>
      sameRichTextReadback(before, control) &&
      control.richText?.locator?.path === path &&
      isBlobFrameURL(control.frameUrl) &&
      new URL(control.frameUrl).origin === origin,
  );
  const target = matches?.[0]?.richText?.locator;
  if (matches?.length !== 1 || !target)
    throw Error('EXECUTION_RICH_TEXT_UNVERIFIED');
  return verifiedRichText({ ...action, target }, source);
}

export function validRichTextFact(a: {
  action: WebAction;
  source: Omit<PageObservation, 'text'>;
  status: string;
  navigation?: unknown;
  returned?: boolean;
  richTextSource?: ObservedControl;
  richTextResult?: ObservedControl;
  resultSource?: Omit<PageObservation, 'text'>;
}) {
  if (!a.richTextSource)
    return !a.richTextResult && !('richTextNodeId' in a.action.target);
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
    const result = {
      ...a.resultSource,
      text: '',
      controls: [a.richTextResult],
    };
    if (
      a.returned &&
      (a.richTextSource.frameUrl !== a.richTextResult.frameUrl ||
        a.richTextSource.richText?.backendNodeId !==
          a.richTextResult.richText?.backendNodeId)
    )
      verifiedReopenedRichText(a.action, a.richTextSource, result);
    else verifiedRichText(a.action, result);
    return true;
  } catch {
    return false;
  }
}
