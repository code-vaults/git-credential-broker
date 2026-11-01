---
'gcb-client': patch
'gcb-host': patch
---

Fail loudly when `pr --threads` gets no review-thread report instead of printing nothing; a malformed
or structurally incomplete GraphQL response is no longer reported as "no review threads".
