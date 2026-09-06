import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn, execFile} from 'node:child_process';
import {promisify} from 'node:util';
export const execute = promisify(execFile);
export function executable(provider) {
  const configured = process.env['RELAY_'+provider.toUpperCase()+'_BIN'];
  if (configured) {
    if (!path.isAbsolute(configured) || !fs.existsSync(configured)) throw new Error('CLI override must be an existing absolute path.');
    return configured;
  }
  const names = process.platform === 'win32' ? [provider+'.exe'] : [provider];
  const dirs = (process.env.PATH || process.env.Path || '').split(path.delimiter);
  const home = os.homedir();
  dirs.push(path.join(home,'.local','bin'),'/opt/homebrew/bin','/usr/local/bin');
  if (process.platform === 'win32') {
    dirs.push(path.join(process.env.LOCALAPPDATA || '', 'Programs','OpenAI','Codex','bin'));
    if (provider === 'claude') dirs.push(path.join(process.env.APPDATA || '', 'npm','node_modules','@anthropic-ai','claude-code','bin'));
  }
  for (const dir of dirs) for (const name of names) {
    const candidate = path.join(dir, name);
    if(fs.existsSync(path.join(dir,'.relay-shims')))continue;
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  throw Object.assign(new Error(provider+' CLI not found. Install the native CLI or set RELAY_'+provider.toUpperCase()+'_BIN to its executable.'),{code:'RELAY_CLI_NOT_FOUND'});
}
export function accountEnv(provider, home, inherited = process.env, platform = process.platform) {
  const env = {...inherited};
  for (const key of Object.keys(env)) {
    if (/^(ANTHROPIC_|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CODE_USE_|CLAUDE_CODE_SESSION|CLAUDE_CONFIG_DIR|CLAUDE_SECURESTORAGE_CONFIG_DIR$|CLAUDECODE$|CODEX_HOME$|CODEX_THREAD_ID$|OPENAI_API_KEY$|OPENAI_BASE_URL$|CODEX_API_KEY$)/.test(key)) delete env[key];
  }
  if (provider === 'claude') {
    env.CLAUDE_CONFIG_DIR = home;
    if (platform === 'darwin') {
      // Explicitly naming ~/.claude selects a different Mac Keychain entry.
      // Pin the credential store independently of SDK configuration overrides.
      const isDefault = path.resolve(home) === path.join(os.homedir(), '.claude');
      if (isDefault) delete env.CLAUDE_CONFIG_DIR;
      env.CLAUDE_SECURESTORAGE_CONFIG_DIR = isDefault ? '' : home;
    }
    env.CLAUDE_CODE_PROJECT_DIR_NAME = 'relay';
    env.CLAUDE_CODE_RESUME_INTERRUPTED_TURN = '0';
  } else env.CODEX_HOME = home;
  return env;
}
export function nativeLogin(provider, home) {
  const args = provider === 'claude' ? ['auth','login'] : ['login'];
  const child = spawn(executable(provider), args, {env:accountEnv(provider,home), stdio:'inherit', shell:false});
  return new Promise((resolve,reject)=>{child.once('error',reject); child.once('exit',code=>code===0?resolve():reject(new Error('Login did not complete.')));});
}
