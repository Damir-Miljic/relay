# Troubleshooting

[← Back to README](../README.md)

Start with `relay doctor`. It checks the installation and opens a short, provider-free terminal test.

## A session is missing or says “View only”

Control applies to interactive `claude` and `codex` commands launched through Relay’s installed shell integration.

1. Run the [installer](installation.md) if you have not already.
2. Open a new terminal. Existing shells may still use their previous configuration.
3. Start the native client normally, from your project folder.
4. Press **F** in Relay.

A session that was running before installation needs to be exited and resumed through the integrated command. Save or finish its work first.

Dedicated desktop apps and IDE chat panels remain view-only. VS Code’s **terminal** supports integration. Absolute executable paths, PowerShell `-NoProfile`, and `RELAY_BYPASS=1` can bypass it. Utility commands, noninteractive launches, remote/cloud modes, and explicit ephemeral sessions are not enrolled.

## A switch is queued even though the prompt looks idle

Read the explanation beneath the session. Background shells, working agents, pending permissions, unfinished tools, or an unsubmitted draft can still be active while the main prompt looks idle.

- Finish or clear the draft, or respond to a pending native prompt.
- Let background work finish or stop it deliberately in the native client.
- Press **C Cancel switch** if you want to cancel a queued manual switch.

Claude needs a safe boundary because it closes and resumes during an account change. Codex account changes can preserve its background terminals, but changing **providers** must wait for them to finish. Relay does not force-kill work to meet a threshold.

If the panel says a terminal needs a restart, finish its work, exit, and resume it through the normal integrated command.

## Usage is unknown, unavailable, or stale

Press **U**, select the account, and read the detailed error.

A provider may fail to return limits, a login may have expired, or the current authentication method may not expose subscription usage. Press **L** to sign that named account in again when the error indicates an authentication problem. Use **F** to retry a refresh.

Unknown usage is not zero usage, and Relay does not invent a remaining allowance. An expired reading is marked stale.

### Claude usage unavailable on macOS

Older Relay builds looked in the wrong Keychain scope for the default Claude account. Updating fixes the scope selection; restarting the same old build does not.

Follow the [full update steps](installation.md#update), including closing controlled terminals and restarting the service. The current build keeps the default account and named profiles in their correct credential scopes.

If it still fails, inspect **U** and try `/usage` in the native Claude terminal. A valid login may still receive no usage data from the provider. [Claude’s credential-storage documentation](https://code.claude.com/docs/en/authentication#credential-management) describes the platform difference.

For Codex, Relay’s external-token integration needs a file-backed subscription login. If an existing login is only in Keychain, use **L** for that account to create the supported profile.

## Mac terminal startup error

For `Relay integration: posix_spawnp failed`, update to the current source and run:

```sh
node bin/relay.mjs doctor
```

Relay repairs a missing owner execute bit on node-pty’s launch helper before starting a terminal. The diagnostic verifies startup, input/output, resizing, and exit. It will report a specific error if repair is not possible. The underlying packaging issue is recorded in [node-pty #850](https://github.com/microsoft/node-pty/issues/850).

If `npm ci` instead fails because developer tools are missing, install Apple’s Command Line Tools with `xcode-select --install`, then retry.

## Native client not found

Check `claude --version` or `codex --version` for the provider you want to use. Only one native client is required. After adding the other provider later, run `relay install` again and open a new terminal.

On Windows, Relay resolves native executables, not an npm `.cmd` wrapper. Install the native client or identify the actual `claude.exe` / `codex.exe`. The Codex installation directory under `%LOCALAPPDATA%/Programs/OpenAI/Codex/bin` is also checked.

For a custom location, set an absolute executable path with `RELAY_CLAUDE_BIN` or `RELAY_CODEX_BIN` **before the first Relay installation**. The installer saves the resolved paths. If a client was moved afterward, include that detail when reporting the problem.

## “relay” is not recognized

Open a new shell after installing. If it is a VS Code terminal, restart VS Code after saving your work so it inherits the updated environment.

Keep Relay’s source folder in the installation location. If it has moved, run `node bin/relay.mjs install` from its new folder, then open another terminal.

On Windows, if PowerShell blocks the npm script launcher during setup, run `npm.cmd ci`.

## Login or workspace trust appears after switching

Native prompts remain visible in the original terminal. Complete the requested login or trust decision there. Profile-specific memory, plugins, and settings can differ between accounts. A provider handoff uses the receiving tool’s own configuration and permissions.

## Shutdown refuses to run

Closing the panel does not close controlled terminals. Exit those Claude/Codex sessions too, after their work is finished. Then run `relay shutdown`. Conversations remain saved by their native client.

## Report an issue

Include your operating system and architecture, Node version, native client versions, Relay version, what you did, and the visible error. See [contributing](../CONTRIBUTING.md).

Review logs and screenshots before posting. Do not attach `~/.relay`, provider profile folders, tokens, authentication files, or private conversation content.
