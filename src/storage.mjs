import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export function dataRoot(env = process.env, platform = process.platform) {
  if (env.RELAY_HOME) return path.resolve(env.RELAY_HOME);
  const installation=env===process.env?readJson(path.join(os.homedir(),'.relay','integration.json'),null):null;
  if(installation?.root)return installation.root;
  if (platform === 'win32') return path.join(env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Relay');
  if (platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Relay');
  return path.join(env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'relay');
}
export function privateDir(dir) { fs.mkdirSync(dir, {recursive:true, mode:0o700}); }
export function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw new Error('Cannot read ' + path.basename(file) + ': ' + e.message); }
}
export function writeJson(file, value) {
  privateDir(path.dirname(file));
  const tmp = file + '.' + crypto.randomUUID() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', {mode:0o600, flag:'wx'});
  fs.renameSync(tmp, file);
}
export function validName(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 60 || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Use a name of 1–60 printable characters.');
  return value.trim();
}
export function threshold(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1 || n > 100) throw new Error('Threshold must be 1–100 percent remaining.');
  return n;
}
export class Store {
  constructor(root = dataRoot()) {
    this.root = root; privateDir(root);
    this.file = path.join(root, 'state.json');
    this.state = readJson(this.file, {version:1, accounts:[], sessions:[], settings:{crossProviderAuto:false,threshold:10, pollSeconds:60, staleSeconds:180, cooldownSeconds:60}});
    this.state.settings.crossProviderAuto ??= false;
    if (this.state.version !== 1) throw new Error('Unsupported Relay state version.');
  }
  save() { writeJson(this.file, this.state); }
  home(account) { return account.nativeHome || path.join(this.root, 'accounts', account.id); }
  account(ref, provider) {
    const matches = this.state.accounts.filter(a => (!provider || a.provider === provider) && (a.id === ref || a.name.toLowerCase() === String(ref).toLowerCase()));
    if (matches.length !== 1) throw new Error(matches.length ? 'Account name is ambiguous; use its ID.' : 'Account not found: ' + ref);
    return matches[0];
  }
  session(ref) {
    const matches = this.state.sessions.filter(s => s.id === ref || s.name.toLowerCase() === String(ref).toLowerCase());
    if (matches.length !== 1) throw new Error('Session not found or ambiguous: ' + ref);
    return matches[0];
  }
  add(provider, name) {
    if (!['claude','codex'].includes(provider)) throw new Error('Provider must be claude or codex.');
    name = validName(name);
    if (this.state.accounts.some(a => a.name.toLowerCase() === name.toLowerCase())) throw new Error('That account name is already in use.');
    const account = {id:crypto.randomUUID(), provider, name, enabled:true, auth:'login required', usage:{windows:[]}, createdAt:Date.now()};
    privateDir(this.home(account));
    if (provider === 'codex') fs.writeFileSync(path.join(this.home(account), 'config.toml'), 'cli_auth_credentials_store = "file"\n', {mode:0o600});
    if (provider === 'claude') fs.writeFileSync(path.join(this.home(account), 'settings.json'), '{"forceLoginMethod":"claudeai"}\n', {mode:0o600});
    this.state.accounts.push(account); this.save(); return account;
  }
  rename(ref, name) {
    const a = this.account(ref); name = validName(name);
    if (this.state.accounts.some(x => x.id !== a.id && x.name.toLowerCase() === name.toLowerCase())) throw new Error('That name is already in use.');
    a.name = name; this.save(); return a;
  }
}
export function safeText(value) {
  return String(value ?? '').replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g,'').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').replace(/[\x00-\x08\x0b-\x1f\x7f]/g,'');
}
