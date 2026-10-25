import type { ImageAttachment, ImageMediaType } from '@agent-web-bridge/protocol'

const TYPES = new Set<string>(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
/** Longest edge Claude uses without downscaling it itself. */
const MAX_EDGE = 1568
/** Stays below the 5 MB per-image API limit. */
const MAX_BYTES = 4 * 1024 * 1024

export function imageDataUrl(image: ImageAttachment): string {
  return `data:${image.mediaType};base64,${image.data}`
}

/** Reads an image file, downscaling it when it is larger than the agent can use. */
export async function readImage(file: Blob): Promise<ImageAttachment> {
  if (!TYPES.has(file.type)) throw new Error(`Unsupported image type: ${file.type || 'unknown'}`)
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height))
  if (scale === 1 && file.size <= MAX_BYTES) {
    bitmap.close()
    return { mediaType: file.type as ImageMediaType, data: await toBase64(file) }
  }

  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  let blob = await toBlob(canvas, file.type === 'image/png' ? 'image/png' : 'image/jpeg')
  if (blob.size > MAX_BYTES) blob = await toBlob(canvas, 'image/jpeg', 0.8)
  return { mediaType: blob.type as ImageMediaType, data: await toBase64(blob) }
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality = 0.9): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not encode image'))), type, quality),
  )
}

function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).slice(String(reader.result).indexOf(',') + 1))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}
