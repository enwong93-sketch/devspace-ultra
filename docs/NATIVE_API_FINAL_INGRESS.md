# Native API final ingress and round admission

## Defects addressed

1. Production accepted only a completed SSE message envelope. A real Classic
   conversation can expose its final through the authenticated native
   conversation branch while the observed stream has a different envelope.
   Native final polling was disabled in that configuration, so an incomplete
   Goal could finish a physical turn without obtaining another round.
2. `GoalRuntime` persisted only part of a stream completion receipt. The host
   bridge subsequently required the omitted port, status, end-turn and public
   final fields. A durable completion was consequently unusable at dispatch.
3. Public continuation admission waited for the *next* assistant final. This
   left that already-running round reported until its end, potentially rejecting
   an AI completion operation unless it called the compatibility round-begin
   tool. Admission now accepts exact native assistant work for an already-issued
   message; admission is not completion and never authorizes another message.

## Authority and safety

- A native API final requires the response's conversation identity, canonical
  current node/message, assistant role, successful native status, explicit
  end-turn, public final text and matching local runtime/page identity.
- Rendered summaries, UI idle, transport EOF, request acknowledgements, missing
  process sessions, optional progress reports and Plan state are not final proof.
- Every public-dispatch boundary is re-read. A request or navigation arriving
  during the read invalidates that sample. Provisional first-chat requests fence
  the previous page even before a native conversation ID is available.
- An already-issued public message can begin its working round only with its
  exact source-message hash, previous-final parent, new source user, native
  assistant work, runtime/page and durable dispatch correlation. A new user or
  Rescue request alone does not redeem it. No sender is retried for this admission.
- Semantic Goal completion remains AI-owned and requires every criterion's
  evidence. An optional checkpoint cannot forbid completion. Pause, stop,
  collisions, consumed finals and issued-message deduplication remain protected.
- Full final receipts survive persistence. Older stripped receipts can be
  refreshed from the same freshly verified final without consuming it twice,
  resetting its original completion clock or replaying an issued message.

## Bounded operation

The native-only guard visits at most four active Goal conversations per poll,
with a ten-second per-round read interval. Native conversation reads have a
five-second network budget and a bounded observer budget. Read failures remain
unavailable evidence, not terminal work or permission to send. Current native
request `wallTime` avoids treating delayed observer delivery as a later physical
start. Stream finals still take the immediate existing ingress path.

## Verification boundary

Regression coverage includes receipt persistence, API-only continuation with
contradictory DOM hints, incomplete/failed/foreign branches, late-read races,
provisional requests, bounded retries, three fixture rounds with AI-owned
completion, receipt refresh and optional-checkpoint completion.

A separate single read-only check accepted a real original conversation's
current native API final and left its production Goal unchanged. It sent no
message and constructed no production `GoalRuntime`.

These are source/contract regressions and real input readback, **not** proof that
the candidate archive has delivered repeated automatic Classic turns, automatic
Rescue or safe repeated Core replacements. Keep release promotion subject to
the actual archive's real-client continuity acceptance. Do not deploy by hot
patching a running Core or alter production Goal/dispatch journals to test it.
