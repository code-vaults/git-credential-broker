---
"gcb-core": patch
"gcb-client": patch
"gcb-host": patch
---

Add `pr:review-edit <number> <id> --body`: update the body of an existing pull request review
through the fixed `PUT /repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}` endpoint.
