# Windows installer lifecycle testing

The normal `smoke:package` gate verifies the archive and unpacked executable. The separate Sandbox harness exercises actual NSIS installation without installing anything on the host.

## Prepare on the host

Use the D: build launcher for `smoke:package`. Run the following from the repository with process-local `TEMP`, `TMP` and Electron builder/download caches on D: (the same environment used by that launcher):

```powershell
npm run build:installer-test-baseline
npm run prepare:installer-sandbox
```

The first command packages the existing build with a **synthetic 0.0.4 package version** and the current application identity. It does not change the source version. `release/installer-test-baseline/TEST-ONLY-baseline-0.0.4.exe` is not a historical release and must not be distributed. The current app remains 0.0.5. This verifies installer version replacement.

The preparation manifest also stages `historical-release-0.0.4.vde`. That file is an owned project whose envelope is the legacy app-version stamp `0.0.4`, the on-disk format those releases wrote and which the loader still accepts as schema 1. It is not a historical installer binary. After each current-version install, the guest opens that file in the installed executable, saves it, and requires the current document schema plus the original rectangle.

The preparation command prints the `.wsb` configuration, the results directory, `OPERATOR.txt`, `evidence-plan.json`, the host hardware-GPU command, and the evidence-checker command. It copies the two installers, Node executable, test harness, owned fixture, historical project and expected hashes into a fresh temporary folder. It does not launch or install them. Open the generated `.wsb` with Windows Sandbox, which must already be enabled; no host feature/security settings are changed by these scripts. `OPERATOR.txt` is the pass/fail runbook for that staging folder. It is not itself a Sandbox result.

## Isolation and assertions

- Input mapping is read-only. Only a dedicated results folder is writable from the guest. No repository, ignored asset packs or real user profiles are mapped.
- Networking, clipboard, microphone, camera and printer sharing are disabled. Virtual GPU is disabled for this installer-test guest: local comparison reproduced guest Desktop Window Manager crashes with virtual GPU enabled and successful desktop logon with it disabled. Electron in this guest runs with software rendering. That guest result is not hardware-GPU evidence. Hardware evidence is `npm run validate:hardware-gpu` on the host, which draws one WebGL frame and passes only for a hardware adapter. SwiftShader, llvmpipe and the Microsoft Basic Render Driver do not pass. Windows manages Sandbox's own system storage; placing staged inputs on D: does not relocate the Windows Sandbox system image off C:.
- The guest script requires the default Sandbox account and expected mapped inputs. Do not run it manually on the host or weaken that guard. Account checking is an accidental-invocation safeguard, not a general virtualization security detector.
- Fresh install is checked for requested installation path, Windows uninstall registration/version and a byte-identical application archive, then startup and Open–Edit–Save are exercised against the installed executable.
- Uninstall must remove the application executable and uninstall registration while preserving an owned project outside the installation tree and recovery snapshots in both profile-name conventions, byte-for-byte.
- A synthetic 0.0.4 install is upgraded to the current installer, with the same archive, registration, smoke, historical-project migration and data-preservation checks, then uninstalled. The baseline package version differs, so its archive is not required to match the current package hash.
- Silent `/allusers` installs per-machine, checks HKLM uninstall registration, the archive hash, startup and historical migration, then uninstalls with `/allusers`. Per-user and per-machine registration must not both be present.
- Assisted GUI installs omit `/S`, `/currentuser` and `/allusers`, because those flags skip the pages under test. UI Automation selects "Only for me" or "Anyone who uses this computer (all users)", sets the directory, and clears the finish-page Run checkbox before Finish. The same registration, archive, startup, migration and uninstall checks follow.
- electron-builder 26.15.3 may append `\Canvas Fogworks` when the chosen directory does not already contain that name. The guest accepts the requested directory or that child directory.
- Current and baseline installers, and the installed executable, must stay Authenticode `NotSigned` with a blank CompanyName. Uninstall registration must not name a publisher.
- Every installer phase is bounded to three minutes and each smoke to one minute. A failure leaves guest state for diagnosis. Result status and completed assertions are recorded in `results/result.json`; smoke output is captured alongside it. A passed guest result keeps `hardwareGpuValidation` at `not-certified-by-software-sandbox`.

Close Windows Sandbox when inspection is complete to discard the guest. Host staging/results are retained for diagnosis. This harness is separate from the hosted CI job, which currently runs archive and unpacked-app gates only.

## Record the extended pass

A Linux host, including a Cursor cloud agent, cannot start Windows Sandbox or draw on a hardware GPU. Do not treat a plan file, this document, or exit 2 from the checker as that pass. The commands below are the manual gate.

