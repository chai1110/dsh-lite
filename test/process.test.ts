// test/process.test.ts — spawn 参数组装（POSIX/Windows）、cwd 容错、node 解析（注入式）
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { binJsFromShim, createProcessRunner, resolveWindowsNodeExecutable, sanitizeCwd } from '../src/process/process';
import type { ChildProcessLike, SpawnFn } from '../src/process/process';

/** 记录 spawn 调用并返回哑子进程 */
function captureSpawn(records: { command: string; args: string[]; options?: unknown }[]): SpawnFn {
  return (command, args, options) => {
    records.push({ command, args, options });
    return { pid: 1, on: () => {}, kill: () => true, stdout: { on: () => {} }, stderr: { on: () => {} } } as ChildProcessLike;
  };
}

describe('createProcessRunner POSIX', () => {
  it('spawn dsh web --host --port --no-open', () => {
    const records: { command: string; args: string[]; options: unknown }[] = [];
    const runner = createProcessRunner(captureSpawn(records), 'darwin');
    runner.startDsh({ host: '127.0.0.1', port: 3082 });
    assert.equal(records[0].command, 'dsh');
    assert.deepEqual(records[0].args, ['web', '--host', '127.0.0.1', '--port', '3082', '--no-open']);
    assert.equal(runner.lastStart?.command, 'dsh');
  });

  it('executablePath 优先', () => {
    const records: { command: string; args: string[]; options: unknown }[] = [];
    const runner = createProcessRunner(captureSpawn(records), 'linux');
    runner.startDsh({ host: '127.0.0.1', port: 1, executablePath: '/opt/dsh' });
    assert.equal(records[0].command, '/opt/dsh');
  });

  it('POSIX 用 detached + windowsHide', () => {
    const records: { command: string; args: string[]; options: { detached?: boolean; windowsHide?: boolean } }[] = [];
    const runner = createProcessRunner(captureSpawn(records), 'darwin');
    runner.startDsh({ host: '127.0.0.1', port: 3082 });
    assert.equal(records[0].options.detached, true);
    assert.equal(records[0].options.windowsHide, true);
  });
});

describe('createProcessRunner Windows', () => {
  const winPath = 'C:\\Program Files\\nodejs;C:\\node';
  // existsImpl：node.exe 在 Program Files\nodejs；dsh.cmd 在 C:\node
  const existsImpl = (p: string) => p === 'C:\\Program Files\\nodejs\\node.exe' || p === 'C:\\node\\dsh.cmd';
  const env = { execPath: 'C:\\Users\\u\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe', path: winPath };

  it('用 node 直跑 bin.js（Electron 不用 Code.exe）', () => {
    const records: { command: string; args: string[] }[] = [];
    const runner = createProcessRunner(captureSpawn(records), 'win32', 100, existsImpl, env);
    runner.startDsh({ host: '127.0.0.1', port: 3082 });
    assert.equal(records[0].command, 'C:\\Program Files\\nodejs\\node.exe');
    assert.deepEqual(records[0].args, [
      'C:\\node\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js',
      'web',
      '--host',
      '127.0.0.1',
      '--port',
      '3082',
      '--no-open',
    ]);
  });

  it('找不到 dsh.cmd → ENOENT', () => {
    const runner = createProcessRunner(captureSpawn([]), 'win32', 100, () => false, env);
    assert.throws(
      () => runner.startDsh({ host: '127.0.0.1', port: 3082 }),
      (e: NodeJS.ErrnoException) => e.code === 'ENOENT',
    );
  });
});

describe('sanitizeCwd', () => {
  const exists = (p: string) => p === '/ok';
  it('不存在 → undefined', () => {
    assert.equal(sanitizeCwd('/nope', 'darwin', exists), undefined);
  });
  it('存在 → 保留', () => {
    assert.equal(sanitizeCwd('/ok', 'darwin', exists), '/ok');
  });
  it('Windows UNC → undefined', () => {
    assert.equal(sanitizeCwd('\\\\server\\share', 'win32', exists), undefined);
  });
  it('Windows 相对路径 → undefined', () => {
    assert.equal(sanitizeCwd('rel\\dir', 'win32', exists), undefined);
  });
});

describe('binJsFromShim / resolveWindowsNodeExecutable', () => {
  it('bin.js 推导', () => {
    const p = binJsFromShim('C:\\node\\dsh.cmd');
    assert.equal(p, 'C:\\node\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js');
  });

  it('Electron：PATH 里的 node.exe 优先', () => {
    const existsImpl = (p: string) => p === 'C:\\node\\node.exe';
    const got = resolveWindowsNodeExecutable('C:\\node\\dsh.cmd', { path: 'C:\\node', execPath: '...\\Code.exe' }, existsImpl);
    assert.equal(got, 'C:\\node\\node.exe');
  });

  it('非 Electron：execPath 兜底可用', () => {
    const got = resolveWindowsNodeExecutable('C:\\node\\dsh.cmd', { path: '', execPath: '/usr/bin/node' }, () => false);
    assert.equal(got, '/usr/bin/node');
  });

  it('全失败 → NODE_NOT_FOUND', () => {
    assert.throws(
      () =>
        resolveWindowsNodeExecutable(
          'C:\\node\\dsh.cmd',
          { path: '', execPath: 'C:\\VS Code\\Code.exe' },
          () => false,
        ),
      (e: NodeJS.ErrnoException) => e.code === 'NODE_NOT_FOUND',
    );
  });
});
