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

### Native completed-turn ingress (current candidate server wiring)

The physical round boundary is an explicit native completed public assistant
summary/final, not a GUI observation. Both the round-completion guard and
continuation arming use `nativeFinalIngressOnly` in current candidate server
wiring. This source has not yet been deployed/accepted on the original Main.
Legacy inspectors below remain compatibility/history helpers, not permission
to infer a completed round from DOM text, idle, Stop controls, or a report.

- Observe the already-existing native response stream, scoped to the exact
  request, original user message, conversation, local Main and page target.
  Require assistant role, public text, successful native completion and
  `end_turn=true`. Analysis, tool recipients, hidden content, partial messages,
  transport EOF and `[DONE]` are not completion receipts.
- A new-chat request can legitimately lack a conversation ID. Keep only its
  bounded provisional request/source-user metadata until an actual successful
  native response envelope supplies the ID. Never learn it from a page URL,
  quoted message/tool content or another request. Once known, that request's
  conversation ID cannot be replaced by a later envelope.
- Consume the earlier buffered response prefix before subsequently streamed
  bytes and before `loadingFinished` removes the request. Bounded buffering
  drops incomplete evidence on overflow/failure; it never manufactures a final.
- Persist a hashed public-final receipt and an exactly-once assistant ledger.
  A physical final arriving after an optional report preserves its existing
  continuation ID and any unknown delivery lease. No reset/reissue is implied.
- Semantic Goal success, pause and stop remain AI/user-owned state. Unknown
  transport delivery does not decide semantic completion or disable the Goal.
  Exactly-once delivery protection still prohibits blindly replaying an
  unconfirmed side effect; task judgment and transport evidence are separate.

This parser currently accepts complete native message envelopes. Actual
delta-only, resumed/background and cold-client variants require real supported
client validation. Fixture coverage is not evidence that every host variant
emits that envelope or that original Classic hidden delivery is available.

OpenAI's documented component `sendFollowUpMessage` publishes a message and
does not establish this hidden-assistant continuation contract. The documented
MCP Events surface is scoped to Work/Cloud/dots; it must not be substituted for
the original Classic client. A supported hidden sender must be supplied by a
trusted host through an explicit integration; default private SDK closure
access, guessed RPCs, credential extraction and activation bypass are retired.

Primary references consulted:
- https://developers.openai.com/plugins/reference#openaisendfollowupmessage
- https://developers.openai.com/plugins/build/mcp-events
- https://chromedevtools.github.io/devtools-protocol/tot/Network/#method-streamResourceContent

### Historical native-start / inspection compatibility contract

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
4. Historical inspectors project native IDs and **public end-turn text only** into an inspection
   snapshot, without mutating the display, composer, focus or navigation.
   Preserve display IDs separately. Never attach old display text to a new ID.
5. A verified native start result correlates the initial user without guessing a short
   wall-clock window. Without it, retain the legacy time guard and native/DOM
   agreement requirements in the legacy compatibility path; do not infer
   authority from a later native user. The current production round-completion
   ingress above does not use DOM/native agreement to decide whether a round ended.
6. The exclusive Goal lease, exact page/relay ownership, current native final,
   stream status, safety/error gates and post-send native reconciliation remain
   mandatory. A committed uncertain send must never be replayed.
   A current native public safety-check response also blocks continuation and
   same-round recovery when the existing display has not caught up.
7. Use the shared observed-runtime mapping for both canonical and legacy Main
   ports. Never turn port 19735 into an invented main-10005 or constrain a
   known main-05 to only its static fallback 9735. The automatic round guard
   must use that same mapping when recording its native completion proof.
8. Missing start evidence cannot arm a stale display. Pending-Goal restart
   recovery uses the same native receipt. Invalid auxiliary receipt data is
   discarded without deleting Goals. Conversation migration clears the old
   receipt rather than transferring it to a different native branch.
9. A native API 429 is unavailable evidence, not completion. Honor Retry-After
   (seconds or HTTP date) and use a 60-second fallback without a busy retry
   loop. The guard's ordinary observation does not force a native branch read
   merely because a receipt exists; its explicit retry floor still applies.
   Do not cache a positive native boundary for dispatch revalidation.
10. A failed or unavailable post-claim inspection releases only that unsent
    exclusive lease and waits for a fresh settled boundary after bounded
    backoff. It is not evidence of a changed user/final and must not silently
    cancel the round or strand its lease. A genuinely changed final, user,
    Goal control or lease still wins. An exact recovered native final must
    never fall through to the generic empty-baseline final test.
11. A startup/refresh process-inventory timeout cannot remove the known legacy
    Main fallback from discovery or exact runtime filtering. The public static
    port catalog stays unchanged; the observed-runtime path also probes the
    deterministic legacy aliases, still requiring exact conversation/page/relay
    ownership. Missing-arm diagnostics distinguish no exact page, unresolved
    native source and actual rate-limit backoff without returning content.
12. Serialize native API-read admission before the first response can set
    negative backoff. Concurrent inspections receive a distinct unavailable
    busy state, not another caller's positive proof. Release admission on all
    response/error paths and retain a bounded unsent retry floor.

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
