# Upstream v1.0.3 validation

Validated 2026-08-13 on macOS. This record reports only checks actually run. The signed application was launched only after source and release gates passed.

| Check | Observed result |
| --- | --- |
| Source tag | v1.0.3 |
| Source commit | `a2c0c59425f9d5d24a6bbf73ee6c6ac3955c3985` |
| Source remote | `https://github.com/chuspeeism/dashi-taskboard.git` |
| Source branch | `feature/apple-light-a`; clean before validation evidence |
| DMG SHA-256 | 9334b422a9b9fed25fb4429d55d2707fb90f2f9758dc094b390999a4ae657fb3 |
| DMG image verification | PASS — `hdiutil verify` reported the checksum VALID |
| macOS signature | PASS |
| Gatekeeper | PASS |
| Signature diagnostic | Read-only revalidation: `codesign --verify --deep --strict --verbose=2`, both `--arch arm64` and `--arch x86_64`, and `stapler validate` passed; `spctl -a -t exec -vv` accepted the mounted app from Notarized Developer ID HUIFANG LIU (Q6HZ9PD6YB). The DMG's own `spctl -t open` reported `Insufficient Context`; this did not affect the mounted app assessment. |
| Node version | `v24.19.0`, an independent Codex runtime referenced as `$CODEX_RUNTIME_NODE` (meets `>=22.5`) |
| `npm ci` | PASS with the independent runtime; 192 packages installed and audited, 0 vulnerabilities |
| `npm run check` | NOT USED AS ACCEPTANCE — it necessarily includes upstream LAN tests that bind `0.0.0.0`; after the recorded historical scope deviation, safety policy prohibits this command for subsequent acceptance. No PASS is claimed for this command. |
| Source acceptance commands | PASS — independent Node `v24.19.0`: `npm run typecheck`; `npm run build`; `node --test --test-name-pattern='health and the default local project are available' test/server.test.mjs`; and `node --test --test-name-pattern='Taskboard fills the workspace, opens HTTPS links and revokes hostile iframe navigation' test/inject-fullheight-regression.test.mjs`. The two test commands bind only temporary `127.0.0.1` listeners. |
| Node test history | Historical scope deviation — an earlier attempted negative test-name pattern unexpectedly ran two `0.0.0.0` LAN tests. Both completed, all processes exited, and no listener remained. It is not credited as an acceptance result. |
| `manage-taskboard` Skill | PASS — source test `node --test test/manage-taskboard-skill.test.mjs`: 2 passed, 0 failed; packaged app includes the bundled Skill at `Contents/Resources/app/skills/manage-taskboard/SKILL.md`. |
| Codex version | 26.803.61601 |
| Independent profile | PASS |
| Sidebar injection | PASS |
| Sidebar visual placement | NOT RUN / OPEN — Round 3's bounded read-only query exposed neither required candidate and cannot prove order. Round 4方案 A was interrupted by the 120-second limit before a new independent target/frame inventory or screenshot was obtained. Round 5 added only the wished-for `entryMountedAfterPlugins` assertion to the existing real-Chromium fixture, but the focused test was interrupted after 268 seconds without output, so no RED was obtained; the unverified assertion was reverted and no GREEN implementation or behavior evidence was committed. Controller cleanup confirmed no Taskboard/Chrome test listener. Existing insufficient negative result: [`evidence/sidebar-order.json`](evidence/sidebar-order.json). |
| Loopback binding | PASS, 127.0.0.1 only |
| Recovery after restart | PASS |
| Data diagnostic path | `~/Library/Application Support/Codex Taskboard` (created by the signed app; contains `taskboard.sqlite`, dedicated `codex-profile`, launcher runtime and client storage) |
| Log diagnostic path | `~/Library/Logs/Codex Taskboard/codex-taskboard-launcher.log` (created by the signed app) |
| Skill diagnostic path | Bundled: `Contents/Resources/app/skills/manage-taskboard/SKILL.md`; no `~/.codex/skills` directory was written |

## Safety policy and next-task acceptance

- User decision: **safety-first continue**. From this point, no acceptance command may bind `0.0.0.0` or exercise LAN behavior. The historical LAN-test scope deviation above is closed; it is never reused as PASS evidence.
- `npm run check` is not a subsequent acceptance command because its upstream script includes the prohibited LAN cases. Use the exact Source acceptance commands table row instead.
- Source-text/grep assertions are not acceptance evidence for Task 2+. Those tasks must use real module/component behavior and browser behavior tests.
- The signed app used `~/Library/Application Support/Codex Taskboard/codex-profile` with `--remote-debugging-address=127.0.0.1` and random ports. First run used service/CDP `57922`/`57923`; the interrupted GUI attempt used port `58607`; the final bounded DOM check used service/CDP `58982`/`58983`. Its JSON result contains no token, task, or thread data. Final controlled cleanup stopped each Taskboard-owned parent/child and closed all these ports before detaching the read-only DMG.

The signed app was launched only after source/signature gates passed. The launch log records the primary renderer as `entryMounted: true`. A temporary `LOCAL-1` task was created via the tokenized local API, observed in `taskboard.sqlite`, then observed again after injector restart. The temporary task remains in the dedicated Taskboard database as recovery evidence. No official Codex/ChatGPT application file was copied, replaced, modified, re-signed, or bypassed.

## Round 5 browser-behavior test attempt

- RED command attempted: `$CODEX_RUNTIME_NODE --test --test-name-pattern='Taskboard fills the workspace, opens HTTPS links and revokes hostile iframe navigation' test/inject-fullheight-regression.test.mjs`. This focused fixture is configured to listen only on temporary `127.0.0.1` ports.
- Actual RED result: **NOT OBTAINED**. The command was interrupted after 268 seconds without test output, so there is no failing assertion result to preserve. The only test edit—the wished-for `entryMountedAfterPlugins === true` assertion—was reverted as unverified.
- GREEN result: **NOT IMPLEMENTED / NOT RUN**. The fixture result was not extended, no production injection code changed, and `docs/qa/evidence/sidebar-after-plugins-browser.json` was not created because no real browser result existed to sanitise.
- Evidence boundary: the earlier signed-app runtime result `entryMounted: true` proves only that an entry mounted in that Codex renderer. It does not prove adjacency to Plugins. The earlier `evidence/sidebar-order.json` remains an audit record of an inconclusive query and is not placement proof. No live screenshot was obtained or claimed.
- Cleanup: the controller confirmed that no Taskboard or Chrome test listener remained. The finding “任务面板入口位于 Plugins 后并与其相邻” remains **OPEN**.
