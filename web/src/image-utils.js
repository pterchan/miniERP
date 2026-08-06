// 图片上传预处理：HEIC/HEIF → JPEG，超限时 canvas 重编码到目标体积/分辨率。
// 端侧是 2Mbps 小水管下的第一道限流：>maxBytes 的图在上传前压到 ≤maxBytes。

export const UPLOAD_IMAGE_MAX_EDGE = 1280
export const UPLOAD_IMAGE_MAX_PIXELS = 3_000_000
export const UPLOAD_IMAGE_MAX_BYTES = 400 * 1024
export const OCR_IMAGE_MAX_EDGE = 2048
export const OCR_IMAGE_MAX_PIXELS = 4_000_000
export const OCR_IMAGE_MAX_BYTES = 1_500_000

const _QUALITY_START = 0.85
const _QUALITY_MIN = 0.55
const _DOWNSCALE_FLOOR = 640

// WebP 编码能力检测（带测试注入缝隙；jsdom / 旧浏览器下不抛错、回退 false）。
let _webpOverride = null
export function canEncodeWebP() {
  if (_webpOverride !== null) return _webpOverride
  try {
    if (typeof HTMLCanvasElement === 'undefined') return false
    return document.createElement('canvas').toDataURL('image/webp').startsWith('data:image/webp')
  } catch { return false }
}
export function setWebPOverrideForTest(value) { _webpOverride = value }

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = reject
    image.src = url
  })
}

function canvasToBlob(canvas, mime, quality) {
  return new Promise((resolve, reject) => canvas.toBlob(x => x ? resolve(x) : reject(new Error('图片压缩失败')), mime, quality))
}

function blobToFile(blob, name, type) {
  return new File([blob], name, { type: type || blob.type || 'image/jpeg' })
}

export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1])
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}

function replaceExt(name, ext) {
  const i = name.lastIndexOf('.')
  return i > 0 ? name.slice(0, i) + '.' + ext : name + '.' + ext
}

// 重编码：按 maxEdge/maxPixels 缩放 + 质量阶梯 + 下采样阶梯，保证 ≤maxBytes。
// 调用方只在确实需要重编码时调用（透传决策在 prepareUploadFile / prepareImage 内）。
export async function compressImage(blob, { maxEdge, maxPixels, maxBytes, mime, name }) {
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
    throw new Error('canvas 不可用')
  }
  const url = URL.createObjectURL(blob)
  try {
    const image = await loadImage(url)
    const format = mime === 'image/webp' && canEncodeWebP() ? 'image/webp' : 'image/jpeg'
    let scale = Math.min(1, maxEdge / image.width, maxEdge / image.height, Math.sqrt(maxPixels / (image.width * image.height)))
    if (!isFinite(scale)) scale = 1
    let cw = Math.max(64, Math.round(image.width * scale))
    let ch = Math.max(64, Math.round(image.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = cw; canvas.height = ch
    const ctx = canvas.getContext('2d')
    const draw = () => {
      ctx.fillStyle = '#fff'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
    }
    draw()
    let quality = _QUALITY_START
    let out = await canvasToBlob(canvas, format, quality)
    while (out.size > maxBytes && quality > _QUALITY_MIN) { quality -= 0.08; out = await canvasToBlob(canvas, format, quality) }
    while (out.size > maxBytes && cw > _DOWNSCALE_FLOOR) {
      cw = Math.round(cw * 0.8); ch = Math.round(ch * 0.8)
      canvas.width = cw; canvas.height = ch
      draw()
      out = await canvasToBlob(canvas, format, quality)
    }
    const ext = format === 'image/webp' ? 'webp' : 'jpg'
    return blobToFile(out, replaceExt(name, ext), format)
  } finally {
    URL.revokeObjectURL(url)
  }
}

/**
 * 把待上传文件预处理为适合 multipart 上传的 File：
 * - HEIC/HEIF 先转 JPEG（heic2any）；
 * - ≤maxBytes 的图片原样返回（不解码、无质量损失）；
 * - 超限走 compressImage 重编码到 ≤maxBytes（WebP，不支持则 JPEG）。
 * 解码失败一律回退原文件，交由服务端 _reencode_to_cap 兜底。
 */
export async function prepareUploadFile(file, { maxBytes = UPLOAD_IMAGE_MAX_BYTES, maxEdge = UPLOAD_IMAGE_MAX_EDGE, maxPixels = UPLOAD_IMAGE_MAX_PIXELS } = {}) {
  let source = file
  let name = file.name
  let type = file.type
  if (/heic|heif/i.test(file.type) || /\.(heic|heif)$/i.test(file.name)) {
    const mod = await import('heic2any')
    const convert = mod.default || mod
    source = await convert({ blob: file, toType: 'image/jpeg', quality: 0.86 })
    if (Array.isArray(source)) source = source[0]
    name = replaceExt(file.name, 'jpg')
    type = 'image/jpeg'
  }
  if (!(source.type && /^image\/(jpeg|png|webp|gif)$/i.test(source.type))) {
    return source instanceof File ? source : blobToFile(source, name, type)
  }
  if (source.size <= maxBytes) {
    return source instanceof File ? source : blobToFile(source, name, type)
  }
  try {
    return await compressImage(source, {
      maxEdge, maxPixels, maxBytes,
      mime: canEncodeWebP() ? 'image/webp' : 'image/jpeg',
      name,
    })
  } catch {
    return source instanceof File ? source : blobToFile(source, name, type)
  }
}

/**
 * 把图片预处理为 OCR 抽取入参（{ media_type, image_base64 }，始终 JPEG）：
 * HEIC/HEIF 先转 JPEG；已是 JPEG 且 ≤OCR_IMAGE_MAX_BYTES 原样透传，否则重编码。
 */
export async function prepareImage(file) {
  let source = file
  if (/heic|heif/i.test(file.type) || /\.(heic|heif)$/i.test(file.name)) {
    const mod = await import('heic2any')
    const convert = mod.default || mod
    source = await convert({ blob: file, toType: 'image/jpeg', quality: 0.86 })
    if (Array.isArray(source)) source = source[0]
  }
  const sourceType = source.type || file.type
  // 已是 JPEG 且 ≤1.5MB → 原样透传（OCR 始终 JPEG，避免无损小图被重编码引入质量损失）。
  if (/^image\/jpeg$/i.test(sourceType) && source.size <= OCR_IMAGE_MAX_BYTES) {
    return { media_type: 'image/jpeg', image_base64: await blobToBase64(source) }
  }
  const blob = await compressImage(source, {
    maxEdge: OCR_IMAGE_MAX_EDGE, maxPixels: OCR_IMAGE_MAX_PIXELS,
    maxBytes: OCR_IMAGE_MAX_BYTES, mime: 'image/jpeg', name: file.name,
  })
  return { media_type: 'image/jpeg', image_base64: await blobToBase64(blob) }
}
