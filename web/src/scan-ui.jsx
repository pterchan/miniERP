import React from 'react'

export function ScanStateHeading({ state }) {
  const title = state === 'reshoot' ? '请重新拍摄' : state === 'error' ? '扫描失败' : state === 'partial' ? '请确认识别结果' : '识别结果'
  return <strong>{title}</strong>
}
