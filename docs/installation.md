# Install Relay

[← Back to README](../README.md)

Relay runs alongside your normal terminal sessions. Installation adds shell integration once; after that, keep starting `claude` and `codex` as usual.

## Before you start

| You need | Details |
| --- | --- |
| Windows or macOS | PowerShell / PowerShell 7 on Windows; zsh or bash on macOS. VS Code’s integrated terminal is supported. |
| Node.js with npm | Use Node.js **22 or 24**, the versions tested in CI. [Download Node.js](https://nodejs.org/en/download). |
| Git | Needed for cloning and updating. You can also download a ZIP. [Download Git](https://git-scm.com/downloads). |
| Claude Code or Codex | Install at least one native terminal client. You can use Relay with either provider or both. [Claude setup](https://code.claude.com/docs/en/setup) · [Codex setup](https://learn.chatgpt.com/docs/codex/cli). |

Check your tools in the terminal:

```sh
node --version
npm --version
git --version
```

Then check the client you installed with `claude --version` or `codex --version`, and sign in to it before installing Relay. Subscription usage is available only when the provider exposes it for that login. API-key accounts are not a replacement for subscription logins.

## Install from GitHub

Choose a permanent location for the project, then run:

```sh
git clone https://github.com/Damir-Miljic/relay.git
cd relay
npm ci
node bin/relay.mjs install
```

While the repository is private, cloning requires a GitHub account with access. If you use GitHub CLI, `gh repo clone Damir-Miljic/relay` is another way to clone after signing in.

**Prefer a ZIP?** Use **Code → Download ZIP** on the [repository page](https://github.com/Damir-Miljic/relay), extract it, and open a terminal inside the folder containing `package.json`. Run the last two commands above. There is no published npm package to install yet.

The installer preserves the native provider programs, adds Relay wrappers to your shell configuration, and backs up existing profiles as `.pre-relay`. Windows also gets a user PATH entry. Keep the repository in place; rerun `node bin/relay.mjs install` if you move it.

## Open a new terminal

Existing shells keep their old configuration. Open a new terminal, then run:

```sh
relay doctor
relay
```

Use **A** to add and name accounts, **N** to rename them, and **L** to sign in again. Accounts and settings are local to this computer; GitHub does not transfer your Windows logins to your Mac.

Open another new terminal in your project folder. Start `claude` or `codex` normally. The session should appear under **Your sessions**; press **R Switch account** in Relay to select its account.

## Add the other provider later

Install its native client, then run `relay install` again. Relay discovers the added client and updates the shell integration while preserving your existing accounts. Open a new terminal afterward.

## Platform notes

### Windows

Use a normal PowerShell or PowerShell 7 session with its profile enabled. Relay also supplies command wrappers through the user PATH. If a newly created VS Code terminal still inherits an old PATH, restart VS Code after saving your work.

Relay needs the actual native `claude.exe` or `codex.exe` for each provider you use. An npm `.cmd` launcher alone may not be found. If the installer reports a missing executable, see [client path troubleshooting](troubleshooting.md#native-client-not-found).

If PowerShell blocks the npm script launcher, use `npm.cmd ci` in place of `npm ci`.

### macOS

The installer adds integration to zsh and bash startup files. Open a new Terminal or VS Code terminal after installing.

If dependency installation needs a compiler and reports missing developer tools, install Apple’s Command Line Tools with `xcode-select --install`, then retry `npm ci`.

For an old `posix_spawnp failed` error or unavailable Claude usage, see the [Mac troubleshooting steps](troubleshooting.md#mac-terminal-startup-error).

## Update

Finish or stop background jobs, exit your integrated Claude/Codex sessions, and close the Relay panel first. The service cannot shut down while controlled terminals are still connected.

From the Relay project folder:

```sh
node bin/relay.mjs shutdown
git pull --ff-only
npm ci
node bin/relay.mjs install
```

Open a new terminal and run `relay`. Resume saved conversations using the native client’s resume command and the intended account.

For ZIP installations, download and extract the new source after closing the sessions and service. Install from the new folder before removing the old source folder. Your account data lives separately under `~/.relay`.

## Uninstall

Exit controlled sessions and close the panel, then run:

```sh
relay shutdown
relay uninstall
```

Open a new shell to use the original provider commands again. Account data under `~/.relay` is preserved. Once uninstalled, the source folder can be removed.

[Next: accounts and routing →](usage.md)
