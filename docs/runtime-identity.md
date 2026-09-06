# ChatGPT Classic Runtime Identity Safety

Status: **Introduced in DevSpace Ultra v0.4.0; maintained in current v0.5.0**. Windows-only ChatGPT Classic package-identity layer.

DevSpace Ultra creates isolated ChatGPT Classic AppX **Worker** packages and separate user-facing **Interactive/Main** packages. Neither role may become a global substitute for the user's canonical Primary/Main-01 installation.

## Identity invariants

Worker manifests use unique package/display/alias identities and remove Primary-only global launch surfaces:

- dedicated AppX `Application Id` `DevSpaceWorker`; only Primary keeps `Application Id="ChatGPT"`, so worker AUMIDs never end in `!ChatGPT`;
- no `chatgpt://` protocol registration;
- no ChatGPT startup task;
- no Copilot-key provider app extension;
- hidden from the normal Windows application list;
- only an explicit worker alias such as `chatgpt-classic-worker05.exe` remains for DevSpace lifecycle control.

The Primary app remains the only package allowed to own the canonical `!ChatGPT` AUMID or global `chatgpt://` association. DevSpace does not edit or forge the Windows Default Apps `UserChoice` hash. Windows protects default-app choices and requires the system UI for user changes; DevSpace instead detects stale/unknown `UserChoice` ProgIDs explicitly and removes secondary-runtime activation identities that could make such stale state dangerous.

## Multi-Main / Interactive identity

v0.4.0 adds a second role to the shared runtime provisioner:

- `role=worker` keeps the existing hidden `OpenAI.ChatGPT-Desktop.WorkerNN` + `DevSpaceWorker` identity;
- `role=interactive` creates visible `OpenAI.ChatGPT-Desktop.InteractiveNN` packages labelled `Main-NN` with `Application Id="DevSpaceInteractive"`;
- `Main-01` is never provisioned by this path; it is always the canonical installed `OpenAI.ChatGPT-Desktop` Primary;
- Main-02+ have independent AppX package data/profile paths and independent root processes/windows;
- Main-02+ remove `chatgpt://`, startup, and Copilot-key extensions just like Workers, but **are not hidden from the app list**;
- Main-02+ use explicit aliases such as `chatgpt-classic-main02.exe` and never reuse `chatgpt-classic-workerNN.exe`;
- Worker controller state, elastic scaling, stop/recovery/minimize, Worker auto-join, update rollout, and managed Auto Compact never own Interactive runtimes.

`chat-swarm-classic-runtime-identity.ps1` audits Interactive packages separately under `Interactives` and publishes `InteractiveIsolationSafe`. The identity guard may report a bad Interactive protocol claim, but there is intentionally no `Repair-InstalledInteractives` loop: user-facing Main runtimes are audited, not automatically recycled.

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

### First-use Interactive authentication

Interactive setup uses an ordered local session-source pool. A verified signed-in secondary Main is preferred first because it exposes a dedicated Interactive CDP port and can seed a new Main entirely in memory. A verified signed-in Worker CDP runtime is the next zero-interruption source. Only after those sources are unavailable does DevSpace fall back to canonical Main-01's encrypted profile.

Session-source eligibility is based on authentication health, not turn idleness. ChatGPT temporarily marks the composer disabled while a signed-in Main or Worker is generating; that state must **not** disqualify the runtime as a read-only CDP Session Seed source. v0.5 live acceptance caught the old false-negative because Main-02/Main-03 were both busy, which incorrectly exhausted the zero-interruption source pool and reached the Primary fallback. The gate now ignores `composerDisabled` for source discovery while still requiring a composer to exist, no login UI, and no expired-account signal. A subsequent Main-04 reseed live gate selected `Main-02` through `cdp-session-seed` with `PrimaryRestarted=false` and identical Main-01 PID before/after.

