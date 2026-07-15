---
"@ilura/northstar": patch
---

Harden the autonomous organization runtime, the local server, and the installer:

- Autonomous runs no longer lose a chief session's cost from budget accounting when a run is paused mid-stage, so run/stage/escalation ceilings are enforced against the true spend.
- An irreversible-action approval now authorizes only the stage it was granted for; approving one stage can no longer silently authorize another stage's irreversible action.
- The cost-escalation checkpoint now pauses for a human even in autonomous mode instead of being auto-approved.
- Starting an autonomous run no longer lets the manual and headless drivers advance the same run in parallel (which could duplicate chief sessions and spend).
- Two `org start` calls for the same idea in the same second get distinct runs instead of overwriting each other.
- The local server refuses to start when it would be exposed beyond localhost (e.g. `--mdns`) without a password, unless `KILO_ALLOW_UNAUTHENTICATED=1` is set; unauthenticated requests carrying a foreign `Host` header (DNS rebinding) are rejected.
- The `curl | bash` installer verifies downloaded release archives against published SHA-256 checksums and uses unpredictable temp paths.
