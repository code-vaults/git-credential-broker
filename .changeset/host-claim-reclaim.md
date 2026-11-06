---
'gcb-core': patch
'gcb-host': patch
---

Reclaim host-broker requests whose opener crashed after claiming them. A claim records its pid and
time; the next sweep puts a dead claim back in the queue, resets its age for the first retry, and
leaves a live claim alone. A per-request reclaim lock stops two sweeps acting on the same claim, a
completion marker keeps an already-answered request from being requeued after the client consumed
the result, a malformed reclaim counter cannot bypass the retry cap, and a failed claim file falls
back to the writable request's age.
