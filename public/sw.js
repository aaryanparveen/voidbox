

async function handleFetch(request) {
  try {
    var r = await fetch(request);
  } catch (e) {
    return new Response('Network error', { status: 503 });
  }

  if (r.status === 0) return r;

  const newHeaders = new Headers(r.headers);
  newHeaders.set('Cross-Origin-Resource-Policy', 'cross-origin');

  return new Response(r.body, {
    headers: newHeaders,
    status: r.status,
    statusText: r.statusText,
  });
}

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  e.respondWith(handleFetch(e.request));
});


