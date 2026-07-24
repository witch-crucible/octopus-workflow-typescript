## 1. Core Model Extensions

- [ ] 1.1 Add `StageStatus` enum and `StageDef` status fields to `packages/core/src/task.ts`
- [ ] 1.2 Add `stages` map and `aiGatingEnabled` flag to `WorkflowState` in `packages/core/src/workflow.ts`
- [ ] 1.3 Add `triggerCounts` to `HeinrichRecord` in `packages/core/src/risk.ts`
- [ ] 1.4 Add `inherited` and `notes` fields to `ChecklistItem` in `packages/core/src/checklist.ts`
- [ ] 1.5 Add `strictPermissions` flag to `WorkflowEngineConfig` in `packages/workflow-engine/src/index.ts`

## 2. Stage Lifecycle Implementation

- [ ] 2.1 Implement `updateStageStatus` in WorkflowEngine
- [ ] 2.2 Implement `checkStageDependencies` gate check
- [ ] 2.3 Update `advancePhase` to verify all stage dependencies before advancing
- [ ] 2.4 Add `getStageProgress` API

## 3. AI Gating Implementation

- [ ] 3.1 Add `AIEventHandler` and `AIEvent` types to `packages/core/src/agent.ts`
- [ ] 3.2 Add `registerAIHandler` and `emitAIEvent` to WorkflowEngine
- [ ] 3.3 Update `advancePhase` to emit `onPhaseAdvance` and respect veto when `aiGatingEnabled`
- [ ] 3.4 Update `rollbackTo` to emit `onPhaseRollback`
- [ ] 3.5 Add `--skip-ai-gates` CLI option to `packages/cli/src/commands/phase.ts`

## 4. Heinrich Audit Triggers

- [ ] 4.1 Add `logHeinrichMarker` API to WorkflowEngine
- [ ] 4.2 Implement threshold check (default 3) in `advancePhase`
- [ ] 4.3 Auto-generate `HEINRICH_AUDIT` task when threshold reached
- [ ] 4.4 Update `assessQuality` to persist verdict as observation

## 5. Checklist Inheritance and AI Recommendations

- [ ] 5.1 Implement `inheritChecklist` helper for phase transitions
- [ ] 5.2 Update `advancePhase` to copy VERIFIED/NA items with `inherited: true`
- [ ] 5.3 Add `recommendChecklistItems` AI assistant method to `packages/agent-layer/src/index.ts`
- [ ] 5.4 Trigger AI recommendation after phase advance when configured

## 6. Role Permissions

- [ ] 6.1 Implement `requireRole` validation helper
- [ ] 6.2 Add permission checks to `completeTask` and `verifyChecklistItem`
- [ ] 6.3 Add `strictPermissions` config support in `packages/context/src/config.ts`
- [ ] 6.4 Update CLI commands to accept `--as-role` for testing

## 7. CLI and Integration Updates

- [ ] 7.1 Add `octopus stage list` and `octopus stage status` commands
- [ ] 7.2 Add `octopus stage update <stageId> <status>` command
- [ ] 7.3 Update `octopus status` to show stage progress
- [ ] 7.4 Add `octopus heinrich marker` command to log audit triggers

## 8. Tests and Verification

- [ ] 8.1 Add unit tests for Stage lifecycle (dependency blocking, status updates)
- [ ] 8.2 Add unit tests for AI gating (veto, bypass, events)
- [ ] 8.3 Add unit tests for Heinrich triggers (threshold, task creation)
- [ ] 8.4 Add unit tests for Checklist inheritance and AI recommendations
- [ ] 8.5 Add unit tests for Role permissions (allow/deny, config bypass)
- [ ] 8.6 Run `pnpm test` and fix failures
