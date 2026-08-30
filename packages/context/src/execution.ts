import type {
  IntegrationHealth,
  NodeRun,
  NodeRunStatus,
  WorkflowEvent,
} from "@octopus/core/execution.js"

export interface CreateRunInput {
  readonly id?: string
  requirementId: string
  nodeId: string
  forced: boolean
  stdoutPath: string
  stderrPath: string
}

export interface ExecutionStore {
  createRun(input: CreateRunInput): Promise<NodeRun>
  getRun(runId: string): Promise<NodeRun | undefined>
  listRuns(requirementId: string, nodeId?: string): Promise<NodeRun[]>
  updateRun(runId: string, patch: Partial<NodeRun>): Promise<NodeRun>
  transitionRun(
    runId: string,
    from: readonly NodeRunStatus[],
    patch: Partial<NodeRun>,
  ): Promise<NodeRun | undefined>
  appendEvent(event: Omit<WorkflowEvent, "sequence">): Promise<WorkflowEvent>
  eventsAfter(requirementId: string, sequence: number): Promise<WorkflowEvent[]>
  saveIntegrationHealth(health: IntegrationHealth): Promise<void>
  listIntegrationHealth(): Promise<IntegrationHealth[]>
  purge(before: string): Promise<number>
}
