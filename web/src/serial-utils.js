const EXTRACTION_STATUSES = new Set(['ok', 'partial', 'reshoot_required'])
const FIELD_STATUSES = new Set(['confirmed', 'candidate', 'ambiguous'])
export const OCR_SERIAL_CONFIDENCE_THRESHOLD = 0.75

// 保持单个 SN 为字符串，折叠空白后再放进一行，保留大小写和前导零。
function serialText(value) {
  return typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : ''
}

// 前端拦截常见的全半角、空白和大小写重复；最终身份校验仍由后台负责。
export function normalizeSerialKey(value) {
  return serialText(value).normalize('NFKC').toLowerCase()
}

/** OCR 只产生可确认的 SN 候选，不能把批号转换成 SN。 */
export function prepareSerialOcrCandidates(result) {
  if (!result || !EXTRACTION_STATUSES.has(result.status)) {
    throw new Error('OCR 返回的识别状态无效，请重试或手工填写序列号')
  }
  const warning = Array.isArray(result.warnings)
    ? result.warnings.filter(x => typeof x === 'string' && x.trim()).join('；')
    : ''
  if (result.status === 'reshoot_required') {
    return { candidates: [], message: warning || '图片不够清晰，请重新拍摄后识别序列号' }
  }
  const rawCandidates = result.fields?.serial_number
  if (rawCandidates !== undefined && !Array.isArray(rawCandidates)) {
    throw new Error('OCR 返回的序列号候选无效，请重试或手工填写')
  }
  const byKey = new Map()
  for (const item of rawCandidates || []) {
    const value = serialText(item?.value_raw)
    if (!value || !FIELD_STATUSES.has(item?.status) ||
      typeof item.confidence !== 'number' || !Number.isFinite(item.confidence) ||
      item.confidence < 0 || item.confidence > 1) {
      throw new Error('OCR 返回的序列号候选无效，请重试或手工填写')
    }
    const key = normalizeSerialKey(value)
    const reasons = []
    if (result.status === 'partial') reasons.push('图片需复核')
    if (item.status === 'candidate') reasons.push('候选值需复核')
    if (item.status === 'ambiguous') reasons.push('存在多个可能值，请逐项核对')
    if (item.confidence < OCR_SERIAL_CONFIDENCE_THRESHOLD) reasons.push('置信度偏低')
    const selected = result.status === 'ok' && item.status === 'confirmed' &&
      item.confidence >= OCR_SERIAL_CONFIDENCE_THRESHOLD
    const existing = byKey.get(key)
    if (existing) {
      // 重复读数中只要有一项需复核，合并后的候选也不能默认勾选。
      existing.selected = existing.selected && selected
      existing.confidence = Math.min(existing.confidence, item.confidence)
      existing.reasons = [...new Set([...existing.reasons, ...reasons])]
    } else {
      byKey.set(key, { key, value, confidence: item.confidence, selected, reasons })
    }
  }
  const candidates = [...byKey.values()]
  const message = candidates.length
    ? `识别到 ${candidates.length} 个 SN 候选，请核对后确认添加`
    : Array.isArray(result.fields?.lot_number) && result.fields.lot_number.length
      ? '仅识别到批号，不能作为序列号，请重拍或手工填写'
      : '未识别到序列号，请重拍或手工填写'
  return { candidates, message: warning ? `${warning}；${message}` : message }
}

/** 仅追加未出现过的 SN，保留现有文本和新候选的首次显示形式。 */
export function appendSerialCandidates(currentValue, incoming) {
  const current = typeof currentValue === 'string' ? currentValue : ''
  const seen = new Set(current.split(/[\r\n]+/u).map(normalizeSerialKey).filter(Boolean))
  const added = []
  let duplicates = 0
  for (const raw of incoming || []) {
    const value = serialText(raw)
    const key = normalizeSerialKey(value)
    if (!key) continue
    if (seen.has(key)) { duplicates += 1; continue }
    seen.add(key)
    added.push(value)
  }
  const separator = current && !/[\r\n]$/u.test(current) ? '\n' : ''
  return {
    text: added.length ? `${current}${separator}${added.join('\n')}` : current,
    added: added.length,
    duplicates,
  }
}
