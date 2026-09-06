# Testing and compatibility

[← Back to README](../README.md)

## Automated checks

[GitHub Actions](https://github.com/Damir-Miljic/relay/actions/workflows/ci.yml) performs clean dependency installation, syntax checks, tests, and package checks on:

| Platform | Node.js |
| --- | --- |
| Windows | 22 and 24 |
| macOS | 22 and 24 |
| Linux | 22 and 24 |

Run the provider-free checks from the repository:

```sh
npm run check
npm test
npm pack --dry-run
```

The suite covers installation with either provider, adding a second provider on reinstall, missing/invalid client paths, routing, account isolation, quota freshness, cancellation/commit races, provider handoff context boundaries, native lifecycle handling, draft input, discovery, authenticated local transport, viewport bounds, and real pseudoterminal startup/input/resize/exit. The POSIX helper-permission test skips Windows.

CI does not sign in to real subscription accounts. Green tests are not a substitute for native client validation.

## Native validation recorded for 0.2.3

The Windows reference environment used Node.js 22.19.0, Claude Code 2.1.263, and Codex CLI 0.147.0.

| Behavior | Validation |
| --- | --- |
| Claude account switch | Real isolated Windows terminal tests preserved the native conversation and recalled a marker on the second account. Idle switching and draft protection were exercised. |
| Codex account switch | A real native server changed account identity, retained a background terminal, and completed a turn on the original thread using the new account. |
| Claude ↔ Codex handoff | Real isolated Windows terminal tests completed both directions, recalled transferred context, and cancelled a queued handoff. |
| Dashboard | Windows terminal checks exercised keyboard menus, resizing, and clean exit. |
| macOS installation and startup | Automated terminal checks run in CI; a user confirmed native startup after the launch-helper fix. |
| macOS Claude usage | A user confirmed usage after the credential-scope fix. Credential selection also has provider-free regression coverage. |

The available record does **not** establish complete native account-switching and provider-handoff coverage on macOS or Linux. Actual production quota exhaustion has not been manufactured; automatic thresholds are checked with controlled usage fixtures.

## Manual acceptance check

Use a disposable project and conversations when validating a release.

1. Install from a clean checkout and open a fresh shell. Run `relay doctor`.
2. Start each native client normally; verify it appears under **Your sessions**.
3. Check all available usage windows and compare model/effort after a response.
4. Switch an idle session to a second account; verify account identity and conversation continuity.
5. Run two terminals on different accounts; confirm their account choices stay independent.
6. Queue a manual switch with a draft present and cancel it with **C** before it commits.
7. Check default and per-session thresholds, including values above 50%.
8. Try both provider handoff directions after reading the notice; verify a new conversation and transferred context.
9. Repeat launch and routing in a fresh VS Code terminal.
10. Close controlled sessions, update, and verify uninstall restores normal commands.

## Optional native smoke scripts

These are separate from `npm test`. They need installed/logged-in clients. Some create conversations, use real model quota, and change accounts for their test sessions. Read each script before running it.

```sh
node scripts/smoke-native-bridge.mjs
node scripts/smoke-native-terminal.mjs codex
node scripts/smoke-native-terminal.mjs claude
node scripts/smoke-dashboard.mjs
node scripts/smoke-provider-handoff.mjs
```

The Claude terminal script requires two accounts. `--conversation` adds two small no-tool requests to test remembered context. `--idle-input` exercises real prompt input, draft protection/clearing, terminal focus reports, and switching without an extra submitted prompt.

This guide describes current coverage rather than listing every intermediate test run.
