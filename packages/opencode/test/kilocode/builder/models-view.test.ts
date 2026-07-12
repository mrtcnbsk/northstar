// kilocode_change - new file
import { describe, expect, test } from "bun:test"
import type { Provider } from "@kilocode/sdk/v2"
import { buildProviderRows } from "@/kilocode/builder/models-view"

// Minimal inline Provider/Model-shaped fixture — only the fields
// `buildProviderRows` actually reads need to be present.
const providers = [
  {
    id: "poe",
    name: "Poe",
    source: "custom",
    models: {
      "glm-4.6": {
        id: "glm-4.6",
        providerID: "poe",
        name: "GLM 4.6",
        limit: { context: 200000 },
        capabilities: { toolcall: true },
        cost: { input: 1, output: 2 },
        status: "stable",
      },
    },
  },
  {
    id: "ollama",
    name: "Ollama",
    source: "custom",
    models: {
      llama3: {
        id: "llama3",
        providerID: "ollama",
        name: "Llama 3",
        limit: { context: 0 },
        capabilities: { toolcall: false },
        cost: { input: 0, output: 0 },
        status: "stable",
      },
    },
  },
] as unknown as Provider[]

describe("buildProviderRows", () => {
  test("groups models by provider", () => {
    const rows = buildProviderRows(providers, new Set())
    expect(rows).toHaveLength(2)
    const poe = rows.find((r) => r.providerID === "poe")!
    const ollama = rows.find((r) => r.providerID === "ollama")!
    expect(poe.models).toHaveLength(1)
    expect(ollama.models).toHaveLength(1)
  })

  test("classifies providers as local vs hosted via isLocalPreset", () => {
    const rows = buildProviderRows(providers, new Set())
    const poe = rows.find((r) => r.providerID === "poe")!
    const ollama = rows.find((r) => r.providerID === "ollama")!
    expect(poe.klass).toBe("hosted")
    expect(ollama.klass).toBe("local")
  })

  test("connected reflects the passed connectedIDs set", () => {
    const rows = buildProviderRows(providers, new Set(["poe"]))
    const poe = rows.find((r) => r.providerID === "poe")!
    const ollama = rows.find((r) => r.providerID === "ollama")!
    expect(poe.connected).toBe(true)
    expect(ollama.connected).toBe(false)
  })

  test("model rows carry verified/toolcall/context/cost through", () => {
    const rows = buildProviderRows(providers, new Set())
    const poeModel = rows.find((r) => r.providerID === "poe")!.models[0]!
    const ollamaModel = rows.find((r) => r.providerID === "ollama")!.models[0]!

    expect(poeModel.verified).toBe(true)
    expect(poeModel.toolcall).toBe(true)
    expect(poeModel.context).toBe(200000)
    expect(poeModel.cost).toBeGreaterThan(0)

    expect(ollamaModel.verified).toBe(false)
    expect(ollamaModel.toolcall).toBe(false)
    expect(ollamaModel.context).toBe(0)
    expect(ollamaModel.cost).toBe(0)
  })
})
