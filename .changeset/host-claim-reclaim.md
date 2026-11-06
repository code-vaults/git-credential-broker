---
'gcb-core': patch
'gcb-host': patch
---

Reclaim host-broker requests whose opener crashed after claiming them. A claim now records its pid
and time; the next sweep puts a dead claim back in the queue, retires it if an answer already exists,
and leaves a live claim alone. A claim with no readable record falls back to the file age.
