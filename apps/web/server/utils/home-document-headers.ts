export const HOME_DOCUMENT_FORWARDED_HEADERS = [
  'content-type',
  'content-security-policy',
  'cache-control',
  'etag',
  'referrer-policy',
  'permissions-policy',
  'x-content-type-options',
  'content-language',
  'vary',
  'warning',
] as const;

const STRUCTURED_PAGE_FORWARDED_HEADERS = [
  'cache-control',
  'etag',
  'content-language',
  'vary',
  'warning',
] as const;

export function homeDocumentResponseHeaders(response: Response) {
  const headers =
    response.status === 200 || response.status === 304
      ? HOME_DOCUMENT_FORWARDED_HEADERS
      : STRUCTURED_PAGE_FORWARDED_HEADERS;
  return headers.flatMap((header) => {
    const value = response.headers.get(header);
    return value ? ([[header, value]] as const) : [];
  });
}
