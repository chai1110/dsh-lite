// test/detect.test.ts — 端口探测四态 / URL 解析 / 空闲端口查找（注入式）
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { extractDshWebUrl, findFreePort, PORT_FALLBACK_ATTEMPTS, probeService } from '../src/process/detect';

/** 极简 Response 替身（probeService 只用 status/ok/text/redirect） */
function res(status: number, body: string) {
  return {
    status,
    ok: status >= 200 && status < 400,
    text: async () => body,
    headers: { get: () => null },
  } as unknown as Response;
}

describe('probeService 四态判定', () => {
  it('200 + __DSH_BOOT__ → dsh（免鉴权旧版）', async () => {
    const fetchImpl = (async () => res(200, '<html>window.__DSH_BOOT__={}</html>')) as typeof fetch;
    assert.equal(await probeService('127.0.0.1', 1, 1000, fetchImpl), 'dsh');
  });

  it('401 + 鉴权文案 → dsh-auth（新版）', async () => {
    const fetchImpl = (async () => res(401, 'dsh web authentication required; please open the URL')) as typeof fetch;
    assert.equal(await probeService('127.0.0.1', 1, 1000, fetchImpl), 'dsh-auth');
  });

  it('403 + 鉴权文案 → dsh-auth（403 预留策略）', async () => {
    const fetchImpl = (async () => res(403, 'dsh web authentication required')) as typeof fetch;
    assert.equal(await probeService('127.0.0.1', 1, 1000, fetchImpl), 'dsh-auth');
  });

  it('有响应但不是 DSH → foreign', async () => {
    const fetchImpl = (async () => res(200, '<title>nginx</title>')) as typeof fetch;
    assert.equal(await probeService('127.0.0.1', 1, 1000, fetchImpl), 'foreign');
  });

  it('401 但不是 DSH 文案 → foreign', async () => {
    const fetchImpl = (async () => res(401, 'Unauthorized')) as typeof fetch;
    assert.equal(await probeService('127.0.0.1', 1, 1000, fetchImpl), 'foreign');
  });

  it('连接失败 / 超时 → down', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;
    assert.equal(await probeService('127.0.0.1', 1, 1000, fetchImpl), 'down');
  });
});

describe('extractDshWebUrl', () => {
  it('从就绪行解析带令牌地址（只认第一条）', () => {
    const text =
      'some log\ndsh web: http://127.0.0.1:3082/?token=abc123 (LAN: http://10.0.0.2:3082/?token=abc123)\nmore';
    assert.equal(extractDshWebUrl(text), 'http://127.0.0.1:3082/?token=abc123');
  });

  it('无匹配 → null', () => {
    assert.equal(extractDshWebUrl('plain output'), null);
    assert.equal(extractDshWebUrl(''), null);
  });
});

describe('findFreePort', () => {
  it('从 startPort+1 起返回首个 down', async () => {
    const probe = async (_h: string, port: number): Promise<'down' | 'foreign'> =>
      port === 3083 ? 'down' : 'foreign';
    assert.equal(await findFreePort('127.0.0.1', 3082, PORT_FALLBACK_ATTEMPTS, probe), 3083);
  });

  it('全部被占 → null', async () => {
    const probe = async () => 'foreign' as const;
    assert.equal(await findFreePort('127.0.0.1', 3082, 3, probe), null);
  });

  it('越过 65535 停止', async () => {
    const probe = async () => 'down' as const;
    assert.equal(await findFreePort('127.0.0.1', 65535, PORT_FALLBACK_ATTEMPTS, probe), null);
  });
});
