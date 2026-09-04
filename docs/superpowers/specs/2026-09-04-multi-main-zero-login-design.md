# DevSpace Ultra Multi-Main Zero-Login Design

**Date:** 2026-09-04

**Status:** Approved design captured after the Main-02 live gate

## Goal

Make user-facing ChatGPT Classic Main runtimes a first-class DevSpace Ultra role. The user should be able to tell an agent to open another Main and have DevSpace provision, authenticate, launch, show, restore, minimize, and stop Main-02+ without treating any Main as Worker capacity and without asking the user to sign in to every new Main.

## Scope

This design covers secondary user-facing ChatGPT Classic runtimes on Windows:

- Main-01 remains the canonical installed `OpenAI.ChatGPT-Desktop` Primary.
- Main-02 through Main-32 are independent `interactive` runtimes.
- The same role-aware AppX provisioner may create Workers and Interactive runtimes, but their identities and lifecycle controllers remain separate.
- Authentication inheritance is generalized so a newly created Main normally becomes signed in without user interaction.
- A bounded OAuth flow remains only as a cold-start fallback when no signed-in local source exists.
- Global `chatgpt://` ownership remains canonical Main-01 only.

This design does not merge secondary Mains into Chat Swarm Worker capacity, elastic scaling, Worker auto-join, Worker recovery, Worker update rollout, or managed Auto Compact.

## Existing live-gate baseline

The v0.4.0 working tree already established the role boundary and proved Main-02 live:

- role module identity: `OpenAI.ChatGPT-Desktop.InteractiveNN` / `DevSpaceInteractive` / `chatgpt-classic-mainNN.exe`;
- Interactive profiles live under their own AppX package family path;
- Interactive manifests remove `windows.protocol`, `windows.startupTask`, and `windows.appExtension`, while remaining visible in the Windows app list;
- Main-02 was independently authenticated, restarted on a new PID, and verified signed in after restart;
- Main-02 was not present in Worker controller state and was not Auto Compact or Chat Swarm managed;
- the canonical Main-01 process/window stayed untouched during the original Main-02 acceptance gate.

The original gate also exposed a Windows limitation: canonical Main-01 can hold Chromium's Cookies database with an exclusive sharing lock (`0x80070020`), so an external SQLite reader cannot reliably snapshot that database while Main-01 is running.

## Runtime identity model

`dist/chat-classic-runtime-role.js` is the source of role identity.

### Primary

Main-01 is never cloned or reprovisioned by the Interactive manager. It is the canonical installed package:

- package: `OpenAI.ChatGPT-Desktop`
- application ID: `ChatGPT`
- global `chatgpt://` owner: yes

### Interactive

For Main-NN, NN = 02..32:

- role: `interactive`
- runtime ID: `interactive-NN`
- label: `Main-NN`
- package: `OpenAI.ChatGPT-Desktop.InteractiveNN`
- application ID: `DevSpaceInteractive`
- alias: `chatgpt-classic-mainNN.exe`
- runtime root: `ChatGPT-Classic-Interactive-Runtimes`
- visible in Windows app list: yes
- Worker managed: no
- global protocol owner: no

### Worker

Worker identity remains unchanged from the role-aware provisioner:

- role: `worker`
- `OpenAI.ChatGPT-Desktop.WorkerNN`
- `DevSpaceWorker`
- hidden from normal app list
- Worker controller managed

Interactive and Worker package namespaces must never overlap.

## Agent-facing lifecycle

The target UX is an intent-level operation, not a collection of manual operator steps. A request such as "開多一個 Main" should let DevSpace select the next available secondary Main and drive the entire lifecycle.

The Interactive runtime manager remains the low-level implementation surface, while MCP tools expose agent-facing operations.

Required lifecycle behavior:

1. **Inspect** the requested or next-free Main number.
2. **Provision** the isolated Interactive package if absent.
3. **Authenticate automatically** from the best verified signed-in source.
4. **Launch** the selected Main with its dedicated local CDP port.
5. **Verify** a real user-facing window and signed-in composer.
6. **Return** stable runtime metadata, including number, PID, profile, provisioning mode, and isolation gates.
7. Later agent requests may **start/show/restore/minimize/stop** only that Interactive runtime.

