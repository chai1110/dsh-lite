// src/panel/html.ts — webview HTML 生成（iframe 架构：官方页面经 Lite 本地代理加载）。
//
// 三个页面：loading（连接中，带重试）/ error（失败，带重试）/ ready（全幅 iframe 官方页面）。
// CSP 只放行代理来源的 frame 与带 nonce 的内联脚本；样式内联，无外部资源。
export type PageCtx = {
  nonce: string;
  /** iframe 地址（Lite 本地代理；仅 ready 态有值） */
  frameSrc: string | null;
};

const BASE_CSS = `
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 0; width: 100vw; height: 100vh; overflow: hidden;
    background: var(--vscode-editor-background, #1e1e1e);
    color: var(--vscode-editor-foreground, #cccccc);
    font-family: var(--vscode-font-family, -apple-system, "Segoe UI", sans-serif);
    display: flex; align-items: center; justify-content: center;
  }
  .frame {
    position: fixed; inset: 0; width: 100vw; height: 100vh; border: none;
    background: var(--vscode-editor-background, #1e1e1e);
  }
  .center { text-align: center; max-width: 460px; padding: 24px; }
  .spinner {
    width: 28px; height: 28px; margin: 0 auto 14px;
    border: 3px solid rgba(128, 128, 128, 0.3);
    border-top-color: var(--vscode-focusBorder, #0078d4);
    border-radius: 50%;
    animation: lite-spin 0.9s linear infinite;
  }
  @keyframes lite-spin { to { transform: rotate(360deg); } }
  .title { font-size: 14px; font-weight: 600; margin: 0 0 10px; }
  .hint { font-size: 12px; opacity: 0.75; margin: 6px 0 16px; line-height: 1.7; }
  .err { color: var(--vscode-errorForeground, #f48771); word-break: break-all; }
  button.btn {
    background: var(--vscode-button-background, #0e639c);
    color: var(--vscode-button-foreground, #ffffff);
    border: none; border-radius: 2px; padding: 6px 14px;
    font: inherit; font-size: 12px; cursor: pointer;
  }
  button.btn:hover { background: var(--vscode-button-hoverBackground, #1177bb); }
`;

function shell(ctx: PageCtx, title: string, body: string, iframe = false): string {
  const frameTag = iframe
    ? `<iframe class="frame" src="${ctx.frameSrc ?? ''}" allow="clipboard-write"></iframe>`
    : '';
  const script = iframe
    ? ''
    : `<script nonce="${ctx.nonce}">
  const vs = acquireVsCodeApi();
  document.querySelectorAll('button[data-action]').forEach(function (b) {
    b.addEventListener('click', function () { vs.postMessage({ type: b.dataset.action }); });
  });
</script>`;
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${ctx.frameSrc ?? 'none'}; style-src 'unsafe-inline'; script-src 'nonce-${ctx.nonce}';" />
<title>${title}</title>
<style>${BASE_CSS}</style>
</head>
<body>
${frameTag}
${frameTag ? '' : body}
${script}
</body>
</html>`;
}

export function loadingPage(ctx: PageCtx, title: string, hint: string): string {
  return shell(
    ctx,
    title,
    `<div class="spinner"></div><p class="title">${title}</p><p class="hint">${hint}</p>
     <button class="btn" type="button" data-action="ui/refresh">重试</button>`,
  );
}

export function errorPage(ctx: PageCtx, title: string, detail: string): string {
  return shell(
    ctx,
    title,
    `<p class="title">${title}</p><p class="hint err">${detail}</p>
     <button class="btn" type="button" data-action="ui/refresh">重试</button>`,
  );
}

export function readyPage(ctx: PageCtx): string {
  return shell(ctx, 'DSH Lite', '', true);
}
