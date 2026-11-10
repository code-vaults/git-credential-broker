---
"gcb-host": patch
---

`compose` now emits the released `ghcr.io/code-vaults/gcb-host:<version>` image and runs its installed
`gcb daemon` binary. It no longer generates an `npx --package gcb-host` command or accepts `--package`.
The `--code` staged-code mode is unchanged.
