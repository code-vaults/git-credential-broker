# gcb-core

Shared runtime for [`gcb-client`](https://www.npmjs.com/package/gcb-client) and [`gcb-host`](https://www.npmjs.com/package/gcb-host).

This package is not a CLI. It provides the pieces both sides must agree on:

- command-line parsing and help/version handling
- the typed `gh` action catalog in `src/actions.ts`
- the broker socket protocol and audit record types
- host-request types, validation and the request channel used by `gcb host`
- small platform and filesystem helpers

```sh
npm install gcb-core
```

Use it when building on the broker, not as a replacement for the `gcb` executable; install
`gcb-client` in the container and `gcb-host` on the host.

See the [repository README](https://github.com/code-vaults/git-credential-broker#readme) for the
architecture and deployment model.

## License

MIT
