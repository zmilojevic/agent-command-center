// Image attachments for prompts: read pasted or dropped files, downscale large
// ones, and encode them as base64 content blocks.

export interface ImageAttachment {
  id: string
  mediaType: string
  /** base64 payload, without the data: prefix */
  data: string
  name?: string
}

const MAX_SIDE = 2000
/** The API rejects images above 5 MB; leave room for base64 overhead. */
const MAX_BYTES = 3_700_000
const PASS_THROUGH = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

export function dataUrl(mediaType: string, data: string): string {
  return `data:${mediaType};base64,${data}`
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => {
      const s = String(r.result)
      resolve(s.slice(s.indexOf(',') + 1))
    }
    r.onerror = () => reject(r.error)
    r.readAsDataURL(blob)
  })
}

export async function readImage(file: File): Promise<ImageAttachment | null> {
  if (!file.type.startsWith('image/')) return null
  const id = crypto.randomUUID()
  let bitmap: ImageBitmap | null = null
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    /* not decodable (e.g. svg); send as is when the API accepts the type */
  }
  const big = bitmap ? Math.max(bitmap.width, bitmap.height) > MAX_SIDE : false
  if (bitmap && (big || file.size > MAX_BYTES || !PASS_THROUGH.has(file.type))) {
    const scale = big ? MAX_SIDE / Math.max(bitmap.width, bitmap.height) : 1
    const w = Math.max(1, Math.round(bitmap.width * scale))
    const h = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = new OffscreenCanvas(w, h)
    const ctx = canvas.getContext('2d')!
    // JPEG has no alpha; paint transparent areas white rather than black.
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, w, h)
    ctx.drawImage(bitmap, 0, 0, w, h)
    bitmap.close()
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 })
    return { id, mediaType: 'image/jpeg', data: await blobToBase64(blob), name: file.name }
  }
  bitmap?.close()
  if (!PASS_THROUGH.has(file.type)) return null
  return { id, mediaType: file.type, data: await blobToBase64(file), name: file.name }
}

export async function readImages(files: Iterable<File>): Promise<ImageAttachment[]> {
  const out: ImageAttachment[] = []
  for (const f of files) {
    const a = await readImage(f).catch(() => null)
    if (a) out.push(a)
  }
  return out
}
