# Contributing to Relay

Thanks for helping improve Relay. Small fixes, clear bug reports, and testing on different terminals are welcome.

## Report a bug

Use [GitHub Issues](https://github.com/Damir-Miljic/relay/issues) and include:

- Your operating system, architecture, and terminal.
- Relay, Node.js, Claude Code, and Codex versions.
- Steps to reproduce, what you expected, and what happened.
- The visible error and relevant `relay doctor` output.

Remove account identifiers, private project details, tokens, and conversation content from screenshots or logs. Do not upload Relay data folders or provider authentication files.

## Make a change

Create a branch, keep the change focused, and explain the user-visible behavior in the pull request. For a fresh development checkout:

```sh
npm ci
npm run check
npm test
npm pack --dry-run
```

If the checkout is your active Relay installation, close controlled sessions and shut down its service before replacing dependencies. See [updating Relay](docs/installation.md#update).

Routing and integration changes should preserve per-session account isolation, native approval prompts, safe switch boundaries, and cancellation before commit. Add regression coverage when fixing those behaviors. See [testing](docs/testing.md) for native checks, which are deliberately separate from the provider-free suite.

## Documentation and screenshots

Keep setup instructions easy to follow, use relative links, and show generic account names in screenshots. Useful entry points are [installation](docs/installation.md), [usage](docs/usage.md), and [troubleshooting](docs/troubleshooting.md).

Contributions are shared under the repository’s [MIT license](LICENSE).
