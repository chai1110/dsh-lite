// test/manager.test.ts — 服务层状态机（假 probe + 假进程）
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ServiceManager } from '../src/process/manager';
import type { ChildProcessLike, ProcessRunner, StartOptions } from '../src/process/process';
import type { ProbeResult } from '../src/process/types';

/** 可控假子进程：测试通过 emit* 驱动 manager 的事件分支（结构上等价 ChildProcessLike，运行时无差异） */
class FakeChild {
  pid = 4242;
  stdoutCbs: ((c: Buffer) => void)[] = [];
  stderrCbs: ((c: Buffer) => void)[] = [];
  exitCbs: ((code: number | null) => void)[] = [];
  errorCbs: ((e: Error) => void)[] = [];
  killed = false;
  stdout = { on: (_e: 'data', cb: (c: Buffer) => void) => this.stdoutCbs.push(cb) };
  stderr = { on: (_e: 'data', cb: (c: Buffer) => void) => this.stderrCbs.push(cb) };
  on(event: 'exit' | 'error', cb: (...args: unknown[]) => void): void {
    if (event === 'exit') {
      this.exitCbs.push(() => cb(0));
    } else {
      this.errorCbs.push((e) => cb(e));
    }
  }
  kill(): boolean {
    this.killed = true;
    return true;
  }
  emitStdout(text: string): void {
    for (const cb of this.stdoutCbs) cb(Buffer.from(text));
  }
  emitExit(): void {
    for (const cb of this.exitCbs) cb(0);
  }
  emitError(err: Error): void {
    for (const cb of this.errorCbs) cb(err);
  }
}

/** 假进程 runner：记录 start 参数；stop 走立即 kill */
class FakeRunner implements ProcessRunner {
  startLog: StartOptions[] = [];
  lastChild: ChildProcessLike | null = null;
  lastStart: { command: string; args: string[] } | null = null;
  private cur: FakeChild | null = null;
  startDsh(opts: StartOptions): ChildProcessLike {
    this.startLog.push(opts);
    const c = new FakeChild();
    this.cur = c;
    this.lastChild = c as unknown as ChildProcessLike;
    return c as unknown as ChildProcessLike;
  }
  async stopChild(child: ChildProcessLike): Promise<void> {
    child.kill('SIGTERM');
  }
  /** 当前 spawn 出的假子进程（测试驱动用） */
  get lastFakeChild(): FakeChild {
    if (!this.cur) throw new Error('尚未 spawn');
    return this.cur;
  }
}

