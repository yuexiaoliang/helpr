export function websiteURL(value: string): string {
  const url = new URL(value.trim());
  if (url.username || url.password || value.length > 4096)
    throw new Error('URL_DENIED');
  if (!['https:', 'http:'].includes(url.protocol))
    throw new Error('URL_DENIED');
  return url.href;
}

/** 只用于已证明父归属与继承来源的子文档，不是可导航的网站地址。 */
export function isInlineFrameURL(value: string): boolean {
  return value === 'about:blank' || value === 'about:srcdoc';
}

/** 未接入模型时只采用用户明确提供的合法 URL。 */
export function explicitWebsite(goal: string): string {
  const match = goal.match(/https?:\/\/[^\s<>"'，。；）)]+/u)?.[0];
  if (!match) return '';
  try {
    return websiteURL(match);
  } catch {
    return '';
  }
}
