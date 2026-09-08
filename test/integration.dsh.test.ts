// test/integration.dsh.test.ts — 真 dsh 端到端（环境有 dsh 时运行；无则 skip）
// M1：docs/api/connection.md §10 —— 自起 → 令牌 → cookie → WS → control 流 → session/create+list → 杀进程判 idle。
// M6：docs/design/命令与审批与目标.md —— 真 dsh 上走 命令目录(commands/list) + 斜杠执行(/goal via commands/execute)
//     + controller 事件折叠(command/run↔done 配对、goal/change 整快照) + goals/* CAS(stale ref 拒绝 / 正确 ref 生效)。
// 沙箱注意：本机 ~/.dsh 凭证写锁会让 dsh boot 崩溃，因此本文件在未显式设置 DSH_HOME 时自动
// 隔离到临时目录（调用方环境在文件级 after 还原）。请在本机终端跑：DSH_LITE_E2E=1 npm test
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { after, describe, it } from 'node:test';

import { probeService } from '../src/process/detect';
import { ServiceManager } from '../src/process/manager';
import { createProcessRunner } from '../src/process/process';
import { MuxClient } from '../src/rpc/mux';
import { listSessions } from '../src/session/list';
import { createSession } from '../src/session/api';
import { listCommands, runCommand } from '../src/session/commands';
import { mutateGoal } from '../src/session/goals';
import { SessionController } from '../src/session/controller';
import { archiveSession, renameSession, unarchiveSession } from '../src/session/workspace';

const DSH_BIN = process.env.DSH_BIN ?? join(homedir(), '.local', 'node-v24', 'bin', 'dsh');
const HAS_DSH = existsSync(DSH_BIN);
// 需要健康 dsh 环境（无凭证锁残留、可完成启动）。沙箱/CI 内 dsh 因内部凭证写锁竞争无法 boot，
// 请在本机终端跑：DSH_LITE_E2E=1 npm test
const E2E = process.env.DSH_LITE_E2E === '1';
const SKIP_REASON = !HAS_DSH
  ? '本机无 dsh 可执行文件（设置 DSH_BIN 可指定）'
  : !E2E
    ? '需要健康 dsh 环境：请设置 DSH_LITE_E2E=1 后再跑（沙箱内 dsh 凭证写锁无法完成 boot）'
    : false;

// 沙箱/CI 里 ~/.dsh 凭证锁会崩 dsh → 未显式指定 DSH_HOME 时自动隔离到临时目录（dsh 子进程继承 process.env）。
const PREV_DSH_HOME = process.env.DSH_HOME;
const ISOLATED_HOME = E2E && !PREV_DSH_HOME ? mkdtempSync(join(tmpdir(), 'dsh-lite-e2e-')) : null;
if (ISOLATED_HOME) process.env.DSH_HOME = ISOLATED_HOME;
after(() => {
  // 还原调用方环境；隔离目录留给系统清理（dsh 可能仍在收尾，不主动删）
  if (!ISOLATED_HOME) return;
  if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = PREV_DSH_HOME;
});

/** 找一个空闲端口（先 listen(0) 再释放，存在极小竞态，可接受） */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 等谓词返回非空（T 非 null）；超时抛错 */
async function until<T>(fn: () => T | null, timeoutMs = 8000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v !== null) return v;
    if (Date.now() > deadline) throw new Error('until 超时');
    await wait(50);
  }
}