function makeDeps(probe: (port: number) => Promise<ProbeResult>) {
  const runner = new FakeRunner();
  const logs: string[] = [];
  const mgr = new ServiceManager(
    { host: '127.0.0.1', port: 3082, autoStart: true, pollMs: 20 },
    {
      probeService: (_h, port) => probe(port),
      processRunner: runner,
      log: (l) => logs.push(l),
      startTimeoutMs: 3000,
    },
  );
  return { runner, mgr, logs };
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

describe('ServiceManager', () => {
  it('down → 自起 → stdout 令牌 → ready', async () => {
    const { runner, mgr } = makeDeps(async () => 'down');
    const p = mgr.ensureRunning();
    await tick();
    const child = runner.lastFakeChild;
    assert.ok(child, '应已 spawn');
    child.emitStdout('dsh web: http://127.0.0.1:3082/?token=abc\n');
    const snap = await p;
    assert.equal(snap.state, 'ready');
    assert.equal(snap.authUrl, 'http://127.0.0.1:3082/?token=abc');
    assert.equal(snap.port, 3082);
    mgr.dispose();
  });

  it('端口被 dsh-auth 占用 → 回退空闲端口自起（不复用）', async () => {
    const { runner, mgr } = makeDeps(async (port) => (port === 3082 ? 'dsh-auth' : 'down'));
    const p = mgr.ensureRunning();
    await tick();
    const child = runner.lastFakeChild;
    assert.equal(runner.startLog[0].port, 3083, '应回退到 3083 自起');
    child.emitStdout('dsh web: http://127.0.0.1:3083/?token=def\n');
    const snap = await p;
    assert.equal(snap.state, 'ready');
    assert.equal(snap.port, 3083);
    mgr.dispose();
  });

  it('端口 foreign → 回退自起', async () => {
    const { runner, mgr } = makeDeps(async (port) => (port === 3082 ? 'foreign' : 'down'));
    const p = mgr.ensureRunning();
    await tick();
    const child = runner.lastFakeChild;
    assert.equal(runner.startLog[0].port, 3083);
    child.emitStdout('dsh web: http://127.0.0.1:3083/?token=xyz\n');
    assert.equal((await p).state, 'ready');
    mgr.dispose();
  });

  it('全部端口被占 → failed(portOccupied)', async () => {
    const { mgr } = makeDeps(async () => 'foreign');
    const snap = await mgr.ensureRunning();
    assert.equal(snap.state, 'failed');
    assert.equal(snap.errorCode, 'portOccupied');
    mgr.dispose();
  });

  it('autoStart=false 且端口空闲 → 不启动（failed/dshNotFound）', async () => {
    const runner = new FakeRunner();
    const mgr = new ServiceManager(
      { host: '127.0.0.1', port: 3082, autoStart: false, pollMs: 20 },
      {
        probeService: async () => 'down',
        processRunner: runner,
        log: () => {},
        startTimeoutMs: 500,
      },
    );
    const snap = await mgr.ensureRunning();
    assert.equal(snap.state, 'failed');
    mgr.dispose();
  });

  it('spawn 同步抛 ENOENT → failed(dshNotFound)', async () => {
    const runner = new FakeRunner();
    runner.startDsh = () => {
      throw Object.assign(new Error('not found'), { code: 'ENOENT' });
    };
    const mgr = new ServiceManager(
      { host: '127.0.0.1', port: 3082, autoStart: true, pollMs: 20 },
      {
        probeService: async () => 'down',
        processRunner: runner,
        log: () => {},
      },
    );
    const snap = await mgr.ensureRunning();
    assert.equal(snap.state, 'failed');
    assert.equal(snap.errorCode, 'dshNotFound');
    mgr.dispose();
  });

  it('启动期崩溃 → 换端口重启最多 3 轮 → startCrashed', async () => {
    const { runner, mgr } = makeDeps(async () => 'down');
    const p = mgr.ensureRunning();
    await tick();
    // 每轮 spawn 的子进程都在给令牌前退出
    for (let i = 0; i < 4; i++) {
      await tick(10);
      const child = runner.lastFakeChild;
      child.emitExit();
      await tick(10);
    }
    const snap = await p;
    assert.equal(snap.state, 'failed');
    assert.equal(snap.errorCode, 'startCrashed');
    mgr.dispose();
  });

  it('就绪后子进程退出 → idle（连接层据此判 offline）', async () => {
    const { runner, mgr } = makeDeps(async () => 'down');
    const p = mgr.ensureRunning();
    await tick();
    const child = runner.lastFakeChild;
    child.emitStdout('dsh web: http://127.0.0.1:3082/?token=abc\n');
    assert.equal((await p).state, 'ready');
    child.emitExit();
    await tick();
    assert.equal(mgr.getSnapshot().state, 'idle');
    mgr.dispose();
  });

  it('restart：先停再起，新端口令牌有效', async () => {
    const { runner, mgr } = makeDeps(async () => 'down');
    const p = mgr.ensureRunning();
    await tick();
    runner.lastFakeChild.emitStdout('dsh web: http://127.0.0.1:3082/?token=abc\n');
    assert.equal((await p).state, 'ready');
    const rp = mgr.restart();
    await tick();
    runner.lastFakeChild.emitStdout('dsh web: http://127.0.0.1:3082/?token=new\n');
    const snap = await rp;
    assert.equal(snap.state, 'ready');
    assert.equal(snap.authUrl, 'http://127.0.0.1:3082/?token=new');
    mgr.dispose();
  });
});
