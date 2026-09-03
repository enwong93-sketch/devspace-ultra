# ChatGPT Classic Runtime Identity Safety

Status: **DevSpace Ultra v0.3.1**. Windows-only desktop-worker layer.

DevSpace Ultra creates isolated ChatGPT Classic AppX worker packages. A worker must never become a global substitute for the user's Primary ChatGPT installation.

## Identity invariants

Worker manifests use unique package/display/alias identities and remove Primary-only global launch surfaces:

- dedicated AppX `Application Id` `DevSpaceWorker`; only Primary keeps `Application Id="ChatGPT"`, so worker AUMIDs never end in `!ChatGPT`;
- no `chatgpt://` protocol registration;
- no ChatGPT startup task;
- no Copilot-key provider app extension;
- hidden from the normal Windows application list;
- only an explicit worker alias such as `chatgpt-classic-worker05.exe` remains for DevSpace lifecycle control.

The Primary app remains the only normal ChatGPT launcher and the only package allowed to own the canonical `!ChatGPT` AUMID. DevSpace does not edit or forge the Windows Default Apps `UserChoice` hash. Windows protects default-app choices and requires the system UI for user changes; DevSpace instead detects stale/unknown `UserChoice` ProgIDs explicitly and removes every worker-side activation identity that could make such stale state dangerous.

## Legacy-worker migration

Older DevSpace Ultra worker clones may have been registered before these manifest restrictions existed. `chat-swarm-classic-runtime-identity.ps1` audits both the on-disk manifest and Windows' currently registered AppX state.

- inactive dirty workers are re-registered with the sanitized manifest and `DevSpaceWorker` Application Id;
- re-registration of loose-file worker packages uses `-PreserveApplicationData`, retaining the isolated ChatGPT package/profile data;
- running dirty workers are **never terminated for migration**; their manifest is prepared and the migration is marked `pending-running`;
- a repeating deferred-heal scheduled task retries later and completes the registration migration only after the user/runtime has naturally closed;
- a temporary protection created for a misrouted interactive worker is removed only after the worker is stopped and its registered identity is clean.

## Protected interactive runtimes

Controller state version 5 supports `protectedWorkers` plus per-worker protection metadata. Protection is enforced at the lowest destructive `Stop-WorkerRuntime` path and also at higher lifecycle surfaces. A protected runtime is excluded from:

- stop, repair and recover;
- automatic minimize/navigation/ensure mutation;
- auto-join and setup replacement;
- elastic production selection and scale-down;
- update canary/rolling update targets;
- filesystem/session-seed source shutdown;
- managed Auto Compact rotation.

This prevents an interactive user conversation from being destroyed even if Windows or a legacy association launches it inside a worker package.

## Logon/boot guard

`DevSpace-ChatGPT-Primary-Identity-Guard` runs at user logon. It audits the current `chatgpt://` owner against the currently registered Primary/worker protocol claims. The result is classified as `primary-current`, `worker-current`, `worker-stale`, `primary-stale`, `stale-unknown` or `unassigned`; a stale/unknown ProgID is never silently treated as healthy. If a legacy worker is identifiable as the protocol owner and that worker is running, DevSpace protects it instead of killing it, then explicitly activates the Primary ChatGPT alias when needed.

`DevSpace-ChatGPT-Worker-Identity-Heal` runs on a low-frequency repeating schedule. It only migrates dirty workers that are already stopped. Running workers remain untouched.

The controller `setup`, `start` and `scale` actions ensure these tasks exist, making the repair mechanism self-installing rather than a one-time local fix.

## Session Seed replaces filesystem login guesses

The old approach treated the existence of Chromium `IndexedDB` as proof that a worker was logged in. That is not reliable: expired sessions can retain all profile files.

v0.3.1 uses CDP UI verification and **Session Seed** instead:

1. target worker starts with its own isolated profile and CDP port;
2. DevSpace verifies whether the target is actually signed in (`composer` available and login UI absent);
3. if not, DevSpace finds another currently running, CDP-enabled, verified signed-in runtime;
4. `Network.getAllCookies` reads that source session in memory;
5. DevSpace deletes only the target worker's existing ChatGPT/OpenAI-domain cookies, preventing expired target cookies from conflicting with the verified source session;
6. only allowlisted ChatGPT/OpenAI-domain cookies are transferred with `Network.setCookies` to the target;
7. cookie values are never printed, logged, written to controller state or copied into the repository;
8. target reloads and must pass the signed-in UI verification before lifecycle recovery/auto-join proceeds.

A protected runtime may be used as a **read-only** seed source. Session seeding does not stop, navigate or modify the source runtime.

## Operator commands

Read-only audit:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/chat-swarm-classic-runtime-identity.ps1 -Action audit
```

Safe repair (running dirty workers become `pending-running`):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/chat-swarm-classic-runtime-identity.ps1 -Action repair
```

Install/refresh persistent logon + deferred-heal tasks:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/chat-swarm-classic-runtime-identity.ps1 -Action install-guard
```

Cross-platform static regression:

```bash
npm run verify:runtime-identity
```

The v0.3.1 live gates verified both a fresh signed-out worker and a stale expired-session worker. The latter initially remained logged out when new cookies were layered over stale target cookies, then passed immediately after the allowlisted target-cookie replacement rule was added. The protected source interactive runtime kept the exact same PID/window throughout.

The final identity gate on 2026-09-03 migrated Worker01–07 and Worker30–32 to `!DevSpaceWorker` while preserving the exact pre-migration profile file-count/byte baselines and keeping the active Primary on the same PID/window. Direct Windows activation of the old `Worker32!...!ChatGPT` AUMID failed while the new `Worker32!...!DevSpaceWorker` AUMID launched correctly; the former Worker04 `!...!ChatGPT` AUMID also failed to launch. This proves legacy pins/AUMID activation cannot reopen a worker as the apparent Primary after migration.
