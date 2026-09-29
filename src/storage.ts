/**
 * Media storage for LORE-AI.
 *
 * Uploads go to a Cloudflare R2 bucket (S3-compatible API) and the returned
 * object URL is what gets persisted in the database.
 *
 * Why not imgbb: imgbb is a file-sharing host, not an image CDN. Its subdomain
 * `i.ibb.co` is DNS-sinkholed by Indonesian ISPs (observed: Indosat redirects it
 * to 114.7.173.246), so product images never load for local users. R2 is served
 * from a stable public domain and is not filtered.
 *
 * Signing is implemented with AWS Signature Version 4 over the Web Crypto API,
 * so no extra dependency is needed (the container only ships hono + mysql2).
 */

const ACCOUNT_ID = process.env.R2_ACCOUNT_ID || ''
const ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID || ''
const SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY || ''
const BUCKET = process.env.R2_BUCKET || ''
const PUBLIC_URL = (process.env.R2_PUBLIC_URL || '').replace(/\/+$/, '')

const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
}

function hex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/** Copy into a plain ArrayBuffer so Web Crypto accepts it regardless of view type. */
function copyBytes(data: ArrayBuffer | Uint8Array): ArrayBuffer {
  const view = data instanceof Uint8Array ? data : new Uint8Array(data)
  return view.slice().buffer
}

async function sha256(data: ArrayBuffer | Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', copyBytes(data)))
}

async function hmac(key: ArrayBuffer | Uint8Array, msg: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    copyBytes(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(msg))
}

function encodePath(key: string): string {
  return key
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/')
}

/**
 * Upload a file to R2 and return its public URL, or null on any failure.
 * Never throws - callers treat null as "no image available".
 */
export async function uploadMedia(
  data: ArrayBuffer | File,
  filename?: string,
): Promise<string | null> {
  if (!ACCOUNT_ID || !ACCESS_KEY_ID || !SECRET_ACCESS_KEY || !BUCKET || !PUBLIC_URL) {
    console.error('[R2] Missing configuration, skipping upload')
    return null
  }

  try {
    const bytes = data instanceof File ? await data.arrayBuffer() : data
    const name = filename || (data instanceof File ? data.name : 'image.jpg')
    const ext = name.split('.').pop()?.toLowerCase() || 'jpg'
    const contentType = MIME_BY_EXT[ext] || 'application/octet-stream'

    const now = new Date()
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '')
    const dateStamp = amzDate.slice(0, 8)

    const host = `${ACCOUNT_ID}.r2.cloudflarestorage.com`
    const key = `perfumes/${dateStamp}/${name}`
    const canonicalUri = `/${BUCKET}/${encodePath(key)}`
    const payloadHash = await sha256(bytes)

    const canonicalHeaders =
      `content-type:${contentType}\n` +
      `host:${host}\n` +
      `x-amz-content-sha256:${payloadHash}\n` +
      `x-amz-date:${amzDate}\n`
    const signedHeaders = 'content-type;host;x-amz-content-sha256;x-amz-date'

    const canonicalRequest = [
      'PUT',
      canonicalUri,
      '',
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n')

    const scope = `${dateStamp}/auto/s3/aws4_request`
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      scope,
      await sha256(new TextEncoder().encode(canonicalRequest)),
    ].join('\n')

    const kDate = await hmac(new TextEncoder().encode(`AWS4${SECRET_ACCESS_KEY}`), dateStamp)
    const kRegion = await hmac(kDate, 'auto')
    const kService = await hmac(kRegion, 's3')
    const kSigning = await hmac(kService, 'aws4_request')
    const signature = hex(await hmac(kSigning, stringToSign))

    const authorization =
      `AWS4-HMAC-SHA256 Credential=${ACCESS_KEY_ID}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`

    const res = await fetch(`https://${host}${canonicalUri}`, {
      method: 'PUT',
      headers: {
        'content-type': contentType,
        'x-amz-content-sha256': payloadHash,
        'x-amz-date': amzDate,
        authorization,
      },
      body: bytes,
    })

    if (!res.ok) {
      console.error(`[R2] HTTP ${res.status}: ${await res.text()}`)
      return null
    }

    return `${PUBLIC_URL}/${key}`
  } catch (err) {
    console.error('[R2] Error:', err)
    return null
  }
}

/** True when all R2 credentials are present, useful for health checks. */
export function isStorageConfigured(): boolean {
  return Boolean(ACCOUNT_ID && ACCESS_KEY_ID && SECRET_ACCESS_KEY && BUCKET && PUBLIC_URL)
}
