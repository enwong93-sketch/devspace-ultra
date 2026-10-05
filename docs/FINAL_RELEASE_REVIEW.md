# Final source review

Reviewed on 2026-10-04. This review covers the native Goal continuation candidate
and two backend resource fixes found during the final pass.

## Fixes verified by regressions

- An unchanged Rescue/native-final wait previously rewrote the complete
  continuation journal on every check. Sixty checks now produce one durable
  transition instead of sixty writes. A failed write remains retryable, and
  the next round still waits for the current native assistant final.
- Failure during `Network.enable` or `Page.enable` previously left the observer
  socket open without returning a session to its polling owner. Both failure
  paths now close the socket before retry. Three attempts per failure path
  each close exactly one socket.
- The native-final/public-message suites pass all 56 tests, including the four
  new regressions. The new regressions failed against the preceding source.
- Full local `npm run build` passed in 140.51 seconds. Public-release checks,
  continuity regressions and release-promotion checks also passed.

These are deterministic operation counts, not a production latency benchmark
or evidence that the original client stall has been repaired.

## Release scope

The PR includes native completed-turn ingress, omitted-request-body ordering,
one-shot public continuation claims, Rescue/next-round arbitration, retained
process-work checks during Core retirement, and installer byte consistency.

The existing v0.5.23 tag and draft archive predate these final resource fixes.
Their hashes and package validation remain historical evidence for those
exact bytes; they do not validate the newer PR source. Do not overwrite them
or attach their validation to a different archive.

## Outstanding stable acceptance

The current source consumes correlated native response envelopes. WebSocket
tool observation alone does not establish a current assistant final. The
original client's completed-turn ingress and actual automatic next-round
work still need to be observed on the release archive.

The source review and CI can be reviewed on GitHub now. Stable promotion still
requires the real-client checks in [continuity acceptance](CONTINUITY_ACCEPTANCE.md):
automatic consecutive rounds, automatic Rescue, repeated safe Core replacement,
and installation/update of the exact accepted archive. Do not fabricate that
attestation or treat operator messages as automatic continuation.

Protocol references: [Chrome Network domain](https://chromedevtools.github.io/devtools-protocol/tot/Network/)
and [OpenAI component bridge](https://developers.openai.com/plugins/reference).
