---
"@ilura/northstar": minor
---

Terminal-only, npm-only release pipeline. northstar now ships via `npm i -g @ilura/northstar` and a `curl … | bash` one-liner from the raw GitHub URL; the VS Code, JetBrains, Docker/ghcr, AUR, and Homebrew release channels and CI jobs are removed.

- `publish.yml` drops the `build-vscode` and `smoke-test` jobs (the latter depended on a private upstream bench repo) and the docker/AUR/vsce publish steps; both `publish.ts` scripts publish npm only.
- Deleted the JetBrains/VSCode/Docker/Kotlin-CodeQL workflows and pruned the JetBrains/VSCode jobs from `test.yml` / `typecheck.yml` / `visual-regression.yml`; the `check-workflows` allowlist is synced.
- README installation section rewritten to npm + curl; product identity updated to northstar.
