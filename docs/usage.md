# Using Relay

[← Back to README](../README.md)

## The dashboard

Claude accounts appear on the left and Codex on the right. If only one provider is connected, it starts on the left. Narrow windows stack the groups.

Each reported usage window has its own remaining percentage and reset time. **Lowest limit** is the smallest reported allowance for that account, not a combined balance. Unknown and stale readings remain visible as such.

**Your sessions** contains controlled terminals. **D** expands detected sessions and other native processes. Detection alone does not let Relay control them.

Model and effort labels appear when the native client reports them. Claude’s label refers to its last recorded response; a menu change may not appear until the next response. Detailed view shows original identifiers.

Refreshes update the terminal in place. Use **Tab** to change density and **Up/Down** or **Page Up/Page Down** to scroll long dashboards.

## Keyboard controls

Press a command letter directly from the dashboard. In a menu, use arrows or a number, then Enter. Escape goes back.

| Key | Action |
| --- | --- |
| **R Switch account** | Choose an account for a session; a manual choice enables Keep account. |
| **C Cancel switch** | Cancel a queued manual switch before switching starts. |
| **P** | Toggle a session between Keep account and Auto-switch. |
| **T** | Change one session’s remaining-usage threshold. |
| **S** | Change the default threshold and provider-handoff settings. |
| **A** | Connect and name an account. |
| **N** | Rename an account. |
| **U** | Show every usage window, raw limit ID, and refresh error. |
| **L** | Renew an account’s login through the native client. |
| **F** | Refresh usage and scan sessions. |
| **D** | Expand or collapse detected sessions and processes. |
| **Tab** | Switch compact/detailed display. |
| **?** | Open the full command menu. |
| **Q** | Close the panel; the service and native sessions keep running. |

![Relay’s help and commands screen](screenshots/commands.png)

## Accounts and defaults

Name accounts so you can distinguish them at a glance, such as “Claude Personal” and “Claude Work.”

```sh
relay account add claude --name "Claude Personal"
relay account add codex --name "Codex Work"
relay account rename "Codex Work" --name "Codex Personal"
relay default claude --account "Claude Personal"
```

The provider’s default account is used when a new integrated terminal starts. New sessions start in Auto mode with the configured default threshold, initially **10% remaining**.

To keep a specific account at launch, you can optionally set `RELAY_ACCOUNT`:

macOS:

```sh
RELAY_ACCOUNT='Claude Personal' claude
```

PowerShell:

```powershell
$env:RELAY_ACCOUNT = 'Claude Personal'
claude
Remove-Item Env:RELAY_ACCOUNT
```

## Manual switches and cancellation

Press **R Switch account**, select a session, then its target account. That choice applies only to the selected terminal.

A switch can remain **QUEUED** until the native client reaches a safe stopping point. The panel shows the reason and elapsed wait. Press **C Cancel switch** to cancel a queued manual switch; the session stays on its current account. Once it says **SWITCHING**, the change has committed and cannot be cancelled.

```sh
relay route "SESSION NAME" --account "Claude Personal"
relay cancel-route "SESSION NAME"
relay pin "SESSION NAME"
```

## Automatic switching

Use **P** to enable Auto and **T** to set that session’s threshold. **S → Default switching threshold** changes the default for new sessions. All thresholds accept **1–100% remaining**.

```sh
relay threshold 15
relay threshold 20 --session "SESSION NAME"
relay auto "SESSION NAME" --threshold 15
relay auto "SESSION NAME" --pool "Claude Personal,Claude Work"
```

Changing the default does not alter existing sessions. An optional account pool restricts eligible replacements.

Automatic switching uses fresh usage readings, skips disabled accounts, and requires a replacement above the threshold plus a five-point reserve. The reserve caps at 99%, allowing a full account to qualify for high thresholds. A replacement must have more usage left than the current account, and a cooldown prevents rapid rotation. Unknown or stale usage does not count as available capacity.

Thresholds queue a switch; they do not override unsafe work or guarantee a change before quota reaches zero.

## Changing providers

Claude → Codex and Codex → Claude are **manual by default**. Choose the target through **R Switch account** and read the notice before confirming.

The destination starts a **new conversation in the same terminal and project**. A local context note contains the original request plus selected recent conversation and tool results. That text is sent to the receiving provider. The original conversation remains saved; full native history, internal reasoning, images, model settings, permissions, and tool configurations are not converted.

In **S → Switch provider (with context)**, enable **Automatic fallback** to allow Auto sessions to change providers when their threshold is reached and no suitable same-provider account is available. Sessions set to Keep account, account pools, and fresh-usage requirements still apply. Choose **Manual only** to disable future automatic provider changes.

From the command line, `--handoff` explicitly accepts the context-transfer notice:

```sh
relay route "SESSION NAME" --account "Codex Personal" --handoff
```

Handoffs wait for active work and background terminals to finish. Older supervisors must be restarted through the integration to support this feature.

## Other useful commands

| Command | Purpose |
| --- | --- |
| `relay` | Open the panel. |
| `relay status` | Print usage and sessions once. |
| `relay status --watch --compact` | Open a compact live panel. |
| `relay discover` | Scan running native sessions. |
| `relay refresh` | Refresh usage. |
| `relay doctor` | Check installation and terminal support. |
| `relay --help` | List command-line options. |
| `relay shutdown` | Stop the service after controlled terminals have exited. |

The interface says **Switch account**; the existing `relay route`, `relay cancel-route`, and `relay pin` commands remain compatible. **Keep account** means automatic switching is off for that session.

Legacy managed-chat commands (`relay claude`, `relay codex`, `attach`, `send`, `stop`) remain for compatibility. They are separate from the normal terminal workflow.

[Having trouble? →](troubleshooting.md)
