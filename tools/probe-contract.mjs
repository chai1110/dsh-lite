// tools/probe-contract.mjs — 对运行中的 dsh 实例做「参数契约」活体探测
// 原理：typert 网关对 args 的**字段名校验先于业务查找**，
//       故用伪造 id 探测即可判定「参数形状是否被接受」，零副作用。
// 判据：error.code === 'gateway/arguments-invalid' → 契约不匹配；其余（业务错误/lookup 失败）→ 形状被接受。
const origin = process.env.DSH_ORIGIN || 'http://127.0.0.1:3082';
const token = process.env.DSH_TOKEN;
if (!token) { console.error('need DSH_TOKEN'); process.exit(2); }

const BOGUS = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
const uuid = () => crypto.randomUUID();

// 1) 用 token 换 cookie（跟随重定向）
const authRes = await fetch(`${origin}/?token=${token}`, { redirect: 'manual' });
const raw = authRes.headers.getSetCookie ? authRes.headers.getSetCookie() : [authRes.headers.get('set-cookie') || ''];
const cookie = raw.filter(Boolean).map((c) => c.split(';')[0]).join('; ');
if (!cookie) { console.error('no cookie, status=', authRes.status); process.exit(2); }

async function probe(label, method, args) {
  const body = { type: 'client-request', rpcId: uuid(), method, payload: { args } };
  let res;
  try {
    res = await fetch(`${origin}/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify(body),
    });
  } catch (e) {
    console.log(`  ${label.padEnd(34)} HTTP-ERR ${String(e)}`);
    return;
  }
  const txt = await res.text();
  let j;
  try { j = JSON.parse(txt); } catch { console.log(`  ${label.padEnd(34)} HTTP ${res.status} non-json: ${txt.slice(0, 120)}`); return; }
  const r = j.result;
  if (!r) { console.log(`  ${label.padEnd(34)} HTTP ${res.status} no-result: ${txt.slice(0, 140)}`); return; }
  if (r.ok) {
    console.log(`  ${label.padEnd(34)} ✅ ok            value=${JSON.stringify(r.value)?.slice(0, 60)}`);
  } else {
    const bad = r.error.code === 'gateway/arguments-invalid';
    console.log(`  ${label.padEnd(34)} ${bad ? '❌ ARGS-MISMATCH' : '➖ accepted'}  ${r.error.code}: ${String(r.error.message).slice(0, 110)}`);
  }
}

console.log('### lite 当前发出的参数形状（逐方法对照）\n');
await probe('session/create',      'session/create',      { request: { cwd: '/__probe_zzz_nonexistent__' } });
await probe('session/list(_request)', 'session/list',     { _request: {} });
await probe('session/rename',      'session/rename',      { request: { sessionId: BOGUS, title: 'probe' } });
await probe('session/cancel',      'session/cancel',      { request: { sessionId: BOGUS } });
await probe('session/prompt',      'session/prompt',      { request: { sessionId: BOGUS, requestId: uuid(), mode: 'queue', content: [{ type: 'text', text: 'probe' }] } });
await probe('commands/list',       'commands/list',       { agentId: BOGUS });

console.log('\n### commands/execute —— 旧字段 vs 新字段（决定性对照）\n');
await probe('execute{images:[]}  (旧)',              'commands/execute', { agentId: BOGUS, line: '/__zzz__', images: [] });
await probe('execute{submittedAttachments:[]} (新)', 'commands/execute', { agentId: BOGUS, line: '/__zzz__', submittedAttachments: [] });

console.log('\n### goals / workspace 平面\n');
await probe('goals/pause',            'goals/pause',            { agentId: BOGUS, ref: { id: 'x', revision: 1 } });
await probe('goals/resume',           'goals/resume',           { agentId: BOGUS, ref: { id: 'x', revision: 1 } });
await probe('goals/clear',            'goals/clear',            { agentId: BOGUS, ref: { id: 'x', revision: 1 } });
await probe('workspace/archiveSession',   'workspace/archiveSession',   { request: { sessionId: BOGUS } });
await probe('workspace/unarchiveSession', 'workspace/unarchiveSession', { request: { sessionId: BOGUS } });
