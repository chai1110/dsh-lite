// scripts/build.mjs — DSH Lite 的 esbuild 构建脚本（双 bundle）
//
// 用法：
//   node scripts/build.mjs            构建 out/extension.js + out/webview.js
//   node scripts/build.mjs --watch    上面两个 bundle 都进入 watch
//   node scripts/build.mjs --test     两个 bundle + 把 test/**/*.test.ts 编到 out/test/
//
// 两个入口的配置**完全独立**（宿主是 node/cjs，UI 是 browser/iife），
// 不共享 platform/format，避免把 node 内建模块打进 webview。
import { build, context } from 'esbuild';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const TAG = '[build]';
const watch = process.argv.includes('--watch');
const withTest = process.argv.includes('--test');

const log = (msg) => console.log(`${TAG} ${msg}`);

/** 宿主侧：VS Code 扩展入口。vscode 模块由宿主注入，必须 external。 */
const extensionConfig = {
  entryPoints: ['src/extension.ts'],
  outfile: 'out/extension.js',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  // vscode 由宿主注入；bufferutil/utf-8-validate 是 ws 的可选原生加速，缺失时 ws 内部 try-catch 兜底
  external: ['vscode', 'bufferutil', 'utf-8-validate'],
  sourcemap: true,
  logLevel: 'warning',
};

/** UI 侧：React 打进单文件 iife，供 webview 用 <script> 引入。 */
const webviewConfig = {
  entryPoints: ['webview/index.tsx'],
  outfile: 'out/webview.js',
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2020',
  jsx: 'automatic',
  // webview 里没有 process，React 开发版会读 process.env.NODE_ENV，必须在编译期替换掉。
  define: { 'process.env.NODE_ENV': '"production"' },
  // index.tsx 里 import './styles.css' 会被抽成同名 out/webview.css。
  loader: { '.css': 'css' },
  sourcemap: true,
  logLevel: 'warning',
};

/** 测试：node --test 直接跑 CJS 产物；测试文件缺失时返回 null 而不是报错。 */
function makeTestConfig() {
  if (!existsSync('test')) {
    log('未发现 test/ 目录，跳过测试构建');
    return null;
  }
  const entryPoints = readdirSync('test', { recursive: true })
    .filter((f) => typeof f === 'string' && f.endsWith('.test.ts'))
    .map((f) => join('test', f));
  if (entryPoints.length === 0) {
    log('test/ 下没有 *.test.ts，跳过测试构建');
    return null;
  }
  return {
    entryPoints,
    outdir: 'out/test',
    outbase: 'test',
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    external: ['vscode', 'bufferutil', 'utf-8-validate'],
    sourcemap: true,
    logLevel: 'warning',
  };
}

function collectConfigs() {
  const configs = [
    { name: 'extension', options: extensionConfig },
    { name: 'webview', options: webviewConfig },
  ];
  if (withTest) {
    const tests = makeTestConfig();
    if (tests) configs.push({ name: 'test', options: tests });
  }
  // 入口文件可能由并行开发的另一部分尚未提交，缺失时明确报错而不是让 esbuild 抛路径错。
  return configs.filter(({ name, options }) => {
    const missing = (options.entryPoints ?? []).filter((p) => !existsSync(p));
    if (missing.length > 0) {
      log(`跳过 ${name}：入口不存在 → ${missing.join(', ')}`);
      return false;
    }
    return true;
  });
}

async function main() {
  const configs = collectConfigs();
  if (configs.length === 0) {
    log('没有可构建的入口，终止');
    process.exit(1);
  }

  // 清空 out/：避免已删除的源文件留下旧产物（尤其 node --test 会收集到失效测试）。
  rmSync('out', { recursive: true, force: true });

  if (watch) {
    for (const { name, options } of configs) {
      const ctx = await context(options);
      await ctx.watch();
      log(`watch 已启动：${name}`);
    }
    log('watch 模式运行中，按 Ctrl+C 退出');
    return;
  }

  const started = Date.now();
  await Promise.all(configs.map(({ options }) => build(options)));
  log(`构建完成（${configs.map((c) => c.name).join(' + ')}），耗时 ${Date.now() - started}ms`);
}

main().catch((err) => {
  console.error(`${TAG} 构建失败：${err?.message ?? err}`);
  process.exit(1);
});
