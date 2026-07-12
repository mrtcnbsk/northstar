---
description: Start (or resume) a research organization run
agent: ceo
---

The user wants to run the research organization.

Input: $ARGUMENTS

- If the input starts with `--resume <run-id>`: call org_status for that run,
  then continue the protocol with org_advance.
- If the input starts with `--status`: call org_status (with the run id if
  given) and report; do not advance anything.
- Otherwise treat the entire input as the research question and follow your
  protocol from step 1 (org_start).
