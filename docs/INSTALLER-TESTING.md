# Windows installer lifecycle testing

The normal `smoke:package` gate verifies the archive and unpacked executable. The separate Sandbox harness exercises actual NSIS installation without installing anything on the host.

## Prepare on the host

Use the D: build launcher for `smoke:package`. Run the following from the repository with process-local `TEMP`, `TMP` and Electron builder/download caches on D: (the same environment used by that launcher):

```powershell
npm run build:installer-test-baseline
npm run prepare:installer-sandbox
```

The first command packages the existing build with a **synthetic 0.0.4 package version** and the current application identity. It does not change the source version. `release/installer-test-baseline/TEST-ONLY-baseline-0.0.4.exe` is not a historical release and must not be distributed. The current app remains 0.0.5. This verifies installer version replacement, not migration from historical project formats.

The preparation command prints the `.wsb` configuration and results directory. It copies only the two installers, Node executable, test harness, owned fixture and expected hashes into a fresh temporary folder. It does not launch or install them. Open the generated `.wsb` with Windows Sandbox, which must already be enabled; no host feature/security settings are changed by these scripts.

## Isolation and assertions

- Input mapping is read-only. Only a dedicated results folder is writable from the guest. No repository, ignored asset packs or real user profiles are mapped.
- Networking, clipboard, microphone, camera and printer sharing are disabled. Virtual GPU is disabled for this installer-test guest: local comparison reproduced guest Desktop Window Manager crashes with virtual GPU enabled and successful desktop logon with it disabled. Electron runs with software rendering; this is not hardware-GPU performance/parity evidence. Windows manages Sandbox's own system storage; placing staged inputs on D: does not relocate the Windows Sandbox system image off C:.
- The guest script requires the default Sandbox account and expected mapped inputs. Do not run it manually on the host or weaken that guard. Account checking is an accidental-invocation safeguard, not a general virtualization security detector.
- Fresh install is checked for requested installation path, Windows uninstall registration/version and a byte-identical application archive, then startup and Open–Edit–Save are exercised against the installed executable.
- Uninstall must remove the application executable and uninstall registration while preserving an owned project outside the installation tree and recovery snapshots in both profile-name conventions, byte-for-byte.
- A synthetic 0.0.4 install is upgraded to the current installer, with the same archive, registration, smoke and data-preservation checks, then uninstalled.
- Every installer phase is bounded to three minutes and each smoke to one minute. A failure leaves guest state for diagnosis. Result status and completed assertions are recorded in `results/result.json`; smoke output is captured alongside it.

Close Windows Sandbox when inspection is complete to discard the guest. Host staging/results are retained for diagnosis. This harness is separate from the hosted CI job, which currently runs archive and unpacked-app gates only.

## Local attempt — 2026-09-05

The synthetic baseline built successfully and staging completed on D:. The host-account guard was executed and correctly refused to run the guest script. JavaScript syntax, PowerShell parsing, module headers, documentation checks, 22 release-tooling tests and current-package archive validation passed.

The first Sandbox attempt reached an installed executable but failed the harness's uninstall-name assertion: electron-builder defaults to `Canvas Fogworks <version>`, not the bare product name. The assertion was corrected after checking the installed builder's `UNINSTALL_DISPLAY_NAME` definition. This attempt is **not** a passing lifecycle run.

The subsequent Sandbox instance exposed mapped input/results folders but had no active user logon. The documented `wsb exec --run-as ExistingLogin` command returned `0x80070520` even after requesting `wsb connect`. That attempt did not verify the complete lifecycle. Do not weaken the host-account guard or substitute a host installation. No production signing or publisher metadata was changed.

## Passing local lifecycle — 2026-09-07

Controlled diagnosis reproduced guest `dwm.exe` crashes in `udwm.dll` (`0xc00001ad`) with virtual GPU enabled. Two software-rendered diagnostic guests reached a desktop successfully. The generated installer-test configuration now explicitly disables virtual GPU, without changing host drivers or global Windows settings.

An initial software-rendered run exposed a separate harness issue: Windows PowerShell returned a null `ExitCode` after a redirected process had exited successfully. Retaining the process handle before waiting, and omitting `Refresh`, corrected the observation. Guest probes verified both exit 0 and exit 7 before rerunning the complete lifecycle.

The fresh rerun reported `status: passed` with all of these assertions:

- Fresh current-version install, expected registration and exact packaged archive hash.
- Startup and Open–Edit–Save against the installed application.
- Uninstall removed executable/registration and preserved project/recovery bytes.
- Synthetic 0.0.4 baseline installed, then upgraded to 0.0.5 with matching archive and preserved project/recovery bytes.
- Startup and Open–Edit–Save against the upgraded application.
- Final uninstall again removed executable/registration and preserved project/recovery bytes.

Tested installer SHA-256: `0A2641DD9A2E2E075399137390BA5CD97FA3F10662599A17E5F6E53BCCC8F50C`. The local run's results are retained under `D:\dev\Canvas Fogworks-build-temp\fogworks-installer-sandbox-Sxv1jx\results` (result JSON plus four smoke stdout/stderr pairs). The guest is disposable; these host-side results remain after it is closed. The tested installer was not rebuilt by this harness-only change.

This is a software-rendered, per-user, synthetic-upgrade lifecycle pass, not a hardware-GPU or historical-project compatibility certification. The hosted CI job still does not run this Sandbox lifecycle.

The complete sequence passed again for the branded September 7 build, SHA-256 `DF609C8CE900FADDC325497DB46B11D2148EDF83A002EEB1AFD3D37F8CC636EE`. Results are retained under `D:\dev\Canvas Fogworks-build-temp\fogworks-installer-sandbox-wiDays\results`. That build embeds all seven generated icon representations, keeps CompanyName blank and has Authenticode status `NotSigned`. Both test guests were closed after recording results.

## Scope limitations

This does not certify signing/SmartScreen reputation, GUI installer navigation, per-machine elevation, historical project migration or recovery restoration after a crash. Preservation asserts unchanged recovery bytes, not successful recovery UI restoration. The September 7 branding build includes an original vector icon. Personal publisher information and signing are intentionally omitted at the user's request; Windows may identify it as an unknown publisher.

## Verified references

Configuration and mapping behavior follow [Microsoft's Windows Sandbox documentation](https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-configure-using-wsb-file). Silent install/uninstall and the unquoted final `/D=` / `_?=` arguments follow the [NSIS command-line reference](https://nsis.sourceforge.io/Docs/Chapter3.html#installerusage). `/currentuser` and synchronous upgrade-uninstaller handling were checked in the installed electron-builder 26.15.3 NSIS templates. Synthetic version injection follows [electron-builder v26 configuration](https://www.electron.build/v26/docs/configuration/). Redirected-process exit-code behavior was checked against the [PowerShell issue tracker](https://github.com/PowerShell/PowerShell/issues/5421) and reproduced with guest probes before correction.
