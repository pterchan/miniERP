import '@testing-library/jest-dom/vitest'

// 与生产网关挂载路径对齐：让 withBasePath/Link 在测试里按 /erp/ 求值，
// 防止基路径漂移只在网关部署下暴露（AGENTS.md 基路径契约）。
// vitest 既不注入 config.base 到 import.meta.env.BASE_URL，define 也会被内置值覆盖，
// 因此在 setup（先于被测模块加载）里直接赋值。
import.meta.env.BASE_URL = '/erp/'

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
