---
"@ilura/northstar": minor
---

Rebrand the CLI from Kilo to **northstar** (published as `@ilura/northstar`, binary `northstar`), by Ilura Technology OÜ. Fully open-source (MIT); upstream attribution to Kilo Code and opencode preserved.

- Published package `@kilocode/cli` → `@ilura/northstar`; binary `kilo` → `northstar`.
- Global config dir → `~/.config/northstar`; the old `~/.config/kilo` config is still read (back-compat). Data, sessions, and the sqlite DB are **not** relocated — no migration, no data loss.
- Config files `northstar.jsonc` / `northstar.json` (old `kilo.jsonc` / `kilo.json` still read).
- Config-critical env vars gain `NORTHSTAR_*` names; the old `KILO_*` names still work as a fallback.
- Installer targets `$HOME/.northstar/bin`; `uninstall` cleans up both the new and the legacy install dir. Self-update polls `@ilura/northstar` (npm) and `mrtcnbsk/northstar` (GitHub releases).
