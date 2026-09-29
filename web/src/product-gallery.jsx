import React, { useCallback, useEffect, useRef, useState } from 'react'
import api from './api'
import { prepareUploadFile } from './image-utils'
import { Button, Empty, ErrorBox } from './ui'

function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export default function ProductGallery({ productId, canEdit }) {
  const [images, setImages] = useState([])
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(null)
  const [preview, setPreview] = useState(null)
  const fileRef = useRef(null)

  const load = useCallback(() => {
    setError(null)
    api.productImages(productId).then(setImages).catch(setError)
  }, [productId])
  useEffect(() => { load() }, [load])

  async function onFilesSelected(e) {
    const files = Array.from(e.target.files || [])
    e.target.value = ''
    if (!files.length) return
    setBusy(true); setError(null); setUploadProgress(null)
    try {
      const prepared = []
      for (const file of files) prepared.push(await prepareUploadFile(file))
      // 慢水管（2Mbps）下 XHR 进度：一个 FormData 带整批，e.total 即整批字节。
      await api.uploadProductImages(productId, prepared, {
        onProgress: (loaded, total) => setUploadProgress(total ? Math.round((loaded / total) * 100) : 0),
      })
      await load()
    } catch (err) { setError(err) } finally { setBusy(false); setUploadProgress(null) }
  }

  async function remove(image) {
    if (!window.confirm(`删除图片「${image.filename || image.image_id}」？`)) return
    setError(null)
    try { await api.deleteProductImage(image.image_id); await load() } catch (err) { setError(err) }
  }

  async function move(image, dir) {
    const sorted = [...images].sort((a, b) => a.sort_order - b.sort_order || a.image_id - b.image_id)
    const index = sorted.findIndex(x => x.image_id === image.image_id)
    const target = index + dir
    if (index < 0 || target < 0 || target >= sorted.length) return
    // 原子重排：两次单独 PUT 中途失败会留下重复 sort_order 且无回滚
    const next = [...sorted]
    const a = next[index]; next[index] = next[target]; next[target] = a
    setError(null)
    try {
      await api.reorderProductImages(next[0].product_id, next.map(x => x.image_id))
      await load()
    } catch (err) { setError(err) }
  }

  const sorted = [...images].sort((a, b) => a.sort_order - b.sort_order || a.image_id - b.image_id)

  return <div className="product-gallery">
    <ErrorBox error={error} />
    <div className="gallery-toolbar">
      <input ref={fileRef} hidden type="file" multiple accept="image/*,.heic,.heif" onChange={onFilesSelected} />
      {canEdit && <Button type="button" className="secondary" onClick={() => fileRef.current?.click()} disabled={busy}>{busy && uploadProgress === null ? '压缩中…' : uploadProgress !== null ? `上传中 ${uploadProgress}%` : '＋ 上传图片'}</Button>}
      {uploadProgress !== null && <progress value={uploadProgress} max="100" aria-label="上传进度" />}
      <span className="muted">{images.length} 张</span>
    </div>
    {sorted.length ? <div className="gallery-grid">{sorted.map(image => <figure className="gallery-tile" key={image.image_id}>
      <img src={api.productImageContent(image.image_id, 'thumb')} alt={image.filename || `图片 ${image.image_id}`} loading="lazy" onClick={() => setPreview(image)} />
      <figcaption><span title={image.filename}>{image.filename || `图片 ${image.image_id}`}</span><small>{fmtSize(image.size)}</small></figcaption>
      {canEdit && <div className="gallery-actions">
        <button type="button" onClick={() => move(image, -1)} disabled={sorted[0].image_id === image.image_id} aria-label="前移">↑</button>
        <button type="button" onClick={() => move(image, 1)} disabled={sorted[sorted.length - 1].image_id === image.image_id} aria-label="后移">↓</button>
        <button type="button" className="danger-link" onClick={() => remove(image)}>删除</button>
      </div>}
    </figure>)}</div> : <Empty>暂无图片</Empty>}
    {preview && <div className="lightbox" role="dialog" aria-modal="true" onClick={() => setPreview(null)}>
      <img src={api.productImageContent(preview.image_id)} alt={preview.filename || ''} onClick={e => e.stopPropagation()} />
      <button type="button" className="close-button" onClick={() => setPreview(null)} aria-label="关闭预览">×</button>
    </div>}
  </div>
}