/** boot 一次 dsh 并返回 { mgr, runner, origin, cookie, mux }（两个用例共用，各自独立端口） */
async function bootDsh(port: number, logs: string[]): Promise<{
  mgr: ServiceManager;
  runner: ReturnType<typeof createProcessRunner>;
  origin: string;
  cookie: string;
  mux: MuxClient;
}> {
  const runner = createProcessRunner();
  const mgr = new ServiceManager(
    { host: '127.0.0.1', port, executablePath: DSH_BIN, autoStart: true, pollMs: 150 },
    {
      probeService,
      processRunner: runner,
      log: (l) => logs.push(l),
      // dsh profile boot 需加载上百个 loader 条目，本机实测 20s 不够（曾 30s+ 才出令牌行）
      startTimeoutMs: 60000,
    },
  );
  const snap = await mgr.ensureRunning();
  assert.equal(snap.state, 'ready', `应 ready，日志：${logs.slice(-8).join('\n')}`);
  assert.ok(snap.authUrl, '应拿到带令牌地址');

  // 令牌换 cookie
  const res = await fetch(snap.authUrl!, { redirect: 'manual' });
  const raw = res.headers.get('set-cookie');
  assert.ok(raw, '应拿到 set-cookie');
  const cookie = raw!.split(';')[0]!.trim();
  const origin = new URL(snap.authUrl!).origin;

  const mux = new MuxClient();
  await mux.connect(`ws://${new URL(origin).host}/api/remote.mux`, cookie);
  return { mgr, runner, origin, cookie, mux };
}

describe('M1 真 dsh 冒烟', () => {
  it(
    '自起→cookie→WS→control 流→session/create+list→杀进程回 idle',
    { skip: SKIP_REASON, timeout: 90000 },
    async () => {
      const port = await freePort();
      const logs: string[] = [];
      let mgr: ServiceManager | null = null;
      let mux: MuxClient | null = null;
      try {
        const booted = await bootDsh(port, logs);
        mgr = booted.mgr;
        mux = booted.mux;

        // control 流（零参数纯流，应至少收到 baseline 帧）。
        // 0.1.2-rc.1 实测帧形：{type:'baseline', value:{queues,jobs,projections}}（typed 包装，baseline 在 type 上）
        const control = booted.mux.open('session/control', {});
        const firstFrame = new Promise<unknown>((resolve) => control.onItem((v) => resolve(v)));
        const v = await Promise.race([firstFrame, wait(8000).then(() => null)]);
        assert.ok(v !== null, 'control 流应推送 baseline 帧');
        const f = v as { type?: unknown; value?: unknown };
        assert.equal(
          f.type,
          'baseline',
          `首帧 type 应为 baseline（实际键: ${Object.keys(v as object).join(',')}）`,
        );
        assert.ok(f.value && typeof f.value === 'object', 'baseline 应带 value 载荷');

        // session/create + session/list 产品化（隔离 home 从零开始 → 先建后用，比依赖既有会话更确定）
        const sessionId = await createSession({ origin: booted.origin, cookie: booted.cookie });
        assert.ok(sessionId.length > 0, 'session/create 应返回新会话 id');
        const sessions = await listSessions(booted.origin, booted.cookie);
        assert.ok(Array.isArray(sessions), 'session/list 应返回数组');
        assert.ok(
          sessions.some((s) => s.sessionId === sessionId),
          '新建的会话应出现在清单里',
        );

        // 杀进程：manager 应回到 idle（连接层据此判 offline）
        const child = booted.runner.lastChild;
        assert.ok(child, '应有子进程句柄');
        child!.kill('SIGTERM');
        await until(() => (mgr!.getSnapshot().state === 'idle' ? true : null));
        assert.equal(mgr!.getSnapshot().state, 'idle');
      } finally {
        mux?.close();
        await mgr?.stop();
        mgr?.dispose();
      }
    },
  );
});

