# Moved-conversation reconciliation

A durable continuation can retain a physical Main/page locator after the same
conversation moves following restart. Inspecting only the disappeared page
leaves its unknown dispatch quarantined forever, even when a newer user turn
has completed in the same native branch.

The repair performs an unpinned exact-conversation lookup for reconciliation
only. It requires one local page, matching runtime/port identity, the old source
user and assistant baseline in the native branch, and a newer successful public
assistant end_turn after a different user. Native current/latest message IDs,
statuses and timestamps must agree. Display labels, generating flags and HTTP
stream closure do not establish this boundary.

For a forked canonical branch, both old anchors must still exist in the same
native conversation. The bounded old-baseline subtree must be complete and
contain exactly one terminal leaf: the original successful assistant final,
with no descendants. An active/unknown old branch cannot be rebased. The newer
canonical user/final must still pass all fresh native checks.

The native boundary is read twice and the Goal/continuation is checked again.
Missing, ambiguous, active, stale, safety-blocked or changed evidence defers.
External-user provenance is persisted before accounting is reconciled, so a
restart between the two writes cannot turn that progress into an automatic
delivery claim. Original Goal creation time/objective and the historical
dispatch locator are preserved. The old unknown send is never replayed.

This fixes bookkeeping recovery. Source tests are not proof that the original
client has resumed or that a new automatic round has executed. Deployment and
real native/tool work are separate required checks.
