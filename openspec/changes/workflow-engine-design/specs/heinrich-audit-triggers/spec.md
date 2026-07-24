## ADDED Requirements

### Requirement: Heinrich audit trigger counting
The system SHALL track audit trigger counts separately from defect counts. Each time a Heinrich triangle marker appears in the process, it increments the trigger count for that phase.

#### Scenario: Trigger count increments on marker
- **WHEN** a Heinrich marker is recorded during a phase transition or key node
- **THEN** the trigger count for that phase SHALL increment by 1

#### Scenario: Trigger count does not affect defect counts
- **WHEN** an audit trigger is recorded
- **THEN** majorDefects, minorDefects, and trivialDefects SHALL remain unchanged

### Requirement: Threshold-based quality audit
When a phase's trigger count reaches a configurable threshold (default 3), the system SHALL automatically generate a quality assessment task.

#### Scenario: Threshold reached creates audit task
- **WHEN** trigger count for a phase reaches 3
- **THEN** a new task of type `HEINRICH_AUDIT` SHALL be created in that phase with status PENDING

#### Scenario: Threshold not reached does not create task
- **WHEN** trigger count is 2
- **THEN** no audit task SHALL be created

### Requirement: Quality assessment verdict persistence
Quality assessment results SHALL be stored as observations with a verdict (HEALTHY, UNDER_REPORTING, OVER_REPORTING).

#### Scenario: Assessment creates observation record
- **WHEN** `assessQuality` is called and a verdict is determined
- **THEN** a new HeinrichObservation with the verdict SHALL be appended to the record
