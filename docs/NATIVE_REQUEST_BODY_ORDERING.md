# Native request-body ordering

The passive Classic observer must obtain the exact source user from the native
request, not the page URL, an idle UI, transport EOF or a previous summary.

`Network.requestWillBeSent` can report `hasPostData: true` without including
`postData`. Recover only that observed allowlisted POST via the standard
`Network.getRequestPostData` command. No request is replayed or sent to ChatGPT.
Reference: https://chromedevtools.github.io/devtools-protocol/tot/Network/

While the body lookup is pending, immediately invalidate older final authority
and retain bounded response/EOF metadata in wire order. A newer native request,
navigation, disconnect, failure, malformed body or metadata overflow abandons
the lookup. A delayed reply cannot revive that former native source.

Eight deterministic regressions cover completion and those failure/supersession
boundaries. They validate correlation and ordering only: they do not establish
the cause of an existing production stall or real-client automatic continuation.

The v0.5.23 candidate includes this patch after the immutable v0.5.22 draft.
The older draft archive and its package-validation evidence describe its
tagged source, not this later patch.
Stable promotion still requires actual Classic client acceptance on the exact
archive being promoted. Transport uncertainty remains a delivery state, not an
automatic semantic Goal-block decision.
