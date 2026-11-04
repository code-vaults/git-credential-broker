# gcb-host

Host-side `gcb`: the broker, configuration, providers and administration commands.

The broker holds the GitHub App private key and mints short-lived, single-repository installation
tokens. It runs outside the container; the container-side [`gcb-client`](https://www.npmjs.com/package/gcb-client) never receives a
long-lived credential.

```sh
npm install --global gcb-host
gcb init --mode host        # writes broker.config.yml and validates the deployment
gcb doctor --config broker.config.yml
gcb daemon --config broker.config.yml
```

## Commands

`gcb init`, `gcb config`, `gcb diagnose`, `gcb doctor`, `gcb authorize`, `gcb stage`,
`gcb compose`, and `gcb daemon`/`gcb host`.

The host broker also serves typed person requests from `gcb-client --as-user <login>` (create,
review, reply and edit routes), using the `gh-<login>` configuration directory on this machine.

See the [repository README](https://github.com/code-vaults/git-credential-broker#readme) for the
configuration reference, allowlist rules and deployment shapes.

## Requirements

- Node.js 24 or newer
- `gh` for the host-broker person routes and catalogued execution
- a GitHub App private key outside every directory the container can write

## License

MIT
