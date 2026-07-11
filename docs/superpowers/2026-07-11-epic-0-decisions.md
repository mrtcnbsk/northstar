# EPIC 0 — Prerequisite Decisions (resolved 2026-07-11)

Decisions for the EPIC roadmap (`docs/superpowers/plans/2026-07-11-epic-roadmap.md`). Owner: Ilura Technology OÜ.

## 0.1 — License / open-core: **FULLY OPEN-SOURCE (MIT)**
The moat (org runtime `packages/opencode/src/kilocode/organization/`, the apple-delivery pipeline `src/kilocode/asc/` + xcode/simctl tools, and the Apple validator agents) ships **open-source under the MIT License**, same terms as upstream. Ilura holds copyright in its own additions and licenses them openly.

**Consequences:**
- **EPIC 3 collapses** from a package split to *license/attribution cleanup only*. No private package, no feature-flag gate, no "public CLI builds without the moat" work.
- **LICENSE** unchanged — already MIT with all three copyright holders (Ilura + Kilo Code + opencode).
- **NOTICE + README banner corrected** (this commit): the earlier rebrand wording ("private, proprietary derivative work", "Ilura's contributions are proprietary") was wrong under this decision and now reads MIT-open with Ilura holding copyright in its additions.
- **Trademark cleanup** (remove user-facing "Kilo Code" brand strings, keep upstream attribution) folds into EPIC 1.5.
- Note: the GitHub repo is currently *private* (a visibility choice, pending the EPIC 2 release); the *license* is MIT-open regardless.

## 0.2 — Name reservation: **USER ACTION (blocks EPIC 2, not EPIC 1)**
Reserving `@ilura/northstar` on npm (+ protective `northstar-cli`, `@northstar/cli`; PyPI/crates `northstar-cli`) requires publishing `0.0.0` placeholders under Ilura's own npm/PyPI/crates accounts. Claude cannot publish on the owner's behalf (credentials + outward-facing publish). This gates the EPIC 2 release step; EPIC 1's code rename (setting `name` to `@ilura/northstar`, etc.) can proceed beforehand.

## 0.3 — `@mention` mid-run semantics: **(a) SIDE-CHANNEL NOTE (default)**
An `@agent` mention mid-run injects the message into the target agent's session as a note; the runner continues managing turn order. It is NOT a re-route or a barrier. `pause`/`steer` (interrupt-and-redirect) is a *separate* command, not the default `@mention` behavior. To be implemented in EPIC 7.3.

## 0.4 — Apple account: **INFORMATIONAL**
An Apple Developer account (+ ASC API key) is needed only to *live-test* the apple-delivery toolpack (W7). The generalization work (EPIC 4 — toolpacks + templates) does not require it; apple-delivery remains fixture-tested until an account is provisioned.