`chat-swarm-classic-auth-seed.mjs` can take a consistent encrypted SQLite snapshot without decrypting or printing authentication values. The Main-02 live gate discovered an important Windows behavior: the canonical Store-packaged Main-01 process can keep its Cookies database under an exclusive file-sharing lock (`0x80070020`) while it is running. The approved v0.4.0 zero-login policy therefore permits one **controlled canonical Primary close → encrypted snapshot → relaunch → signed-in composer verification** when the online Primary snapshot is blocked and no CDP source exists. The operation is fail-closed: `PrimaryRestarted=true` can be reported as successful only when `PrimaryRestored=true` and canonical Main-01 is visible/signed in again. Secondary Mains and Workers are never stopped by that helper.

CDP Session Seed remains allowlisted to ChatGPT/OpenAI cookies and never logs values. The helper waits through a bounded persistence-settle interval after target verification, then re-probes before returning success; this fixed the first Main-03 live gate where the in-memory login worked immediately but an instant forced restart occurred before Chromium had durably flushed the target profile.

`chat_main_runtime_authenticate` is now only the cold-start fallback when no verified local signed-in source can complete zero-login transfer. Use `stage=start` to move only the selected Main into Google/browser authentication and return immediately so the user can choose/confirm the account. After the browser reaches ChatGPT's `auth/open_in_desktop` completion page, use `stage=finish`. DevSpace reconstructs the expected Windows callback form (`chatgpt://oauth_complete/...`) from the completion URL in memory, restricts the callback path to the Windows `openai-sidetron` auth route, and launches the **explicit selected Main alias** with that one-time callback. It never rewrites Windows `UserChoice`, never gives Main-02+ global `chatgpt://` ownership, and never prints/persists the callback code/state.

After the selected Main passes the signed-in UI gate, DevSpace records only non-secret provenance such as `cdp-session-seed`, `primary-online-snapshot`, `primary-controlled-snapshot`, `oauth-relay`, or `verified-existing-session`. Later launches use that Main's own independent profile. `chat_main_runtime_open` is the high-level one-command agent surface; with no `mainNumber`, it chooses the lowest free Main-02..Main-32. `chat_main_runtime_manage` handles show/restore/minimize/stop/status by the selected Interactive package/process identity rather than a generic ChatGPT process name.

The Session Seed helper and Interactive relay scripts are included in the v0.4.0 public package. Authentication values are never written into DevSpace controller state, repository files, normal logs, or provisioning markers.

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

Create/launch Main-02 through the dedicated Interactive manager:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/chat-classic-interactive-runtime.ps1 -Action setup -MainNumber 2
```

Read-only Multi-Main status is available through `chat_main_runtime_status`; normal agent UX should prefer `chat_main_runtime_open` for “open another Main.” If every local zero-login source fails and setup returns `interactive-auth-required`, call `chat_main_runtime_authenticate` with `stage=start`, complete the browser account step, then call it again with `stage=finish`. `chat_main_runtime_live_gate` restarts **only the selected secondary Main** to verify independent session persistence. For ordinary CDP-seed paths it asserts Main-01 stayed on the same PID/window; controlled-Primary fallback paths instead require explicit verified Primary restoration evidence.

Cross-platform static regression:

```bash
npm run verify:runtime-identity
```

The v0.3.1 live gates verified both a fresh signed-out worker and a stale expired-session worker. The latter initially remained logged out when new cookies were layered over stale target cookies, then passed immediately after the allowlisted target-cookie replacement rule was added. The protected source interactive runtime kept the exact same PID/window throughout.

The final identity gate on 2026-09-03 migrated Worker01–07 and Worker30–32 to `!DevSpaceWorker` while preserving the exact pre-migration profile file-count/byte baselines and keeping the active Primary on the same PID/window. Direct Windows activation of the old `Worker32!...!ChatGPT` AUMID failed while the new `Worker32!...!DevSpaceWorker` AUMID launched correctly; the former Worker04 `!...!ChatGPT` AUMID also failed to launch. This proves legacy pins/AUMID activation cannot reopen a worker as the apparent Primary after migration.
