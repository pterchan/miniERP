import { beforeEach, describe, expect, it, vi } from 'vitest'
import { prepareUploadFile } from './image-utils'

// 动态 import('heic2any') 在测试中解析到 mock；canvas 压缩路径依赖浏览器，
// 这里只覆盖无需 canvas 的分支（原样保留 / HEIC 转换）。
const mockConvert = vi.fn()

vi.mock('heic2any', () => ({
  default: (...args) => mockConvert(...args),
}))

describe('prepareUploadFile', () => {
  beforeEach(() => {
    mockConvert.mockReset()
    mockConvert.mockImplementation(async () => new Blob(['jpeg'], { type: 'image/jpeg' }))
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
})
