## ADDED Requirements

### Requirement: AI event hooks for phase transitions
The workflow engine SHALL emit `onPhaseAdvance` and `onPhaseRollback` events that external AI handlers can subscribe to.

#### Scenario: Event emitted before phase advance
- **WHEN** `advancePhase` is called and gate checks pass
- **THEN** an `onPhaseAdvance` event SHALL be emitted with current phase, next phase, and project state

#### Scenario: Event emitted on phase rollback
- **WHEN** `rollbackTo` is called
- **THEN** an `onPhaseRollback` event SHALL be emitted with current phase, target phase, and project state

### Requirement: AI pre-check can block phase advancement
A registered AI handler SHALL be able to return a veto that prevents phase advancement, with a reason.

#### Scenario: AI veto blocks advancement
- **WHEN** an AI handler returns `{ allowed: false, reason: "SQL risk detected" }`
- **THEN** `advancePhase` SHALL fail with the AI-provided reason

#### Scenario: AI approval allows advancement
- **WHEN** an AI handler returns `{ allowed: true }`
- **THEN** `advancePhase` SHALL proceed normally

### Requirement: AI gating is optional and configurable
The workflow engine SHALL support an `aiGatingEnabled` flag. When false, AI events SHALL still be emitted but SHALL NOT block advancement.

#### Scenario: AI gating disabled bypasses veto
- **WHEN** `aiGatingEnabled` is false and AI returns veto
- **THEN** `advancePhase` SHALL proceed and the veto SHALL be logged as a warning
