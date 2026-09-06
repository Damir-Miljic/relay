# How Relay integrates with native sessions

[← Back to README](../README.md)

Relay has three local parts: a terminal dashboard, a background service, and a supervisor for each integrated native terminal.

## Launch and discovery

The installer adds shell wrappers while preserving the native executables and existing profile content. A normal interactive `claude` or `codex` command launches the provider’s terminal interface through a pseudoterminal and registers it with Relay.

Discovery also reads native registries, live processes, and Codex file ownership/index information. Saved history alone is not treated as a live session. Unintegrated processes remain view-only; their displayed login profile does not prove which credentials they cached.

## Routing

The service records the intended account separately from the account acknowledged by the running supervisor. Queued changes stay pending until the supervisor confirms them.

### Claude

Session-only lifecycle hooks report reduced lifecycle metadata to Relay. The ordinary hook path does not forward prompt text or tool output to the service.

Switching waits for a supported completed batch or safe idle boundary, empty relevant background-task state, and no pending draft. The supervisor requests a clean exit with Claude’s dedicated exit shortcut, copies only the current conversation’s saved history into the destination profile, and resumes that conversation in the same terminal. A task paused by Relay receives a continuation instruction.

The input tracker distinguishes terminal reports from user input and tracks draft clearing without persisting keystrokes. Unknown state defers a switch.

### Codex

Each integrated terminal uses its own native app-server, with an authenticated loopback WebSocket bridge to the native terminal interface. Provider approval requests are passed to the native interface.

Relay uses Codex’s experimental external ChatGPT token mode to update authentication for that server. It waits for active tools, unresolved permissions/input, and working agents. If completion events are missed, it reconciles with native thread state. Same-provider account changes keep the server and its background terminals alive.

### Provider handoffs

A handoff is a new conversation with selected context, not a conversion of one provider’s complete native history.

The supervisor verifies a safe boundary and the target login, creates a bounded local note, commits the route, and starts the destination. The note contains the original request and selected recent conversation/tool-result text. Internal reasoning, images, credentials, and unrelated conversations are excluded. A failed destination startup attempts to reopen the original conversation.

Cancellation invalidates the queued command before commit. After commit, cancellation and competing routes are rejected until acknowledgement. Automatic provider fallback is opt-in and considers same-provider accounts first.

## Local data

Account settings, profiles, and handoff notes stay under Relay’s local data directory, normally `~/.relay/data` after installation. macOS Claude credentials use the appropriate native Keychain scope. Account credentials are never placed in context notes.

Control listeners bind to loopback and require random bearer tokens. There is no hosted Relay account service. Native provider requests still use the provider’s network services; a cross-provider handoff sends selected context to the receiving provider.

## Dashboard

The dashboard uses a bounded alternate terminal screen and absolute cursor positioning. Refreshes update cells instead of adding scrollback. Menu state is separate from refreshed data; login temporarily returns to the normal terminal. Closing the panel restores the previous screen without stopping sessions.

## Compatibility boundaries

Native CLI integration depends on provider protocols and behavior. Desktop apps, dedicated IDE chat interfaces, unsupported launch modes, and direct absolute-path launches are outside terminal control.

Relay conservatively delays changes when it cannot establish a safe boundary. It does not guarantee exactly-once execution of opaque background actions.

For current validation and reference client versions, see [testing](testing.md).
