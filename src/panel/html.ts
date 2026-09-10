// src/panel/html.ts — webview HTML 生成。
//
// 负责把 out/ 的 bundle/css 与 assets/codicons 注入到 webview，并按 `full` 模式注入整页阅读列样式。
// 唯一会读 out 磁盘文件的地方（构建后用 existsSync 优雅降级）。
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';

import * as vscode from 'vscode';

/**
 * 给一个 webview 生成完整 HTML 字符串。
 * - full=false：侧栏模式（窄列）
 * - full=true：整页编辑区标签模式（max-width 1160 居中阅读列 + 编辑器底色 + 细分隔）
 */
export function getHtml(
  webview: vscode.Webview,
  outUri: vscode.Uri,
  assetsUri: vscode.Uri,
  full: boolean,
): string {
  const nonce = randomBytes(16).toString('hex');
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(outUri, 'webview.js'));

  const cssUri = vscode.Uri.joinPath(outUri, 'webview.css');
  const cssLink = existsSync(cssUri.fsPath)
    ? `<link rel="stylesheet" href="${webview.asWebviewUri(cssUri)}" />`
    : '';

  // M9：codicon 图标字体（assets/codicons/ 已在仓库内，缺失时优雅降级为纯文本 UI）
  const codiconUri = vscode.Uri.joinPath(assetsUri, 'codicons', 'codicon.css');
  const codiconLink = existsSync(codiconUri.fsPath)
    ? `<link rel="stylesheet" href="${webview.asWebviewUri(codiconUri)}" />`
    : '';

  // M9b：品牌 logo（assets/icon.svg）以全局变量下发，供顶栏显示；缺失时为空串（UI 不显示 logo）
  const logoUri = vscode.Uri.joinPath(assetsUri, 'icon.svg');
  const logoUrl = existsSync(logoUri.fsPath) ? webview.asWebviewUri(logoUri).toString() : '';

  const csp = [
    "default-src 'none'",
    `script-src ${webview.cspSource} 'nonce-${nonce}'`,
    // 不给 'unsafe-inline'：所有 <style> 都带 nonce，内联 style 属性已改为 class（见 styles.css）
    `style-src ${webview.cspSource} 'nonce-${nonce}'`,
    `font-src ${webview.cspSource}`, // M9：codicon 图标字体
    `img-src ${webview.cspSource} data:`,
  ].join('; ');

  // M13：整页模式把内容约束为居中阅读列（避免全宽拉伸），背景切编辑器底色，左右加细分隔
  // 注意：<style> 必须带 nonce，否则会被上面收紧后的 CSP 拦截
  const fullCss = full
    ? `<style nonce="${nonce}">
      body.dsh-full {
        background-color: var(--vscode-editor-background, var(--vscode-sideBar-background));
      }
      body.dsh-full .app {
        max-width: 1160px;
        width: 100%;
        margin: 0 auto;
        border-left: 1px solid var(--vscode-panel-border, transparent);
        border-right: 1px solid var(--vscode-panel-border, transparent);
      }
    </style>`
    : '';

  return `<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>DSH Lite</title>
    ${codiconLink}
    ${cssLink}
    <style nonce="${nonce}">
      html,
      body {
        height: 100%;
      }
      body {
        margin: 0;
        padding: 0;
        background-color: var(--vscode-sideBar-background, var(--vscode-editor-background));
        color: var(--vscode-foreground);
        font-family: var(--vscode-font-family);
        font-size: var(--vscode-font-size);
      }
      #root {
        display: flex;
        flex-direction: column;
        height: 100%;
      }
    </style>
    ${fullCss}
  </head>
  <body${full ? ' class="dsh-full"' : ''}>
    <div id="root"></div>
    <script nonce="${nonce}">window.DSH_LOGO=${JSON.stringify(logoUrl)};</script>
    <script nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
}
