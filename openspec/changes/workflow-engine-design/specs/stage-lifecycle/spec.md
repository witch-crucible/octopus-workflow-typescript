## ADDED Requirements

### Requirement: Stage dependency completion check
The workflow engine SHALL block phase advancement until all stages in the current phase with `dependsOn` have their dependent stages marked COMPLETED.

#### Scenario: Stage with unmet dependency blocks advancement
- **WHEN** a stage has `dependsOn: ["10.1"]` and stage 10.1 is PENDING
- **THEN** `advancePhase` SHALL fail with a reason listing the blocked stage and its unmet dependency

#### Scenario: All dependencies met allows advancement
- **WHEN** all stages' `dependsOn` targets are COMPLETED or SKIPPED
- **THEN** `advancePhase` SHALL succeed and move to the next phase

### Requirement: Stage status tracking
The system SHALL track each stage's status independently (PENDING, IN_PROGRESS, COMPLETED, BLOCKED, SKIPPED) within a phase.

#### Scenario: Stage can be marked in progress
- **WHEN** user calls `updateStageStatus(projectId, stageId, IN_PROGRESS)`
- **THEN** the stage status SHALL be updated and persisted

#### Scenario: Stage can be marked completed
- **WHEN** user calls `updateStageStatus(projectId, stageId, COMPLETED)`
- **THEN** the stage status SHALL be updated and persisted
