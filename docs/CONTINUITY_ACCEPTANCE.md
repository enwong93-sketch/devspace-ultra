# ChatGPT Classic continuity acceptance

DevSpace is a development tool for ChatGPT Classic. Publishing a stable release
requires evidence from the client the user actually operates. A manual rescue,
a healthy Core, a passing test, or a working Codex tool is not that evidence.
This checklist controls release claims, never ordinary Agent tool access.

## Compare the two continuation paths

| Path | Authoritative boundary | Expected behavior |
| --- | --- | --- |
| Normal Goal continuation | The exact native assistant turn has ended; its Goal is active and incomplete | Queue exactly one hidden next round without a manual bind, progress report, completed Plan or another human prompt. |
| Rescue | The current exact physical turn has interrupted or failed, with its original episode still monitored | Recover that episode once; do not compete with hidden Goal recovery or replay a committed send. |
| Core replacement | Persisted episode, Goal state and dispatch journal | Preserve unfinished work, original clocks and committed delivery across more than one replacement. |

UI labels, a sidebar title, an idle composer, HTTP stream closure, progress-card
text and elapsed time alone do not prove a native assistant end-turn. Use native
turn/branch and request evidence; UI readback only corroborates it. Respect the
user's explicit pause, stop and cancellation.

## Real client evidence required

Use an isolated disposable task on this installation's own authenticated
Connector. Preserve all working conversations, application processes and OAuth
state. Never substitute another computer's Connector when a test fails.

1. In a fresh Classic conversation, start a small genuine multi-round Goal.
   Let its first assistant turn finish with the objective still incomplete.
   Observe a new assistant turn and real tool results without another human
   message, manual bind or report prerequisite. Repeat for another round.
2. Verify ordinary read/write/edit/command tools remain available while optional
   narration or Plan state is pending. Read back the disposable marker on disk.
3. In the isolated task only, observe a genuine interrupted-turn failure.
   Verify automatic Rescue starts one new physical turn without an operator's
   manual continue. Observe native turn evidence and an Agent-authored update.
4. At a safe controlled maintenance boundary, replace Core more than once.
   Verify the same unfinished Goal and original Rescue episode survive, no
   duplicate dispatch occurs, and tool access remains available. Do not reboot
   the computer or restart another Agent for this check.
5. Test the actual archive's fresh installation and older-version update path in
   an isolated environment. Preserve config/auth/application state, and verify
   the installed files match the archive used for acceptance.

Record version, source/archive hashes, environment, native turn identifiers,
dispatch count, disposable read-back and each observed pass/fail/inconclusive
result in private evidence. Do not publish account identifiers, personal paths,
hostnames, Connector names, credentials or another user's machine information.

## Automated evidence is a separate layer

Run `verify:ultra`, `verify:public-release` and
`verify:continuity-regressions` against the same candidate tree. The Goal
in-memory MCP harness and VM Apps-host tests validate contracts and regressions;
they do not drive a real Classic desktop or prove its hidden continuation
channel. A manually resumed original conversation proves only recovery of that
conversation, not automatic Rescue or fresh-Agent Goal stability.

## Draft build and owner-reviewed stable promotion

Tag packaging creates a **draft**, never an automatic stable update. Run the
real-client checks on that exact archive. Keep native turn identifiers and
private observations locally; publish only SHA-256 references and results.
Do not edit platform/Computer Use safety instructions to perform acceptance.
If automated desktop operation is not permitted, the owner operates the client.

After all checks genuinely pass, attach `CONTINUITY_ACCEPTANCE.json` to the
draft. It must use schemaVersion 1, the exact version/sourceCommit/archiveSha256,
client `ChatGPT Classic Windows`, evidenceKind `real-client`, ownerReviewed true,
an ISO observedAt, and these check records (each with result `pass` and a private
evidenceSha256):

- normalGoal: observedAssistantTurns at least 3, additionalHumanMessages 0,
  manualBindCalls 0, hiddenContinuation true.
- ordinaryTools: disposableReadWriteEditCommandReadback true.
- automaticRescue: automaticDispatchCount 1, manualContinueCount 0,
  observedAgentWork true.
- repeatedCoreReplacement: replacements at least 2, duplicateDispatches 0,
  statePreserved true.
- freshInstall: filesMatchArchive true, nativeSqliteLoaded true.
- olderVersionUpgrade: filesMatchArchive true, nativeSqliteLoaded true,
  statePreserved true, fromVersion an actual older stable version.

Then explicitly dispatch **Promote accepted stable release** with the draft
tag. The workflow verifies local archive bytes against GitHub's asset digest,
matches the attestation's source commit to the checked-out tag, and fails closed
on missing/inconclusive/simulated evidence before changing draft/latest status.
This validates a human-reviewed attestation; it does not independently observe
Classic or turn unit-test fixtures into acceptance. Never upload fixtures as
`CONTINUITY_ACCEPTANCE.json`.
