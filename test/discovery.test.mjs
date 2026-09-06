import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {classifyProcess, parseUnixProcesses, readClaudeRegistry, buildDiscovery, Discovery} from '../src/discovery.mjs';
import {dashboard, compactStatus} from '../src/display.mjs';

const start = 1788698744000;
const proc = (pid, more = {}) => ({pid, ppid: 1, provider: 'claude', mode: 'cli', startedAt: start, ...more});
const record = (pid, more = {}) => ({pid, sessionId: 'session-' + pid, name: 'Native ' + pid, cwd: '/work', startedAt: start + 100, status: 'busy', ...more});
const build = options => buildDiscovery({daemonPid: 100, platform: 'darwin', profiles: [], ...options});

test('native process recognition checks node script, not prompt text', () => {
  assert.equal(classifyProcess('claude.exe', 'claude.exe').provider, 'claude');
  assert.equal(classifyProcess('codex', '/usr/bin/codex app-server').mode, 'app-server');
  assert.equal(classifyProcess('node', 'node "/a/@anthropic-ai/claude-code/cli.js"').provider, 'claude');
  assert.equal(classifyProcess('node', 'node /a/@openai/codex/bin/codex.js').provider, 'codex');
  assert.equal(classifyProcess('node', 'node other.js "please run /a/@openai/codex/bin/codex.js"'), null);
  assert.equal(classifyProcess('bash', 'bash -c claude'), null);
});

test('Unix inventory parses current-user identity, parent and launch date', () => {
  const [p] = parseUnixProcesses('  501  120  1000 Sun Sep  6 14:45:44 2026 /Applications/Claude Code/claude\n');
  assert.equal(p.pid, 501); assert.equal(p.ppid, 120); assert.equal(p.uid, 1000);
  assert.equal(p.name, '/Applications/Claude Code/claude'); assert.ok(Number.isFinite(p.startedAt));
});

test('registry read allows session metadata only and ignores key files', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-discovery-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  fs.mkdirSync(path.join(root, 'sessions'));
  fs.writeFileSync(path.join(root, 'sessions', '501.json'), JSON.stringify({...record(501), messagingSocketPath: 'PRIVATE-SOCKET', bridgeSessionId: 'PRIVATE-BRIDGE', token: 'PRIVATE-TOKEN'}));
  fs.writeFileSync(path.join(root, 'sessions', '501.key'), 'PRIVATE-KEY');
  fs.writeFileSync(path.join(root, 'sessions', '502.json'), '{"pid":');
  fs.writeFileSync(path.join(root, 'sessions', '503.json'), JSON.stringify(record(999)));
  const rows = readClaudeRegistry(root);
  assert.equal(rows.length, 1); assert.equal(rows[0].pid, 501);
  assert.doesNotMatch(JSON.stringify(rows), /PRIVATE/);
});

test('external sessions need live matching PIDs and are not assigned a guessed account', () => {
  const result = build({processes: [proc(501), proc(502, {provider: 'codex'})], profiles: [{records: [record(501), record(502), record(503)]}]});
  assert.equal(result.externalSessions.length, 1);
  const s = result.externalSessions[0];
  assert.equal(s.pid, 501); assert.equal(s.status, 'busy');
  assert.equal(s.accountId, null); assert.equal(s.accountName, 'Native login (unmapped)');
  assert.equal(s.managed, false); assert.equal(s.canRoute, false);
  assert.equal(result.externalProcesses[0].provider, 'codex');
});

test('stale metadata cannot attach to a reused PID', () => {
  const result = build({processes: [proc(501)], profiles: [{records: [record(501, {startedAt: start - 100000})]}]});
  assert.equal(result.externalSessions.length, 0);
  assert.equal(result.externalProcesses.length, 1);
  const win = buildDiscovery({daemonPid: 100, platform: 'win32', processes: [proc(501)], profiles: [{records: [record(501, {procStart: String((BigInt(start - 60000) + 11644473600000n) * 10000n)})]}]});
  assert.equal(win.externalSessions.length, 0);
});

test('Relay children, helpers and npm launchers are not duplicate native sessions', () => {
  const processes = [
    {pid: 100, ppid: 1}, {pid: 200, ppid: 100},
    proc(501, {ppid: 200}), proc(502, {mode: 'helper'}),
    proc(503), proc(504, {ppid: 503}), proc(505, {mode: 'utility'})
  ];
  const result = build({processes, profiles: [{records: [record(501), record(504)]}]});
  assert.deepEqual(result.externalSessions.map(s => s.pid), [504]);
  assert.equal(result.externalProcesses.length, 0);
});

test('a verified Relay profile maps its native session to the named account', () => {
  const result = build({processes: [proc(501)], profiles: [{accountId: 'work-id', accountName: 'Work', records: [record(501)]}]});
  assert.equal(result.externalSessions[0].accountId, 'work-id');
  assert.equal(result.externalSessions[0].accountName, 'Work');
});

test('Codex app-server is a process, not an invented session', () => {
  const result = build({processes: [proc(501, {provider: 'codex', mode: 'app-server'})]});
  assert.equal(result.externalSessions.length, 0);
  assert.equal(result.externalProcesses.length, 1);
  assert.match(result.externalProcesses[0].detail, /multiple sessions/);
});

test('discovery refresh removes closed sessions and failures clear stale results', async () => {
  let now = start, calls = 0, processes = [proc(501)], broken = false;
  const store = {state: {accounts: [], sessions: []}};
  const d = new Discovery(store, {codex:async()=>[],identity:{get:async()=>null},now: () => now, daemonPid: 100, platform: 'darwin',
    inventory: async () => {calls++; if (broken) throw new Error('failure'); return processes;},
    registry: () => [record(501)]});
  assert.equal((await d.snapshot()).externalSessions.length, 1);
  await d.snapshot(); assert.equal(calls, 1);
  processes = []; now += 6000;
  assert.equal((await d.snapshot()).externalSessions.length, 0);
  broken = true; now += 6000;
  const failed = await d.snapshot();
  assert.equal(failed.externalSessions.length, 0); assert.match(failed.discovery.error, /unavailable/);
});

test('dashboard and compact panel display external sessions as view only', () => {
  const detected = build({processes: [proc(501)], profiles: [{records: [record(501)]}]});
  const state = {settings: {staleSeconds: 180}, accounts: [], sessions: [], ...detected};
  assert.match(dashboard(state), /Native 501/);
  assert.match(dashboard(state), /External - view only/);
  assert.match(dashboard(state), /\/work/);
  assert.match(compactStatus(state), /Native 501.*external/);
});
