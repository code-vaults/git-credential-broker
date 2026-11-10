---
"gcb-core": minor
"gcb-client": minor
---

Search actions accept multiple positional terms (or one quoted phrase): the final positional is
repeatable, and each term is passed to `gh` as its own argument after `--`. Repository-scope
qualifier rejection applies to every term.
