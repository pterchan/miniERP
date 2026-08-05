// 图片上传预处理：HEIC/HEIF → JPEG，超限时 canvas 压缩，返回 File（multipart 用）。

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = reject
    image.src = url
  })
}

function canvasToBlob(canvas, quality) {
  return new Promise((resolve, reject) => canvas.toBlob(x => x ? resolve(x) : reject(new Error('图片压缩失败')), 'image/jpeg', quality))
}

function blobToFile(blob, name, type) {
  return new File([blob], name, { type: type || blob.type || 'image/jpeg' })
}

function replaceExt(name, ext) {
  const i = name.lastIndexOf('.')
  return i > 0 ? name.slice(0, i) + '.' + ext : name + '.' + ext
}

// 超限图片：解码后按最大边 4096 / 像素上限逐级压缩到 maxBytes 以内。
async function ensureWithin(blob, maxBytes, name, type) {
  if (blob.size <= maxBytes) return blob instanceof File ? blob : blobToFile(blob, name, type)
  const url = URL.createObjectURL(blob)
  try {
    const image = await loadImage(url)
    const maxEdge = 4096
    const maxPixels = 32_000_000
    let scale = Math.min(1, maxEdge / image.width, maxEdge / image.height, Math.sqrt(maxPixels / (image.width * image.height)))
    if (!isFinite(scale)) scale = 1
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(64, Math.round(image.width * scale))
    canvas.height = Math.max(64, Math.round(image.height * scale))
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
    let quality = 0.86
    let out = await canvasToBlob(canvas, quality)
    while (out.size > maxBytes && quality > 0.55) { quality -= 0.08; out = await canvasToBlob(canvas, quality) }
    while (out.size > maxBytes && canvas.width > 1200) {
      canvas.width = Math.round(canvas.width * 0.8)
      canvas.height = Math.round(canvas.height * 0.8)
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
      out = await canvasToBlob(canvas, quality)
    }
    return blobToFile(out, replaceExt(name, 'jpg'), 'image/jpeg')
  } finally {
    URL.revokeObjectURL(url)
  }
}

/**
 * 把待上传文件预处理为适合 multipart 上传的 File：
 * - HEIC/HEIF 先转 JPEG（heic2any）；
 * - jpeg/png/webp 且未超限则原样返回；
 * - 其余/超限走 canvas 重压缩到 maxBytes（默认 20MB）以内。
 */
export async function prepareUploadFile(file, { maxBytes = 20 * 1024 * 1024 } = {}) {
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
  if (source.type && /^image\/(jpeg|png|webp)$/i.test(source.type) && source.size <= maxBytes) {
    return source instanceof File ? source : blobToFile(source, name, type)
  }
  return ensureWithin(source, maxBytes, name, type)
}
