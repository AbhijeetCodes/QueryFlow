// Share by link: the SQL is deflated and base64url-encoded into the URL's #hash.
// Browsers never send the hash to the server, so the query stays out of the
// host's logs; whoever opens the link decodes it locally.

const PREFIX = '#sql=';

async function pipe(bytes, stream) {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
}

function toBase64Url(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** '#sql=…&dialect=…' for `text`. */
export async function encodeShare(text, dialect) {
  return PREFIX + toBase64Url(await pipe(new TextEncoder().encode(text), new CompressionStream('deflate-raw'))) +
    (dialect ? '&dialect=' + encodeURIComponent(dialect) : '');
}

/**
 * { text, dialect } from a '#sql=…' hash, null when there is none, or throws when
 * it is damaged. Links made before dialects existed are BigQuery.
 */
export async function decodeShare(hash) {
  if (!hash.startsWith(PREFIX)) return null;
  const [data, ...rest] = hash.slice(PREFIX.length).split('&');
  const dialect = new URLSearchParams(rest.join('&')).get('dialect') || 'bigquery';
  const text = new TextDecoder().decode(await pipe(fromBase64Url(data), new DecompressionStream('deflate-raw')));
  return { text, dialect };
}
