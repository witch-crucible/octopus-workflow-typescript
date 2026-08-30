# AI Code Review

OCR, Command Code, and Codex independently review the current Git changes and produce a cross-review report.

| 节点编号 (Node ID) | 50.5 |
| --- | --- |
| Phase | Release |
| Responsible Roles | AI |
| Depends On | sonar-and-code-review |
| Actions | AI (assistant: CODE_REVIEW; reviewers: ocr, commandcode, codex; minimum successes: 2) |

The latest aggregate report is written to `cross-review.md`. Raw reports and a matching aggregate are kept under `reviews/<requirement-id>/`, so concurrent requirements cannot overwrite each other's evidence. Review invocations explicitly exclude generated report paths; this repository also ignores them through the node-level `.gitignore`.
