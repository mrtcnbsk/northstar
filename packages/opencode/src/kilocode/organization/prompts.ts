// kilocode_change - new file

export namespace OrgPrompts {
  export interface StageInput {
    stage: string
    idea: string
    deliverablePath: string
    workers: string[]
    shared: string[]
    priorDeliverables: Array<{ stage: string; path: string }>
    reviseNote?: string
  }

  /** The task prompt the CEO passes verbatim to a department chief. */
  export function stagePrompt(input: StageInput): string {
    const priors = input.priorDeliverables.length
      ? input.priorDeliverables.map((p) => `- ${p.stage}: ${p.path}`).join("\n")
      : "- (none — you are the first stage)"
    const revise = input.reviseNote
      ? `\n## REVISION REQUESTED\nThe user reviewed your previous deliverable and asks:\n${input.reviseNote}\nUpdate the deliverable accordingly.\n`
      : ""
    return `You are running the "${input.stage}" stage of an organization pipeline.

## App idea
${input.idea}

## Prior deliverables (read these first with the read tool)
${priors}
${revise}
## Your team
Delegate concrete work to your workers via the task tool (you may run independent
tasks in parallel with background=true when available): ${input.workers.join(", ")}.
For Apple platform/API/HIG questions consult: ${input.shared.join(", ") || "(none)"}.
Do not do the workers' work yourself; decompose, delegate, verify, integrate.

## Deliverable (mandatory)
Write your department's deliverable to exactly this file:
${input.deliverablePath}
It must be substantial markdown: decisions, produced outputs, file paths of any
code you had written, and open risks.

## Completion protocol
When the deliverable is written and verified, end your final message with the
single word: READY
If you cannot complete the stage, end with: BLOCKED: <one-line reason>`
  }
}
