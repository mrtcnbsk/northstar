---
description: Start (or resume) a content-studio organization run
agent: ceo
---

The user wants to run the content-studio organization.

Input: $ARGUMENTS

- If the input starts with `--resume <run-id>`: call org_status for that run,
  then continue the protocol with org_advance.
- If the input starts with `--status`: call org_status (with the run id if
  given) and report; do not advance anything.
- Otherwise treat the entire input as the content brief and follow your
  protocol from step 1 (org_start).
