// Byte-range server for the banner loop (public/themes/vintage-poster/video/*.mp4|webm).
// Why: Cloudflare Pages static assets ignore the Range header (always 200, no Accept-Ranges), and iPhone Safari will not
// play a <video> unless the server answers its "Range: bytes=0-1" probe with 206 Partial Content. This reads the same
// static file through env.ASSETS and answers single ranges with 206. Read-only, no DB, no state.
// _headers does not apply to Function responses, so the static security headers are repeated here.
const TYPES = { mp4: 'video/mp4', webm: 'video/webm' };
const BASE_HEADERS = {
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'public, max-age=86400',
  'Accept-Ranges': 'bytes',
};

export async function onRequest({ request, env, params }) {
  const name = String(params.file || '');
  const ext = (name.match(/^[a-z0-9-]+\.(mp4|webm)$/) || [])[1];
  if (!ext) return new Response('Not found', { status: 404 });
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });

  const url = new URL(request.url);
  const asset = await env.ASSETS.fetch(new Request(url.origin + url.pathname));   // no Range, no conditional headers
  // a missing file comes back as the SPA fallback (index.html, 200), so also require a video type
  if (!asset.ok || !/^video\//.test(asset.headers.get('Content-Type') || '')) return new Response('Not found', { status: 404 });
  const buf = await asset.arrayBuffer();
  const size = buf.byteLength;
  const etag = asset.headers.get('ETag');
  const h = new Headers(BASE_HEADERS);
  h.set('Content-Type', TYPES[ext]);
  if (etag) h.set('ETag', etag);

  const range = request.headers.get('Range');
  const ifRange = request.headers.get('If-Range');
  const m = range && (!ifRange || ifRange === etag) ? range.match(/^bytes=(\d*)-(\d*)$/) : null;   // single range only
  if (!m || (m[1] === '' && m[2] === '')) {
    h.set('Content-Length', String(size));
    return new Response(request.method === 'HEAD' ? null : buf, { status: 200, headers: h });
  }
  let start, end;
  if (m[1] === '') { const n = Number(m[2]); start = Math.max(0, size - n); end = size - 1; }      // bytes=-N (last N)
  else { start = Number(m[1]); end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1); }
  if (!(start <= end) || start >= size) {
    h.set('Content-Range', `bytes */${size}`);
    return new Response(null, { status: 416, headers: h });
  }
  h.set('Content-Range', `bytes ${start}-${end}/${size}`);
  h.set('Content-Length', String(end - start + 1));
  return new Response(request.method === 'HEAD' ? null : buf.slice(start, end + 1), { status: 206, headers: h });
}