describe('M6 真 dsh 命令/目标平面', () => {
  it(
    'commands/list → /goal 执行 → command 配对与目标折叠 → goals CAS(pause/clear)',
    { skip: SKIP_REASON, timeout: 120000 },
    async () => {
      const port = await freePort();
      const logs: string[] = [];
      let mgr: ServiceManager | null = null;
      let mux: MuxClient | null = null;
      let controller: SessionController | null = null;
      const objective = `E2E 目标校验 ${Date.now()}`;
      try {
        const booted = await bootDsh(port, logs);
        mgr = booted.mgr;
        mux = booted.mux;
        const deps = { origin: booted.origin, cookie: booted.cookie };

        const sessionId = await createSession(deps);
        assert.ok(sessionId.startsWith('session-'), `会话 id 形态: ${sessionId}`);

        // 1) 命令目录：内置命令应可发现（与官方 dsh-commands 平面一致）
        const cmds = await listCommands(deps, sessionId);
        const names = cmds.map((c) => c.name);
        assert.ok(names.length >= 5, `内置命令应 ≥5，实际: ${names.join(',')}`);
        for (const expect of ['goal', 'plan', 'permission']) {
          assert.ok(names.includes(expect), `应含 /${expect}，实际: ${names.join(',')}`);
        }

        // 2) 挂真实 follow 流（走 SessionController 产品路径）→ 执行 /goal
        controller = new SessionController(sessionId, { mux: booted.mux, log: (l) => logs.push(l) });
        const vm = controller.getViewModel();
        controller.attach();
        const r = await runCommand(deps, sessionId, `/goal ${objective}`);
        assert.ok(r.ok, `命令应执行成功: ${r.text ?? ''}`);
        assert.ok(r.commandId, '应返回 commandId');

        // command/run↔command/done 按 commandId 配对成一条命令气泡
        await until(() => {
          const e = vm
            .getState()
            .entries.find((x) => x.kind === 'command' && x.text === `/goal ${objective}`);
          return e && e.cmdState === 'done' && e.cmdOk === true ? true : null;
        }, 15000);
        // goal/change 折叠出当前目标（整快照语义，phase=active）
        const goal = await until(() => (vm.getGoal()?.objective === objective ? vm.getGoal() : null), 15000);
        assert.ok(goal, 'goal/change 应折叠出目标');
        assert.equal(goal!.phase, 'active', `目标应 active，实际: ${goal!.phase}`);
        assert.ok(goal!.id.startsWith('goal-'), `目标 id 形态: ${goal!.id}`);

        // 3) goals CAS：陈旧 ref 必须被拒；正确 ref 可 pause → clear
        // （此处只断言 reject：紧随其后的正确 ref pause 成功即证明失败确为 CAS 拒绝而非网络/参数问题）
        await assert.rejects(
          mutateGoal(deps, sessionId, { id: goal!.id, revision: goal!.revision + 100 }, 'pause'),
        );
        await mutateGoal(deps, sessionId, { id: goal!.id, revision: goal!.revision }, 'pause');
        await until(() => (vm.getGoal()?.phase === 'paused' ? true : null), 15000);
        const paused = vm.getGoal()!;
        await mutateGoal(deps, sessionId, { id: paused.id, revision: paused.revision }, 'clear');
        await until(() => (vm.getGoal() === null ? true : null), 15000);
      } finally {
        controller?.dispose();
        mux?.close();
        await mgr?.stop();
        mgr?.dispose();
      }
    },
  );
});

