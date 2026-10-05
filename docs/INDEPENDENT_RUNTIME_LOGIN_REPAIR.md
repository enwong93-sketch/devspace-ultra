# Independent runtime login repair

An authenticated secondary Main using an observed legacy debug port was skipped
by session-source discovery, which probed only its canonical static port. Setup
then fell back to the canonical Primary's locked cookie database and requested
manual authentication despite an available signed-in source.

Discovery now reads the selected package's actual root-process debug port and
requires a loopback listener owned by that exact PID before probing login
health. Static fallback remains available only when no port was specified and
the same process owns that listener. Foreign listeners, public bindings,
malformed ports and stopped packages cannot become credential sources.

The repair retains the existing allowlisted, in-memory session transfer. Source
discovery does not read cookie values. The transfer logs counts and booleans,
never secret values. No canonical Primary restart is needed when that secondary
source is available.

Minimized startup now requires the independent process and local verification
port without requiring a visible window. Cold authentication verification waits
for page/session readiness within the existing verification interval. A disabled
composer during assistant work is not logout and must not trigger reseeding.
Expired-account state is included in the compact authentication probe.

PowerShell 5.1 and 7 regressions cover legacy ports, exact PID/loopback ownership,
invalid/missing ports, stopped sources, minimized readiness, cold loading,
active-work authentication and account expiry. Real isolated-runtime login and
restart persistence passed without changing the canonical Primary PID.

This is real login/persistence evidence, not automatic Goal continuation or
production-Core replacement acceptance. Native completed assistant turns and
actual subsequent work remain required for those claims.
