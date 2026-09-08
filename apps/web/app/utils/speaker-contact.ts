export function isWechatContactUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.hostname === 'u.wechat.com' &&
      !url.port &&
      !url.username &&
      !url.password &&
      /^\/[A-Za-z0-9_-]+$/.test(url.pathname)
    );
  } catch {
    return false;
  }
}
