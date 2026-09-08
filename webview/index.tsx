// webview/index.tsx — DSH Lite 自研 webview 的入口。
//
// 与 0.5.1「iframe 整站」不同，这里是 React 单页，通过 postMessage 与宿主 RPC 直连。
// 构建：scripts/build.mjs 把本文件打成 iife 单文件 out/webview.js，
// 并由 esbuild 把 ./styles.css 抽成 out/webview.css（provider 在产物存在时才引用它）。
import { createRoot } from 'react-dom/client';

import { App } from './app';
import './styles.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('DSH Lite webview: 找不到 #root 挂载点');
}

const root = createRoot(container);
root.render(<App />);