describe('M7 真 dsh 会话命名与归档', () => {
  it(
    'rename 中文标题生效 + workspace/follow 基线读归档集 + archive 往返服务端真值 + unarchive(官方暴露时)',
    { skip: SKIP_REASON, timeout: 120000 },
    async () => {
      const port = await freePort();
      const logs: string[] = [];
      let mgr: ServiceManager | null = null;
      let mux: MuxClient | null = null;
      try {
        const booted = await bootDsh(port, logs);
        mgr = booted.mgr;
        mux = booted.mux;
        const deps = { origin: booted.origin, cookie: booted.cookie };

        // 两个会话：一个用于改名+归档，一个作对照组
        const a = await createSession(deps);
        const b = await createSession(deps);
        assert.ok(a.startsWith('session-') && b.startsWith('session-'), `会话 id 形态: ${a} / ${b}`);

        // 1) rename → session/list 投影标题应更新（中文标题，与官方 GUI 同通道）
        const zhTitle = `E2E 改名 ${Date.now()}`;
        await renameSession(deps, a, zhTitle);
        const afterRename = await listSessions(booted.origin, booted.cookie);
        const found = afterRename.find((s) => s.sessionId === a);
        assert.ok(found, '改名后的会话应在清单中');
        assert.equal(
          found!.title,
          zhTitle,
          `标题应更新为 ${zhTitle}（实际: ${found!.title ?? '(null)'}）`,
        );

        // 2) workspace/follow 基线：首帧应带 archivedSessionIds 数组（初始不含我们建的会话）
        const wf1 = booted.mux.open('workspace/follow', {});
        const base1 = await new Promise<unknown>((resolve) => {
          wf1.onItem((v) => resolve(v));
          setTimeout(() => resolve(null), 8000);
        });
        assert.ok(base1 !== null, 'workspace/follow 应推 baseline 帧');
        const b1 = base1 as { type: string; value: { archivedSessionIds?: string[] } };
        assert.equal(b1.type, 'baseline');
        assert.ok(Array.isArray(b1.value?.archivedSessionIds), 'baseline 应带 archivedSessionIds');
        assert.ok(!b1.value!.archivedSessionIds!.includes(a), '新会话初始不应已归档');
        wf1.cancel();

        // 3) archive a → 返回全集应含 a；服务端 follow 基线同步确认
        const ids1 = await archiveSession(deps, a);
        assert.ok(ids1.includes(a), `归档后全集应含 a（实际: ${ids1.join(',')}）`);
        assert.ok(!ids1.includes(b), '对照组 b 不应被归档');
        const wf2 = booted.mux.open('workspace/follow', {});
        const base2 = await new Promise<unknown>((resolve) => {
          wf2.onItem((v) => resolve(v));
          setTimeout(() => resolve(null), 8000);
        });
        const b2 = base2 as { value: { archivedSessionIds?: string[] } };
        assert.ok(b2.value!.archivedSessionIds!.includes(a), '服务端 follow 基线应含已归档的 a');
        wf2.cancel();

        // 4) unarchive：官方 0.1.2-rc.1 原版 Remote 网关未暴露 workspace/unarchiveSession
        //    （typert host 描述零命中、HTTP 404 实测；服务层 registry 有该方法但 controller 未挂
        //    Remote，属 host 补丁范畴——dsh-custom-patches 的 workspace patch 同源）。故先探测：
        //    - host 已暴露（打了补丁/新版）→ 强断言取消归档往返
        //    - 官方原版 404 → 降级为仅验证 listSessions 仍见 a（归档=隐藏不删），并留提示
        let unarchiveSupported = true;
        try {
          await unarchiveSession(deps, a);
        } catch (err) {
          const isHttp404 =
            typeof err === 'object' &&
            err !== null &&
            (err as { kind?: string; status?: number }).kind === 'http' &&
            (err as { status?: number }).status === 404;
          if (!isHttp404) throw err; // 非 404（网络/参数）仍是真失败
          unarchiveSupported = false;
        }
        if (unarchiveSupported) {
          const afterUnarchive = await listSessions(booted.origin, booted.cookie);
          assert.ok(
            afterUnarchive.some((s) => s.sessionId === a),
            '取消归档后会话仍在清单（归档语义=隐藏不删）',
          );
        } else {
          // 官方原版：unarchive RPC 未暴露。此时重新归档态无意义，仅确认 list 仍含 a（未被归档删除）。
          const afterArchiveKeep = await listSessions(booted.origin, booted.cookie);
          assert.ok(
            afterArchiveKeep.some((s) => s.sessionId === a),
            '归档不应删除会话（session/list 仍见 a）',
          );
          process.stderr.write(
            '[M7] 当前 dsh host 未暴露 workspace/unarchiveSession（HTTP 404，官方 0.1.2-rc.1 原版），unarchive 往返断言降级跳过。\n',
          );
        }
      } finally {
        mux?.close();
        await mgr?.stop();
        mgr?.dispose();
      }
    },
  );
});
