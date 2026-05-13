const IMGBB_KEY = process.env.IMGBB_API_KEY || ''

export async function uploadToImgbb(
  data: ArrayBuffer | File,
  filename?: string,
): Promise<string | null> {
  if (!IMGBB_KEY) return null
  try {
    const form = new FormData()
    if (data instanceof File) {
      form.append('image', data, filename || data.name)
    } else {
      const blob = new Blob([data])
      form.append('image', blob, filename || 'image.jpg')
    }
    const res = await fetch(
      `https://api.imgbb.com/1/upload?key=${IMGBB_KEY}`,
      { method: 'POST', body: form },
    )
    if (!res.ok) {
      console.error(`[IMGBB] HTTP ${res.status}: ${await res.text()}`)
      return null
    }
    const json = await res.json() as any
    return json?.data?.url || null
  } catch (err) {
    console.error('[IMGBB] Error:', err)
    return null
  }
}