The user must not need to know AppX package names, profile paths, CDP ports, or OAuth relay mechanics.

## Authentication source pool

Authentication is a source-selection problem, not a Main-01-only copy operation.

A new target Main uses the following ordered source pool.

### Priority 1: already-signed-in Interactive Main via CDP

If Main-02+ is already running, exposes its dedicated CDP port, and passes the signed-in UI probe, use `chat-swarm-classic-session-seed.mjs` to transfer only allowlisted ChatGPT/OpenAI cookies into the target runtime.

This is the preferred path because it is:

- zero-interruption;
- already proven by the Worker Session Seed implementation;
- in-memory through CDP;
- independently verifiable on the target;
- free from canonical Main-01's SQLite sharing lock.

No cookie values may be logged or persisted by DevSpace.

### Priority 2: other verified CDP source

A verified signed-in CDP Worker may be used as a read-only source when appropriate. Source selection must never stop, navigate, minimize, or otherwise mutate the source merely to seed the target.

Interactive sources are preferred over Workers because the user-facing Main pool is the intended continuity source for new Main creation.

### Priority 3: canonical Main-01 profile snapshot

If no signed-in CDP source is available, DevSpace may seed from canonical Main-01's profile.

First attempt the non-disruptive encrypted SQLite/profile snapshot path. If the source opens successfully, provision the target and verify its signed-in UI.

If Main-01's Chromium Cookies database is locked, DevSpace is allowed to perform a **controlled Primary snapshot cycle** because the user explicitly approved this behavior for zero-login Multi-Main UX:

1. capture Main-01 package, PID, window, and signed-in baseline;
2. close Main-01 in a controlled manner;
3. wait until the profile database lock is released;
4. take the encrypted profile/session snapshot without decrypting or logging secrets;
5. relaunch canonical Main-01;
6. verify Main-01 is visible and signed in again;
7. seed/launch the target Main;
8. verify the target signed-in composer.

A controlled restart is a fallback, not the first choice. It must occur only when no zero-interruption signed-in source exists and the Main-01 profile is the remaining local session source.

If the Primary cannot be restored and verified, the operation fails closed and reports the Primary recovery state instead of continuing to create more Mains.

### Priority 4: bounded OAuth cold start

OAuth is the last fallback only when there is no usable signed-in local source.

The existing explicit-target OAuth relay is retained:

- `stage=start` opens the selected Main's browser authentication and returns;
- `stage=finish` relays the completed one-time desktop callback to the explicit target alias;
- `stage=full` remains available where a single blocking call is acceptable.

The relay must never rewrite Windows `UserChoice`, give a secondary Main global `chatgpt://` ownership, or persist/print callback code/state.

After one secondary Main is authenticated, later Mains should normally inherit from that signed-in Interactive source, so the user does not repeat OAuth per Main.

## Source selection contract

The source selector returns structured, non-secret metadata:

- source role (`interactive`, `worker`, or `primary-profile`);
- source label/runtime number when applicable;
- source transport (`cdp-session-seed`, `profile-snapshot`, or `controlled-primary-snapshot`);
- whether source interruption was required;
- whether the target was verified signed in.

It never returns cookies, OAuth callbacks, access tokens, or other secret material.

Source candidates must pass a real signed-in probe before use. A stale, expired, or login-visible source is skipped.

## Interactive manager behavior

`scripts/chat-classic-interactive-runtime.ps1` remains responsible for one selected Main and gains generalized source selection rather than assuming Main-01 profile seeding.

The manager must:

- support Main-02..Main-32;
- keep Interactive lifecycle completely outside Worker controller state;
- refuse profile reseeding while a target Main is running unless the operation explicitly closes only that target;
- preserve an independently authenticated target profile across later starts;
- expose `ProvisioningMode` that identifies the actual successful path;
- make Primary interruption explicit in status when the controlled snapshot fallback was used;
- verify manifest isolation on every setup/live gate.

`Main01Unchanged` remains meaningful for operations that do not request a controlled Primary snapshot. Operations that intentionally use the controlled fallback instead publish a Primary restart/restore result rather than falsely requiring the PID to remain identical.

