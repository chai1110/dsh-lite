// src/process/process.ts — dsh web 子进程封装（跨平台，纯模块）
// 移植自 0.5.1 src/service/process.ts；语义与注释保持，删去本仓库不需要的暴露面。
import { spawn, type SpawnOptions } from 'node:child_process';
import { existsSync } from 'node:fs';
import { win32 as win32Path } from 'node:path';

export interface ChildProcessLike {
  pid?: number;
  stdout?: { on(event: 'data', cb: (chunk: Buffer) => void): void };
  stderr?: { on(event: 'data', cb: (chunk: Buffer) => void): void };
  on(event: 'exit', cb: (code: number | null) => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
  kill(signal?: NodeJS.Signals): boolean;
}
export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcessLike;

export interface StartOptions {
  host: string;
  port: number;
  /** 子进程工作目录（兜底：让 dsh web 以 VS Code 工作区为 cwd；缺省不指定） */
  cwd?: string;
  /** dsh 可执行文件绝对路径（非空时优先于平台默认命令名 dsh.cmd / dsh） */
  executablePath?: string;
}

/** 运行环境注入（便于单测；生产默认取真实值） */
export interface RunnerEnv {
  execPath?: string;
  path?: string;
  electronVersion?: string;
}

/** 校验可传给 spawn 的工作目录：仅接受存在且非 UNC 网络路径的绝对路径（Windows EINVAL 防坑） */
export function sanitizeCwd(
  cwd: string | undefined,
  platform: string,
  existsImpl: (p: string) => boolean = existsSync,
): string | undefined {
  if (cwd === undefined) return undefined;
  if (platform !== 'win32') {
    return existsImpl(cwd) ? cwd : undefined;
  }
  if (!win32Path.isAbsolute(cwd)) return undefined;
  if (cwd.startsWith('\\\\')) return undefined; // UNC：\\server\share
  return existsImpl(cwd) ? cwd : undefined;
}

/** 在 PATH 目录里查找固定文件名（Windows 查找语义的简化版，分隔符恒为 ';'） */
export function findInPath(
  target: string,
  envPath: string | undefined,
  existsImpl: (p: string) => boolean = existsSync,
): string | null {
  if (envPath === undefined) return null;
  for (const dir of envPath.split(';')) {
    if (dir === '') continue;
    const candidate = win32Path.join(dir, target);
    if (existsImpl(candidate)) return candidate;
  }
  return null;
}

/** 由 dsh.cmd shim 路径推导真实入口 bin.js */
export function binJsFromShim(dshCmdPath: string): string {
  return win32Path.join(
    win32Path.dirname(dshCmdPath),
    'node_modules',
    '@deepseek-ai',
    'dsh',
    'lib',
    'bin.js',
  );
}

/**
 * 解析 Windows 下执行 bin.js 所用的 node.exe。
 * 背景：VS Code 扩展宿主是 Electron，process.execPath 指向 Code.exe，绝不能当 node 用
 * （dsh 的 loader/HMR 依赖系统 Node 内部特性，Electron 运行时里会崩）。
 * 顺序：shim 旁 node.exe → PATH 里 node.exe → 非 Electron 时 execPath 兜底 → 抛 NODE_NOT_FOUND。
 */
export function resolveWindowsNodeExecutable(
  shimPath: string,
  env: RunnerEnv,
  existsImpl: (p: string) => boolean = existsSync,
): string {
  const isElectron =
    (typeof env.electronVersion === 'string' && env.electronVersion !== '') ||
    (typeof (process.versions as { electron?: string }).electron === 'string' &&
      (process.versions as { electron?: string }).electron !== '') ||
    /^code(\.exe)?$/i.test(win32Path.basename(env.execPath ?? process.execPath ?? ''));
  const pathEnv = env.path ?? process.env.PATH ?? '';

  if (win32Path.isAbsolute(shimPath)) {
    const besideShim = win32Path.join(win32Path.dirname(shimPath), 'node.exe');
    if (existsImpl(besideShim)) return besideShim;
  }
  const inPath = findInPath('node.exe', pathEnv, existsImpl);
  if (inPath) return inPath;
  const execPath = env.execPath ?? process.execPath;
  if (!isElectron && execPath) return execPath;
  throw Object.assign(new Error(`node.exe not found in PATH (dsh shim at ${shimPath})`), {
    code: 'NODE_NOT_FOUND',
  });
}

export interface ProcessRunner {
  /** 启动 dsh web 子进程（命令名按平台选择）；返回值由事件驱动消费 */
  startDsh(opts: StartOptions): ChildProcessLike;
  /** 优雅停止：先 SIGTERM，宽限期后 SIGKILL */
  stopChild(child: ChildProcessLike): Promise<void>;
  lastChild: ChildProcessLike | null;
  lastStart?: { command: string; args: string[] } | null;
}

export function createProcessRunner(
  spawnImpl: SpawnFn = spawn as unknown as SpawnFn,
  platform: string = process.platform,
  graceMs = 3000,
  existsImpl: (p: string) => boolean = existsSync,
  env: RunnerEnv = { execPath: process.execPath, path: process.env.PATH ?? '' },
): ProcessRunner {
  let lastChild: ChildProcessLike | null = null;
  let lastStart: { command: string; args: string[] } | null = null;

  return {
    startDsh({ host, port, cwd, executablePath }) {
      // 统一命令形态：dsh web --host <host> --port <port> --no-open
      const webArgs = ['web', '--host', host, '--port', String(port), '--no-open'];
      const sanitizedCwd = sanitizeCwd(cwd, platform, existsImpl);
      const spawnOptions: SpawnOptions = {
        detached: platform !== 'win32',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(sanitizedCwd === undefined ? {} : { cwd: sanitizedCwd }),
      };

      let child: ChildProcessLike;
      let command: string;
      let spawnArgs: string[];
      if (platform === 'win32') {
        // Windows：.cmd 是批处理 shim，Node v24 直接 spawn 同步抛 EINVAL → node 直跑 bin.js
        const pathEnv = env.path ?? process.env.PATH ?? '';
        let shimPath: string | null;
        if (executablePath && executablePath.length > 0) {
          shimPath = executablePath;
        } else {
          shimPath = findInPath('dsh.cmd', pathEnv, existsImpl);
          if (shimPath === null) {
            throw Object.assign(new Error('dsh.cmd not found in PATH'), { code: 'ENOENT' });
          }
        }
        const argsPrefix = shimPath.endsWith('.js') ? [shimPath] : [binJsFromShim(shimPath)];
        const nodeExecutable = resolveWindowsNodeExecutable(shimPath, env, existsImpl);
        command = nodeExecutable;
        spawnArgs = [...argsPrefix, ...webArgs];
        child = spawnImpl(command, spawnArgs, spawnOptions);
      } else {
        command = executablePath && executablePath.length > 0 ? executablePath : 'dsh';
        spawnArgs = webArgs;
        child = spawnImpl(command, spawnArgs, spawnOptions);
      }
      lastChild = child;
      lastStart = { command, args: spawnArgs };
      return child;
    },

    async stopChild(child) {
      if (child.pid === undefined) return;
      child.kill('SIGTERM');
      await new Promise((resolve) => setTimeout(resolve, graceMs));
      child.kill('SIGKILL');
    },

    get lastChild() {
      return lastChild;
    },
    get lastStart() {
      return lastStart;
    },
  };
}
