// src/log.ts — 输出通道轻封装。
//
// 约定：各模块继续接受 `{ log: (line: string) => void }` 形式的依赖注入（不耦合 vscode）。
// 这里只提供一个 `createLogger` 工厂 + `child(prefix)` 嵌套能力，方便给每个模块一个统一前缀。
// 例：const log = createLogger(output, '[panel]'); log('ready'); log.child('mux')('hello')
import type { OutputChannel } from 'vscode';

export interface Logger {
  (line: string): void;
  child(prefix: string): Logger;
}

/**
 * 基于 OutputChannel 构造一个带前缀的日志函数。
 * @param output VS Code 输出通道
 * @param prefix 顶层前缀（写入时拼在行首；子 logger 用 `/` 连接）
 */
export function createLogger(output: OutputChannel, prefix = ''): Logger {
  const write = (line: string): void => {
    output.appendLine(prefix ? `${prefix} ${line}` : line);
  };
  const child = (sub: string): Logger => createLogger(output, prefix ? `${prefix}/${sub}` : `[${sub}]`);
  return Object.assign(write, { child });
}
