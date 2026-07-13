export namespace TestRunnerOptions {
  export type Defaults = {
    concurrency: number
    timeout: number
    fileTimeout: number
  }

  export function defaults(input: { profile?: string; cpus: number }): Defaults {
    const cpus = Math.max(1, Math.floor(input.cpus))
    if (input.profile === "windows") {
      return {
        concurrency: Math.min(2, cpus),
        timeout: 120_000,
        fileTimeout: 600_000,
      }
    }
    return {
      concurrency: Math.min(4, cpus),
      timeout: 60_000,
      fileTimeout: 300_000,
    }
  }
}
