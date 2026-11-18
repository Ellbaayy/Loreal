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

const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
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
    const ext = name.split('.').pop()?.toLowerCase() || 'jpg'
    const contentType = MIME_BY_EXT[ext] || 'application/octet-stream'
    if (contentType === 'application/octet-stream') {
      console.error(`[MEDIA] Unsupported extension: ${ext}`)
      return null
    }

    const path = `images/${slugify(name)}`
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
