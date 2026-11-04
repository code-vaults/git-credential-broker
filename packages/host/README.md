# gcb-host

Host-side `gcb`: the broker, configuration, providers and administration commands.

The broker holds the GitHub App private key and mints short-lived, single-repository installation
tokens. It runs outside the container; the container-side [`gcb-client`](https://www.npmjs.com/package/gcb-client) never receives a
long-lived credential.

```sh
npm install --global gcb-host
# writes broker.config.yml and validates the deployment (default mode: host)
gcb init --config broker.config.yml \
  --cert /path/to/app.private-key.pem \
  --allow owner/repo \
  --client-id <client-id> \
  --app-id <app-id>
gcb doctor --config broker.config.yml
gcb daemon --config broker.config.yml
```

## Commands

`gcb init`, `gcb config`, `gcb diagnose`, `gcb doctor`, `gcb authorize`, `gcb stage`,
`gcb compose`, and `gcb daemon`/`gcb host`.

The host broker also serves typed person requests from `gcb-client --as-user <login>` (create,
review, reply, edit and catalogued-action routes), using the `gh-<login>` configuration directory on
this machine. The catalogued-action route is what `gcb gh <action> --as-user <login>` uses; it is
validated against the same action catalog and allowlist, never raw argv.

See the [repository README](https://github.com/code-vaults/git-credential-broker#readme) for the
configuration reference, allowlist rules and deployment shapes.

## Requirements

- Node.js 24 or newer
- `gh` for the host-broker person routes and catalogued execution
- a GitHub App private key outside every directory the container can write

## License

MIT
