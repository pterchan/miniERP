import '@testing-library/jest-dom/vitest'

// jsdom 未实现 matchMedia；应用内 useIsMobile 在真实浏览器始终可用。
if (typeof window !== 'undefined' && !window.matchMedia) {
  window.matchMedia = query => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })
}
