export default defineEventHandler((event) => {
  if (!event.path.split('?')[0]?.startsWith('/previews/')) return;
  setResponseHeaders(event, {
    'Cache-Control': 'private, no-store, max-age=0',
    'Referrer-Policy': 'no-referrer',
    'X-Robots-Tag': 'noindex, nofollow, noarchive',
  });
});
