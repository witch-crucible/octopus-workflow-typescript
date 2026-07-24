## ADDED Requirements

### Requirement: Checklist inheritance on phase advancement
When advancing to a new phase, the system SHALL copy all VERIFIED and NA checklist items from the previous phase to the new phase, marking them as `inherited: true`.

#### Scenario: Verified items are inherited
- **WHEN** phase advances and previous phase has a VERIFIED checklist item "Code Review done"
- **THEN** the new phase SHALL have an identical item with `inherited: true` and status VERIFIED

#### Scenario: Pending items are not inherited
- **WHEN** phase advances and previous phase has a PENDING checklist item
- **THEN** the new phase SHALL NOT include that item

### Requirement: AI incremental checklist recommendation
The system SHALL support an AI-assisted recommendation of new checklist items based on the change scope of the current phase.

#### Scenario: AI recommends items after phase advance
- **WHEN** `advancePhase` completes and AI integration is configured
- **THEN** the AI SHALL be called with the change scope and SHALL return 0-N new checklist item suggestions

#### Scenario: Recommended items are added as PENDING
- **WHEN** AI returns suggestions
- **THEN** each suggestion SHALL be added to the new phase's checklist with status PENDING, category "AI Recommended", and `inherited: false`

### Requirement: Checklist item notes and inheritance metadata
Each checklist item SHALL support `inherited: boolean` and `notes: string` fields to track origin and context.

#### Scenario: Inherited item tracks source
- **WHEN** an item is inherited from phase A to phase B
- **THEN** the item's `notes` SHALL include "Inherited from Phase A"
