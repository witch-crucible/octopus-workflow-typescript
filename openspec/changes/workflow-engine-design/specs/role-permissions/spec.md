## ADDED Requirements

### Requirement: Role-based action authorization
The workflow engine SHALL enforce that only the assigned `responsibleRole` of a task can mark it COMPLETED.

#### Scenario: Correct role can complete task
- **WHEN** user with role DEV calls `completeTask` on a task with `responsibleRole: DEV`
- **THEN** the task SHALL be marked COMPLETED

#### Scenario: Incorrect role is rejected
- **WHEN** user with role QA calls `completeTask` on a task with `responsibleRole: DEV`
- **THEN** the operation SHALL fail with a permission error

### Requirement: Role-based checklist verification
Only a user with the matching role SHALL be able to verify a checklist item, unless the item has no role restriction.

#### Scenario: Role matches checklist item
- **WHEN** user with role SA verifies a checklist item with `verifiedBy: SA`
- **THEN** the item SHALL be marked VERIFIED

#### Scenario: No role restriction allows any user
- **WHEN** a checklist item has no `verifiedBy` restriction
- **THEN** any authenticated user SHALL be able to verify it

### Requirement: Permission checks are configurable
The workflow engine SHALL support a `strictPermissions` flag. When false, permission checks SHALL be skipped.

#### Scenario: Permissions disabled allows any action
- **WHEN** `strictPermissions` is false
- **THEN** any user SHALL be able to complete any task or verify any checklist item
