# gcb-client

Container-side `gcb`: the git credential helper and the client for a host-side `gcb-host` broker.

The container holds no long-lived GitHub credential. `git push` asks this client, which asks the
broker over a unix socket; the broker returns a short-lived installation token, and the helper hands
it to Git for that push. The token expires; it is not stored in the container.

```sh
npm install --global gcb-client
gcb setup
```

`gcb setup` configures this environment's git to use the broker as a `!gcb` credential helper.

## Commands

- `gcb setup`, `gcb probe`, `gcb logs`
- `gcb pr ...` — pull-request lifecycle and catalogued actions
- `gcb issue ...` — issue actions and person/host routes
- `gcb run ...` — workflow run actions
- `gcb gh ...` — run a catalogued action explicitly
- `gcb repo fork` — fork as a person

`GCB_PRIMARY` selects the CLI adapter for catalogued actions. The default is `gh`; an unsupported
name fails closed. The host broker still performs the action.

`gcb gh` accepts bare `--as-user` for actions the app broker can run with the person identity.
The login form (`--as-user <login>`) is a typed host route on `gcb pr` / `gcb issue`.

## Requirements

- Node.js 24 or newer
- a running `gcb-host` broker, reachable through `GIT_BROKER_SOCKET` or `gcb setup`

See the [repository README](https://github.com/code-vaults/git-credential-broker#readme) for the
full configuration and deployment guide.

## License

MIT
