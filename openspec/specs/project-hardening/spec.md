# Project Hardening

## Purpose

TBD

## Requirements

### Requirement: Local runtime directories SHALL be protected from commits
The project SHALL prevent `.octo/`, `.octo_engine_test/`, and related runtime state directories from being committed.

#### Scenario: Developer runs git status
- **WHEN** a developer runs `git status`
- **THEN** runtime directories are ignored and do not appear as untracked files

### Requirement: Workflow engine core scenarios SHALL have automated tests
The `workflow-engine` package SHALL include unit tests covering init, advance, rollback, checklist, Heinrich, artifacts, and status APIs.

#### Scenario: Tests run in CI or locally
- **WHEN** `pnpm test` is executed
- **THEN** core workflow scenarios pass and failures block the build

### Requirement: CLI commands SHALL support JSON output
CLI commands that display structured data SHALL support `--json` for machine-readable output.

#### Scenario: User requests JSON
- **WHEN** a user appends `--json` to supported commands
- **THEN** the command prints valid JSON and exits successfully

### Requirement: CLI failures SHALL use non-zero exit codes with clear errors
On command failure, the CLI SHALL print an error message and exit with code 1.

#### Scenario: Invalid command input
- **WHEN** a user provides invalid input
- **THEN** the CLI prints an error and exits with code 1

### Requirement: Configuration SHALL be loadable from env and file
Configuration SHALL support `storeDir`, `ai.model`, and `ai.timeout` from environment variables and JSON config file, with defaults preserved.

#### Scenario: Environment override
- **WHEN** `OCTOPUS_STORE_DIR` is set
- **THEN** the loaded config uses the provided value

### Requirement: Git integration SHALL provide basic health and repository info
Git integration SHALL expose health check, repo root detection, current branch, and modified files.

#### Scenario: Git is unavailable
- **WHEN** `git` is not installed
- **THEN** health check returns failure with a clear message
