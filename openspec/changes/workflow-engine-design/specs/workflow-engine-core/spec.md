## ADDED Requirements

### Requirement: WorkflowState includes stage tracking
The `WorkflowState` interface SHALL include a `stages` map keyed by stage ID, containing status and metadata for each stage.

#### Scenario: State includes stage status
- **WHEN** a project is initialized
- **THEN** `state.stages` SHALL contain entries for all stages in the current phase with status PENDING

### Requirement: WorkflowState includes AI gating configuration
The `WorkflowState` interface SHALL include `aiGatingEnabled: boolean` and `aiGateResults: Array<{phase, allowed, reason, timestamp}>`.

#### Scenario: AI gate result is recorded
- **WHEN** an AI gate vetoes phase advancement
- **THEN** the result SHALL be appended to `state.aiGateResults`

### Requirement: WorkflowState includes Heinrich trigger counts
The `HeinrichRecord` interface SHALL include `triggerCounts: Record<Phase, number>` tracking audit triggers per phase.

#### Scenario: Trigger count is incremented
- **WHEN** a Heinrich marker is recorded for phase DESIGN
- **THEN** `state.heinrich.triggerCounts[DESIGN]` SHALL increment by 1