## MCP surface

The existing tools remain useful low-level surfaces:

- `chat_main_runtime_status`
- `chat_main_runtime_setup`
- `chat_main_runtime_authenticate`
- `chat_main_runtime_start`
- `chat_main_runtime_live_gate`

The product-level surface should additionally support agent-managed lifecycle without manual number selection. The recommended contract is a single orchestration tool that can accept an optional Main number and otherwise selects the next available secondary Main.

It should support intent actions such as:

- `open` — provision/authenticate/start/show and verify;
- `show` / `restore` — bring an existing Main window to the user;
- `minimize` — minimize only the selected Main;
- `stop` — stop only the selected Main;
- `status` — report one or all Interactive Mains.

The orchestration layer delegates to the same role-aware provisioner and Interactive manager; it must not duplicate AppX mutation logic.

## Window ownership

Interactive window operations identify the selected Main by its package/executable identity. They must never target a generic `ChatGPT Classic.exe` process name alone.

Showing/restoring/minimizing Main-NN may change only the selected Interactive package's root window. Main-01 and other secondary Mains remain unaffected.

## Global `chatgpt://` ownership

Only canonical Main-01 may own the Windows global `chatgpt://` protocol.

Workers and Interactive packages remove the protocol extension from their manifests. OAuth relay to a selected secondary Main uses its explicit execution alias and therefore does not depend on Windows default protocol routing.

The known stale Windows `UserChoice` state is a separate repair task. DevSpace must use supported Windows association mechanisms and must not forge or directly overwrite the protected `UserChoice` hash.

Acceptance requires the runtime identity audit to report:

- `WorkerIsolationSafe=true`;
- `InteractiveIsolationSafe=true`;
- `ProtocolCanonical=true`;
- canonical Main-01 as the active global protocol owner.

## Persistence and secrets

DevSpace may persist only non-secret Interactive provisioning metadata under the existing local Interactive state root.

Allowed metadata includes:

- runtime ID/label/package family;
- source role/label;
- provisioning mode;
- timestamp;
- independent-profile flag;
- Primary restart/restore result when applicable.

Forbidden persisted/logged material includes:

- cookie names/values beyond aggregate counts already used by the secure Session Seed gate;
- OAuth callback `code`/`state`;
- access/refresh tokens;
- account credentials;
- copied raw authentication databases inside the repository or DevSpace controller state.

## Failure handling

The orchestration fails closed at the first unverifiable boundary.

Examples:

- no source passes signed-in probe → use OAuth cold-start or return auth-required;
- CDP seed fails target verification → do not mark the Main ready;
- controlled Primary snapshot cannot restore Main-01 → report Primary recovery failure and stop;
- target process starts without a visible window/CDP port → fail setup;
- target window is visible but composer/login probe is not signed in → do not persist a ready marker;
- manifest isolation is dirty or Interactive appears in Worker controller state → fail the gate.

## Tests and live acceptance

Static/unit coverage must verify:

- role identity separation;
- source priority ordering;
- no secret output/persistence;
- Interactive never enters Worker controller management;
- controlled Primary restart is used only after zero-interruption source paths are unavailable;
- operations that do not restart Primary still enforce unchanged-Primary behavior;
- operations that do restart Primary require successful restore verification;
- agent orchestration chooses a free Main number and delegates to the role-aware manager;
- global protocol ownership remains Primary-only.

Live acceptance must create a **new Main-03 or later** from an already signed-in source without asking the user to sign in again, then:

1. verify Main-01 and existing Main-02 remain healthy;
2. verify the new Main has its own package/profile/root PID/window;
3. verify signed-in composer;
4. restart only the new Main and verify session persistence;
5. exercise show/restore/minimize/stop on the new Main;
6. verify Worker controller/Auto Compact/Chat Swarm do not own it;
7. run the runtime identity audit and protocol canonical gate.

The acceptance result is based on observable process/window/CDP/UI evidence, not on provisioning command success alone.

## Release boundary

The current target remains DevSpace Ultra v0.4.0. No public release, tag, or push is part of this design until the new Multi-Main live gate, protocol-canonical gate, package dry-run, secret/path scan, and full `verify:ultra` suite pass.