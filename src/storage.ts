/**
 * Media storage for LORE-AI.
 *
 * Uploads are committed to a public GitHub repository and served back through
 * the jsDelivr CDN. The URL persisted in the database is the jsDelivr one.
 *
 * Why not imgbb: imgbb is a file-sharing host, not an image CDN. Its subdomain
 * `i.ibb.co` is DNS-sinkholed by Indonesian ISPs (observed: Indosat redirects it
 * to 114.7.173.246), so product images never load for local users. jsDelivr is
 * served by Fastly and resolves normally, which was verified from an Indosat
 * connection.
 */

const GITHUB_TOKEN = process.env.GITHUB_MEDIA_TOKEN || ''
const REPO = process.env.MEDIA_REPO || ''
const BRANCH = process.env.MEDIA_BRANCH || 'main'
const CDN_BASE = (process.env.MEDIA_CDN_BASE || '').replace(/\/+$/, '')

/**
 * Identify an image from its magic bytes. The client-supplied filename and
 * Content-Type are attacker-controlled, so neither is trusted: an upload is
 * only accepted when the bytes really are one of the four supported formats.
 */
export function sniffImage(bytes: Uint8Array): { ext: string; mime: string } | null {
  if (bytes.length < 12) return null
  const b = bytes
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { ext: 'jpg', mime: 'image/jpeg' }
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { ext: 'png', mime: 'image/png' }
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return { ext: 'gif', mime: 'image/gif' }
  const riff = b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
  const webp = b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  if (riff && webp) return { ext: 'webp', mime: 'image/webp' }
  return null
}

function toBase64(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes)
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < view.length; i += chunk) {
    binary += String.fromCharCode(...view.subarray(i, i + chunk))
  }
  return btoa(binary)
}

/** Reduce a filename to characters that are safe in a URL path segment. */
function slugify(filename: string): string {
  const dot = filename.lastIndexOf('.')
  const rawStem = dot > 0 ? filename.slice(0, dot) : filename
  const rawExt = dot > 0 ? filename.slice(dot + 1) : 'jpg'
  const ext = rawExt.toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg'
  const stem = rawStem
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  return `${stem ? `${stem}-` : ''}${unique}.${ext}`
}

/**
 * Commit a file to the media repository and return its jsDelivr URL, or null
 * on any failure. Never throws - callers treat null as "no image available".
 */
export async function uploadMedia(
  data: ArrayBuffer | File,
  filename?: string,
): Promise<string | null> {
  if (!GITHUB_TOKEN || !REPO || !CDN_BASE) {
    console.error('[MEDIA] Missing configuration, skipping upload')
    return null
  }

  try {
    const bytes = data instanceof File ? await data.arrayBuffer() : data
    const name = filename || (data instanceof File ? data.name : 'image.jpg')
    const sniffed = sniffImage(new Uint8Array(bytes))
    if (!sniffed) {
      console.error('[MEDIA] Rejected upload: not a supported image')
      return null
    }
    const contentType = sniffed.mime
    // Keep the caller's stem, but the extension comes from the bytes.
    const stem = name.replace(/\.[^.]*$/, '')
    const path = `images/${slugify(`${stem}.${sniffed.ext}`)}`
    const res = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${GITHUB_TOKEN}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'content-type': 'application/json',
        'user-agent': 'lore-ai',
      },
      body: JSON.stringify({
        message: `Add ${path}`,
        content: toBase64(bytes),
        branch: BRANCH,
      }),
    })

    if (!res.ok) {
      console.error(`[MEDIA] GitHub HTTP ${res.status}: ${await res.text()}`)
      return null
    }

    return `${CDN_BASE}/${path}`
  } catch (err) {
    console.error('[MEDIA] Error:', err)
    return null
  }
}

/** True when the media backend is configured, useful for health checks. */
export function isStorageConfigured(): boolean {
  return Boolean(GITHUB_TOKEN && REPO && CDN_BASE)
}
