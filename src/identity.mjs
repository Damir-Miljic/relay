import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {execute, executable, accountEnv} from './process.mjs';
import {CodexRPC} from './rpc.mjs';

export function normalizeIdentity(provider, info) {
  const email = typeof info.email === 'string' ? info.email.trim().toLowerCase() : '';
  if (!email) return null;
  const organization = provider === 'claude' ? String(info.orgId || '') : '';
  return {key: crypto.createHash('sha256').update(provider + '\0' + email + '\0' + organization).digest('hex'),
    label: email, source: 'profile', observedAt: Date.now()};
}
export async function readIdentity(provider, home) {
  if (provider === 'claude') {
    const env=accountEnv('claude',home);
    if(path.resolve(home)===path.join(os.homedir(),'.claude') && !process.env.CLAUDE_CONFIG_DIR)delete env.CLAUDE_CONFIG_DIR;
    const {stdout} = await execute(executable('claude'), ['auth', 'status', '--json'], {
      env, windowsHide: true, timeout: 10000, maxBuffer: 32768
    });
    const info = JSON.parse(stdout);
    return info.loggedIn && info.authMethod === 'claude.ai' ? normalizeIdentity('claude', info) : null;
  }
  const rpc = new CodexRPC(home);
  try {
    await rpc.initialize();
    const {account} = await rpc.request('account/read', {refreshToken: false});
    return account?.type === 'chatgpt' ? normalizeIdentity('codex', account) : null;
  } finally {await rpc.close();}
}
export class IdentityCache {
  constructor(read = readIdentity) {this.read = read; this.cache = new Map();}
  async get(provider, home) {
    const key = provider + '\0' + home;
    const previous = this.cache.get(key);
    if (previous && Date.now() - previous.at < 60000) return previous.value;
    try {
      const value = await this.read(provider, home);
      this.cache.set(key, {at: Date.now(), value}); return value;
    } catch {
      this.cache.set(key, {at: Date.now(), value: null}); return null;
    }
  }
}
