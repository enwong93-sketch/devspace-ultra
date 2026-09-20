# Chat length audit — 2026-09-21 HKT

## Live observation

Exact displayed Chat: `6ab0043a-9558-83ee-aca7-3eb55a1b5f36` on Main-04.
Audited its stored current branch read-only, at 2026-09-20T18:15–18:16Z.
No navigation, replay, model API call or Auto Compact execution was used.
The audit returned only aggregate sizes and tool labels, not raw messages,
credentials or reasoning. These are UTF-8 bytes/JS character counts, NOT
native token counts. `get_context_remaining(mainNumber=4)` returned
available=false, fresh-native-usage-evidence-unavailable.

| Measurement | Observed |
|---|---:|
| User messages | 1 |
| User message characters / UTF-8 bytes | 48 / 132 |
| Assistant tool-call messages | 103 |
| Tool-result messages | 123 |
| Tool-result textual characters | 385,047 |
| Tool-result textual UTF-8 bytes | 385,617 |
| Tool-call textual UTF-8 bytes | 23,366 |
| Mapping nodes / current-branch nodes | 234 / 234 |
| Exact repeated same-role text bytes | 301 |
| Goal-continuation marker messages | 0 |
| Compact-capsule marker messages | 0 |

Grouping results by their preceding tool call, `fetch_file` accounts for
328,396 bytes and `fetch_commit` for 53,730 bytes (about 99.1% combined).
This attribution is a branch-order heuristic, not a native call-ID join.
72 and 8 are attributed RESULT-message counts, not proof of exactly that
many distinct tool invocations. Several individual results are around 16 KB.
Non-text content, host-provided project context, tool schemas and reasoning
are not included in these totals. Do not calculate a claimed remaining-token
number from these byte sizes or equate mapping length with the model window.

The screenshot reports an unresolved DevSpace identity/workspace path; the
branch shows extensive remote file/commit retrieval. That is consistent
with an expensive fallback investigation, not evidence that the user wrote
too much. No repeated full-history injection loop was proven. Absence of
the markers does not exclude other host-side injected context.

## Corrections

1. `AGENTS.md` now requires checkpoint-first resumption, bounded local reads,
   no repetitive catalog/unchanged-file discovery, logs on disk, and no
   unbounded remote-history reconstruction after a local identity failure.
   A router recommendation with missing Worker/ticket prerequisites cannot
   authorize entering a worker continuation flow.
2. Goal acknowledgements now omit ONLY the byte-identical report duplicated
   between `lastRoundReport` and `recentReports`. All report content remains
   in the acknowledgement once; authoritative Goal state is not changed.
   Explicit `devspace_goal_status` and mount retain their full history view.
   The content response explicitly describes the deduplicated view.
   Current real Goal serialization: 8,372 -> 5,149 bytes (-38.5%).
   This is a secondary improvement, NOT the measured primary CTC cause.
3. `devspace-context-payload-audit.mjs` provides repeatable structural evidence
   with tests for current-branch-only accounting, duplicate accounting and
   exclusion of raw transcript/reasoning. It is an explicit read-only probe,
   not a polling watcher and not a replacement compaction mechanism.

## Boundaries

Additional reproduced DevSpace startup issue: opening the CTC workspace
advertised generated `.local` fixture/plugin-clone AGENTS files and the full
global skill catalogue in both text and structured output. The new output
view caps optional nested-path/skill/profile/diagnostic previews, removes
duplicate textual listings, retains full applicable root instructions, and
leaves the complete trusted skill inventory usable by the task router.
The nested-instruction scanner now excludes `.local`/`.tmp` generated
trees, just as it already excluded node_modules/build/cache. Explicitly
opening a nested fixture workspace and reading its instruction files still
works. A parent workspace preview is not a complete instruction inventory;
the response says to check ancestors of the actual path being edited.
No user files or stored skills are deleted. The unbounded read-only discovery
benchmark exceeded 150 seconds and was cancelled; that timeout is not a
performance-pass claim.

After the scanner/view fix, an in-memory-only CTC workspace benchmark took
1,032 ms: 7 nested instruction paths, 209 visible skills retained in the full
inventory, 12 returned in the preview. Optional discovery JSON decreased
from 84,381 to 9,348 UTF-8 bytes (88.9%); this comparison is after excluding
fixture paths, not a claimed size of the original huge fixture response.
Two loaded root/global instruction files remained intact (27,720 bytes).
Goal lifecycle tests explicitly verify that full mount/status/restart history
is unchanged even though mutation acknowledgements remove an exact duplicate.

The external GitHub connector is not implemented by DevSpace; this patch
does not silently alter its `fetch_file`/`fetch_commit` outputs. A full fix
for every new Agent also needs that Agent's source-reading policy/selected
local checkout to honor the bounded-work contract. CTC's checkout is dirty
(`docs/NEW_CONVERSATION_HANDOFF_2026_09_15.md` and an untracked stabilization
document); this investigation does not overwrite either or merge its PRs.
Only a development-chat resumption-budget section is added to CTC AGENTS.md;
it does not change native Goal/Plan, protocol, build parity or release gates.
Do not claim the host length limit itself has been raised or bypassed, that
old stored messages have been deleted, or that Auto Compact is enabled.
Goal/Plan/Rescue and the exact conversation isolation guarantees remain.

## Usage

`node scripts/devspace-context-payload-audit.mjs <managed-debug-port> <exact-conversation-id>`

Run once for a relevant changed state and retain the aggregate result; do
not repeatedly fetch the full backend mapping during routine progress.
