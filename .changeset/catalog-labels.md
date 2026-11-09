---
'gcb-core': minor
---

Add the label domain to the catalog: `label:list` (issues read) and `label:create`/`label:edit`/
`label:delete` (issues write). Deleting requires `--yes`, so the host broker never waits for an
interactive prompt.