On a Windows host, from the repository, with the same D: process-local `TEMP`, `TMP`, and Electron builder caches used by the build launcher:

```powershell
npm run build:installer-test-baseline
npm run prepare:installer-sandbox
```

Open the printed `installer-test.wsb`. Leave virtual GPU disabled. The guest writes `results\result.json` and one stdout/stderr pair per smoke phase. Startup phases use `<phase-id>-startup.stdout.log` and `<phase-id>-startup.stderr.log`. Workflow and historical-migration phases use `<phase-id>.stdout.log` and `<phase-id>.stderr.log`.

Then, on that same Windows host and outside Sandbox, write the hardware verdict next to the guest result. The printed `hardwareGpuCommand` is this command with the staging path filled in:

```powershell
npm run validate:hardware-gpu -- --out SANDBOX_RESULTS\hardware-gpu.json
```

| Evidence file | Pass | Fail |
| --- | --- | --- |
| `results\result.json` | `status` is `passed`. `completedPhases` lists every extended phase in order. `hardwareGpuValidation` stays `not-certified-by-software-sandbox`. `virtualGpu` is `disabled`. Every smoke log listed above is present. | `status` is `failed`, `error` is set, a phase is missing or repeated, or the guest claims a hardware GPU. |
| `results\hardware-gpu.json` | `evidenceKind` is `host-hardware-gpu`, `sandbox` is false, `drawOk` is true, and the renderer string classifies as hardware. `validate:hardware-gpu` exits 0. | Software renderers (SwiftShader, llvmpipe, Microsoft Basic Render Driver) and a lost WebGL context. Exit 2 is that failure. Exit 1 is a timeout or crash. |

Check the pair from any machine that has the files:

```powershell
npm run check:installer-evidence -- --guest SANDBOX_RESULTS\result.json --gpu SANDBOX_RESULTS\hardware-gpu.json
```

- Exit 0: both files match the extended contract. `RELEASE-001` stays open in `docs/BACKLOG.json` until a person reviews the files and updates that item. The checker does not launch Sandbox or draw on a GPU.
- Exit 1: the harness contract is broken, a file is unreadable, only one file was passed, or a file fails the table above.
- Exit 2: no evidence files were supplied. The JSON report keeps `release001` at `open`. This is the dry run, and it is not a pass.

`npm run check:installer-evidence -- --plan-out SOME_DIRECTORY` writes `OPERATOR.txt` and `evidence-plan.json` without installers. The September 7 `result.json` files do not satisfy this checker: they predate historical migration, assisted GUI, per-machine installation, and `completedPhases`.

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

The extended guest phases are implemented in the harness, and `check:installer-evidence` can score their result files. The September 7 run remains the last recorded full Sandbox lifecycle, and that run did not include historical migration, assisted GUI navigation or per-machine installation. No later Sandbox `result.json` or host `hardware-gpu.json` has been recorded. Executing the extended guest and recording a host `validate:hardware-gpu` verdict are still required before those phases count as a pass. A software-rendered guest result is not hardware-GPU certification, and virtual GPU stays disabled. Exit 2 from the checker is the open manual gate.

This does not certify signing or SmartScreen reputation. Preservation asserts unchanged recovery bytes, not successful recovery UI restoration. The full Open–Edit–Save workflow remains on the silent per-user path; GUI and per-machine installs run startup and historical migration. The September 7 branding build includes an original vector icon. Personal publisher information and signing are intentionally omitted at the user's request; Windows may identify it as an unknown publisher. The package gate rejects publisher metadata and signing configuration, and the guest rejects a CompanyName or an Authenticode signature.

## Verified references

Configuration and mapping behavior follow [Microsoft's Windows Sandbox documentation](https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-configure-using-wsb-file). Silent install/uninstall and the unquoted final `/D=` / `_?=` arguments follow the [NSIS command-line reference](https://nsis.sourceforge.io/Docs/Chapter3.html#installerusage). `/currentuser`, `/allusers`, assisted install-mode/directory/finish page order, the English radio labels, and synchronous upgrade-uninstaller handling were checked in the installed electron-builder 26.15.3 NSIS templates. Silent per-machine elevation is the install section's existing `/allusers` path. GUI coverage does not pass those flags, because they skip the pages. Synthetic version injection follows [electron-builder v26 configuration](https://www.electron.build/v26/docs/configuration/). Redirected-process exit-code behavior was checked against the [PowerShell issue tracker](https://github.com/PowerShell/PowerShell/issues/5421) and reproduced with guest probes before correction.
