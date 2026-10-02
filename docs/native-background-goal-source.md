# Native background Goal source boundary

## Observed failure

A completed background assistant turn can be present in native chat history
while the existing Classic page still displays an older user and assistant.
The optional checkpoint armed its continuation from those old display IDs.
Consequently the driver waited forever, without making a dispatch attempt.
An independent initial-round guard also rejected a legitimate request whose
Goal was created more than 30 seconds after the user message.

The failed archive case remains failed. Manual prompts, page reload, focus
activation, artificial state repair, and older prototype results are not
acceptance evidence.

## Candidate contract

1. Mint an unpredictable 192-bit receipt in the same durable transaction as a
   new conversation-bound Goal. Keep it in the private start-receipt ledger;
   do not change tool schemas or accept it as a tool argument.
2. Emit the receipt only in `devspace_goal_start` result content. The MCP
   result's `_meta` is not conversation-visible and is not used as a witness.
3. The existing read-only inspector authenticates a successful native
   start-tool response on the exact current conversation branch. A text
   representation must contain the exact receipt. The observed native API
   representation instead retains structuredContent as code/JSON with no text
   marker: authenticate its canonical start invocation and exact new Goal
   id/conversationId/createdAt tuple against the durable server ledger. Require
   active/working/round-one; never claim its private nonce was in the reply.
   User/assistant echoes, another tool, a broken branch, or a request
   created after receipt issue cannot establish the source.
   An `api_tool` or `api_tool.call_tool` reply additionally needs its exact structured
   `api_tool.call_tool` parent invocation naming `devspace_goal_start`; a
   shell/tool echo or free-form assistant text is not a start invocation.
4. Project native IDs and **public end-turn text only** into an inspection
   snapshot, without mutating the display, composer, focus or navigation.
   Preserve display IDs separately. Never attach old display text to a new ID.
5. A verified native start result correlates the initial user without guessing a short
   wall-clock window. Without it, retain the legacy time guard and native/DOM
   agreement requirements; do not infer authority from a later native user.
6. The exclusive Goal lease, exact page/relay ownership, current native final,
   stream status, safety/error gates and post-send native reconciliation remain
   mandatory. A committed uncertain send must never be replayed.
   A current native public safety-check response also blocks continuation and
   same-round recovery when the existing display has not caught up.
7. Use the shared observed-runtime mapping for both canonical and legacy Main
   ports. Never turn port 19735 into an invented main-10005 or constrain a
   known main-05 to only its static fallback 9735.
8. Missing start evidence cannot arm a stale display. Pending-Goal restart
   recovery uses the same native receipt. Invalid auxiliary receipt data is
   discarded without deleting Goals. Conversation migration clears the old
   receipt rather than transferring it to a different native branch.

## Verification boundary

The regression suite is **fixture evidence**, not real-client acceptance.
The code/JSON structured start tuple and legacy-port failure were observed
using bounded read-only metadata from an independently scoped real native QA
branch, with no reasoning, raw user text or credentials returned. That first
QA work cycle failed an ordinary edit tool chain; it is not three-turn acceptance.
Unsupported host formats fail closed; they must not be accepted by
loosening receipt/origin checks. A direct native read/message tool is used for
QA coordination; it is not counted as the hidden continuation under test.

The initial request must be followed by three independently completed native
assistant turns, actual read/write/edit/command/readback, no additional user
prompt, no manual bind, no foreground input, and a completed Goal. A separate
genuine interrupted-turn Rescue test is also required. Existing GitHub draft
assets and immutable tags are not rewritten for this source candidate.
