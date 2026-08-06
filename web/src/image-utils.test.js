import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { canEncodeWebP, prepareUploadFile, setWebPOverrideForTest } from './image-utils'

// 动态 import('heic2any') 在测试中解析到 mock；canvas 重编码路径依赖浏览器，
// 新用例通过 stub 全局 Image/canvas/URL 让压缩分支在 jsdom 下可测。
const mockConvert = vi.fn()

vi.mock('heic2any', () => ({
  default: (...args) => mockConvert(...args),
}))

class FakeCtx { fillRect() {} drawImage() {} }
class FakeCanvas {
  constructor() { this.width = 0; this.height = 0; this.ctx = new FakeCtx() }
  getContext() { return this.ctx }
  toBlob(cb, mime) { cb(new Blob([`enc-${mime}`], { type: mime })) }
}

let originalCreateElement = null
function stubCanvasPipeline() {
  vi.stubGlobal('Image', class {
    set src(_v) { queueMicrotask(() => this.onload?.()) }
    get width() { return 3000 }
    get height() { return 2000 }
  })
  vi.stubGlobal('URL', { createObjectURL: () => 'blob:test', revokeObjectURL: () => {} })
  originalCreateElement = document.createElement.bind(document)
  document.createElement = (tag, opts) => (tag === 'canvas' ? new FakeCanvas() : originalCreateElement(tag, opts))
}

describe('prepareUploadFile', () => {
  beforeEach(() => {
    mockConvert.mockReset()
    mockConvert.mockImplementation(async () => new Blob(['jpeg'], { type: 'image/jpeg' }))
  })
  afterEach(() => {
    setWebPOverrideForTest(null)
    vi.unstubAllGlobals()
    if (originalCreateElement) { document.createElement = originalCreateElement; originalCreateElement = null }
  })

  it('passes an under-limit jpeg through unchanged', async () => {
    const file = new File(['x'], 'photo.jpg', { type: 'image/jpeg' })
    const out = await prepareUploadFile(file)
    expect(out).toBe(file)
  })

  it('passes an under-limit png through unchanged', async () => {
    const file = new File(['x'], 'photo.png', { type: 'image/png' })
    const out = await prepareUploadFile(file)
    expect(out).toBe(file)
  })

  it('converts HEIC to a jpg File with a matching name', async () => {
    const file = new File(['x'], 'IMG_1.heic', { type: 'image/heic' })
    const out = await prepareUploadFile(file)
    expect(mockConvert).toHaveBeenCalled()
    expect(out).toBeInstanceOf(File)
    expect(out.name).toBe('IMG_1.jpg')
    expect(out.type).toBe('image/jpeg')
  })

  it('honours a custom maxBytes cap', async () => {
    const file = new File(['x'], 'photo.jpeg', { type: 'image/jpeg' })
    const out = await prepareUploadFile(file, { maxBytes: 1 })
    // 1 字节文件仍 ≤1 字节，原样返回；cap 不影响小文件
    expect(out).toBe(file)
  })

  it('re-encodes an over-limit jpeg to WebP when WebP encode is available', async () => {
    stubCanvasPipeline()
    setWebPOverrideForTest(true)
    const file = new File([new Uint8Array(600_000)], 'photo.jpg', { type: 'image/jpeg' })
    const out = await prepareUploadFile(file)
    expect(out).toBeInstanceOf(File)
    expect(out).not.toBe(file)
    expect(out.type).toBe('image/webp')
    expect(out.name).toBe('photo.webp')
    expect(out.size).toBeLessThan(400 * 1024)
  })

  it('falls back to JPEG when WebP encode is unavailable', async () => {
    stubCanvasPipeline()
    setWebPOverrideForTest(false)
    const file = new File([new Uint8Array(600_000)], 'photo.jpg', { type: 'image/jpeg' })
    const out = await prepareUploadFile(file)
    expect(out.type).toBe('image/jpeg')
    expect(out.name).toBe('photo.jpg')
    expect(out).not.toBe(file)
  })

  it('keeps the original under-limit file when canvas is unavailable', async () => {
    const file = new File(['x'], 'photo.png', { type: 'image/png' })
    const out = await prepareUploadFile(file)
    expect(out).toBe(file)
  })
})

describe('canEncodeWebP', () => {
  afterEach(() => setWebPOverrideForTest(null))

  it('returns false in jsdom by default (no real canvas encoder)', () => {
    expect(canEncodeWebP()).toBe(false)
  })

  it('honours the test override', () => {
    setWebPOverrideForTest(true)
    expect(canEncodeWebP()).toBe(true)
    setWebPOverrideForTest(false)
    expect(canEncodeWebP()).toBe(false)
  })
})
