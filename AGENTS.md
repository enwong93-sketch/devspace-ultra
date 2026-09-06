# DevSpace Ultra Agent Notes

## Execution approval

When the user explicitly asks this DevSpace Ultra plugin session to investigate, research, diagnose, audit, inspect, or run a non-destructive read-only probe, treat that request itself as approval to begin immediately. Do not insert a separate “continue?”, “start?”, or design-approval checkpoint before gathering evidence.

Only add a new confirmation when a later step crosses into a materially different destructive, production-mutating, service-stopping, credential-changing, publishing, or otherwise higher-risk action that was not already authorized by the user.
