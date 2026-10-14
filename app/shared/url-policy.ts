export function websiteURL(value: string): string {
  const url = new URL(value.trim());
  if (url.username || url.password || value.length > 4096)
    throw new Error('URL_DENIED');
  if (
    url.protocol !== 'https:' &&
    !(
      url.protocol === 'http:' &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    )
  )
    throw new Error('URL_DENIED');
  return url.href;
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
