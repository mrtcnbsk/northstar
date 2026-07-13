// kilocode_change - shared fail-fast Session service for organization tool unit-test runtimes.
import { Effect } from "effect"
import { Session } from "../../../src/session/session"

export const unusedSessionStub = Session.Service.of({
  list: () => Effect.die("unused in test"),
  create: () => Effect.die("unused in test"),
  fork: () => Effect.die("unused in test"),
  touch: () => Effect.die("unused in test"),
  get: () => Effect.die("unused in test"),
  setTitle: () => Effect.die("unused in test"),
  setArchived: () => Effect.die("unused in test"),
  setMetadata: () => Effect.die("unused in test"),
  setPermission: () => Effect.die("unused in test"),
  setRevert: () => Effect.die("unused in test"),
  clearRevert: () => Effect.die("unused in test"),
  setSummary: () => Effect.die("unused in test"),
  diff: () => Effect.die("unused in test"),
  messages: () => Effect.die("unused in test"),
  children: () => Effect.die("unused in test"),
  remove: () => Effect.die("unused in test"),
  updateMessage: () => Effect.die("unused in test"),
  removeMessage: () => Effect.die("unused in test"),
  removePart: () => Effect.die("unused in test"),
  getPart: () => Effect.die("unused in test"),
  updatePart: () => Effect.die("unused in test"),
  updatePartDelta: () => Effect.die("unused in test"),
  findMessage: () => Effect.die("unused in test"),
})
