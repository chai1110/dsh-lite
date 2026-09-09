// webview/lib/codicon.tsx — codicon 图标组件。
//
// 字体由宿主在 src/panel/html.ts 注入 assets/codicons/codicon.css；缺失时类名仍合法，
// 浏览器会按未知类忽略（UI 自动降级为无图标，功能不依赖图标）。
import type { ReactElement } from 'react';

export function Icon({ n, spin }: { n: string; spin?: boolean }): ReactElement {
  return <span className={`codicon codicon-${n}${spin ? ' is-spin' : ''}`} aria-hidden="true" />;
}
