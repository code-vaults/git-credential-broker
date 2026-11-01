---
'gcb-client': patch
'gcb-host': patch
---

Fail loudly when `pr --threads` gets no review-thread report instead of printing nothing; a malformed,
structurally incomplete, or missing-field GraphQL response is no longer reported as "no review
threads". Refused pull-request actions are audited as `pull-request`, not `credential`.
