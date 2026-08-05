import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ScanStateHeading } from './scan-ui'

describe('ScanStateHeading', () => {
  it('makes partial OCR explicitly confirmable', () => {
    render(<ScanStateHeading state="partial" />)
    expect(screen.getByText('请确认识别结果')).toBeInTheDocument()
  })
})
