---
'gcb-host': patch
---

Close the remaining `--jq` environment leak: gh already receives a whitelisted environment with the
token in its isolated config, but a proxy URL carrying a username or password was still visible as
`HTTPS_PROXY`. Such a proxy now makes `--jq` fail, so the expression
cannot read proxy credentials. The host-broker route rejects `--jq` entirely, because its gh
program inherits the selected host account environment.
