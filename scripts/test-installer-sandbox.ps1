# Runs ONLY inside Windows Sandbox. Never invoke an installer on the host.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($env:USERNAME -ne 'WDAGUtilityAccount') { throw 'Installer lifecycle tests require Windows Sandbox.' }
if (-not (Test-Path -LiteralPath 'C:\FogworksInput\manifest.json') -or
    -not (Test-Path -LiteralPath 'C:\FogworksResults')) { throw 'Expected Sandbox folder mappings are missing.' }

$work = 'C:\FogworksInstallerTest'
$perUser = 'C:\FogworksInstallerTest\Installed App'
$perMachine = 'C:\FogworksInstallerTest\PerMachine'
$guiUser = 'C:\FogworksInstallerTest\GuiPerUser'
$guiMachine = 'C:\FogworksInstallerTest\GuiPerMachine'
$resultPath = 'C:\FogworksResults\result.json'
$script:GuiReady = $false
$steps = [System.Collections.Generic.List[string]]::new()
$completed = [System.Collections.Generic.List[string]]::new()
$result = [ordered]@{
    status = 'running'; evidenceKind = 'windows-sandbox-installer-lifecycle'; virtualGpu = 'disabled'
    completedPhases = @(); steps = @(); error = $null; syntheticBaseline = $true
    historicalReleaseInstaller = $false; hardwareGpuValidation = 'not-certified-by-software-sandbox'
    publisherMetadata = $false; signing = $false
}
function Write-Result {
    # .NET Framework WriteAllText is UTF-8 without a BOM. Set-Content -Encoding UTF8 is not.
    [System.IO.File]::WriteAllText($resultPath, ($result | ConvertTo-Json -Depth 6))
}
function Record-Step([string]$message) {
    $steps.Add($message)
    $result.steps = @($steps.ToArray())
    Write-Result
}
function Complete-Phase([string]$id, [string]$message) {
    if ([string]::IsNullOrWhiteSpace($id)) { throw 'A lifecycle phase id is required.' }
    if ($completed.Contains($id)) { throw "Phase '$id' was recorded twice." }
    $completed.Add($id)
    $result.completedPhases = @($completed.ToArray())
    Record-Step $message
}
function Run-Checked([string]$file, [string]$arguments, [string]$label) {
    $process = Start-Process -FilePath $file -ArgumentList $arguments -PassThru -WindowStyle Hidden
    # Windows PowerShell can otherwise lose ExitCode after a redirected process exits.
    $null = $process.Handle
    if (-not $process.WaitForExit(180000)) { throw "$label timed out; guest left for inspection." }
    if ($process.ExitCode -ne 0) { throw "$label failed with exit code $($process.ExitCode)." }
}
function Uninstall-Roots([string]$scope) {
    if ($scope -eq 'allusers') {
        return @(
            'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
            'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
        )
    }
    return @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall')
}
function Installed-Entry([string]$scope) {
    $entries = @()
    foreach ($root in Uninstall-Roots $scope) {
        if (-not (Test-Path -LiteralPath $root)) { continue }
        $entries += @(Get-ChildItem -LiteralPath $root -ErrorAction SilentlyContinue |
            Get-ItemProperty | Where-Object { $_.PSObject.Properties['DisplayName'] -and $_.DisplayName -match '^Canvas Fogworks(?: .+)?$' })
    }
    return $entries
}
function Resolve-InstalledRoot([string]$requested) {
    foreach ($candidate in @($requested, (Join-Path $requested 'Canvas Fogworks'))) {
        if (Test-Path -LiteralPath (Join-Path $candidate 'Canvas Fogworks.exe')) { return $candidate }
    }
    throw "Installed executable missing from requested path '$requested'."
}
function Assert-AnonymousUnsigned([string]$path, [string]$label) {
    $signature = Get-AuthenticodeSignature -LiteralPath $path
    if ($signature.Status -ne 'NotSigned') { throw "$label must stay unsigned. Status: $($signature.Status)." }
    $info = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($path)
    if ($info.CompanyName) { throw "$label CompanyName must stay blank. Observed: $($info.CompanyName)." }
}
function Assert-Installed([string]$version, [string]$scope, [string]$requested) {
    $root = Resolve-InstalledRoot $requested
    $entries = @(Installed-Entry $scope)
    if ($entries.Count -ne 1 -or $entries[0].DisplayVersion -ne $version) {
        $observed = $entries | Select-Object DisplayName,DisplayVersion | ConvertTo-Json -Compress
        throw "Incorrect $scope uninstall registration for $version. Observed: $observed"
    }
    if ($entries[0].PSObject.Properties['Publisher'] -and $entries[0].Publisher) {
        throw "Uninstall registration must not name a publisher. Observed: $($entries[0].Publisher)."
    }
    $other = if ($scope -eq 'allusers') { 'currentuser' } else { 'allusers' }
    if (@(Installed-Entry $other).Count -ne 0) { throw "Install scope $scope also left a $other registration." }
    Assert-AnonymousUnsigned (Join-Path $root 'Canvas Fogworks.exe') 'Installed application'
    return $root
}
function Assert-Preserved {
    foreach ($item in $preserved) {
        if (-not (Test-Path -LiteralPath $item.path) -or (Get-FileHash -LiteralPath $item.path -Algorithm SHA256).Hash -ne $item.hash) {
            throw "Project/recovery data changed: $($item.path)"
        }
    }
    foreach ($path in @($migratedHashes.Keys)) {
        if (-not (Test-Path -LiteralPath $path) -or (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ne $migratedHashes[$path]) {
            throw "Migrated historical project changed: $path"
        }
    }
}
function Smoke-Workflow([string]$label, [string]$exe) {
    $stdout = "C:\FogworksResults\$label.stdout.log"
    $stderr = "C:\FogworksResults\$label.stderr.log"
    $process = Start-Process -FilePath "$work\node.exe" -ArgumentList "`"$work\scripts\smoke-startup.js`" --project-open --packaged `"$exe`"" -PassThru -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    $null = $process.Handle
    if (-not $process.WaitForExit(60000)) { throw "$label timed out." }
    if ($process.ExitCode -ne 0) { throw "$label failed; see captured logs." }
    Complete-Phase $label "$label passed"
}
function Smoke-Startup([string]$label, [string]$exe) {
    $stdout = "C:\FogworksResults\$label-startup.stdout.log"
    $stderr = "C:\FogworksResults\$label-startup.stderr.log"
    $process = Start-Process -FilePath "$work\node.exe" -ArgumentList "`"$work\scripts\smoke-startup.js`" --packaged `"$exe`"" -PassThru -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    $null = $process.Handle
    if (-not $process.WaitForExit(60000)) { throw "$label startup smoke timed out." }
    if ($process.ExitCode -ne 0) { throw "$label startup smoke failed; see captured logs." }
    Complete-Phase $label "$label startup smoke passed"
}
function Smoke-Historical([string]$label, [string]$exe) {
    $source = Join-Path $work $manifest.historical.file
    $project = Join-Path ([Environment]::GetFolderPath('MyDocuments')) $manifest.historical.file
    Copy-Item -LiteralPath $source -Destination $project -Force
    $stdout = "C:\FogworksResults\$label.stdout.log"
    $stderr = "C:\FogworksResults\$label.stderr.log"
    $schema = $manifest.historical.expectedSchema
    $process = Start-Process -FilePath "$work\node.exe" -ArgumentList "`"$work\scripts\smoke-startup.js`" --historical-migration `"$project`" --historical-schema $schema --packaged `"$exe`"" -PassThru -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    $null = $process.Handle
    if (-not $process.WaitForExit(60000)) { throw "$label timed out." }
    if ($process.ExitCode -ne 0) { throw "$label failed; see captured logs." }
    $saved = Get-Content -LiteralPath $project -Raw | ConvertFrom-Json
    if ($saved.version -ne $schema) { throw "$label saved schema $($saved.version), expected $schema." }
    $migratedHashes[$project] = (Get-FileHash -LiteralPath $project -Algorithm SHA256).Hash
    Complete-Phase $label "$label passed"
}
function Uninstall-App([string]$label, [string]$scope, [string]$root) {
    $uninstaller = Join-Path $root 'Uninstall Canvas Fogworks.exe'
    if (-not (Test-Path -LiteralPath $uninstaller)) { throw 'Expected uninstaller missing.' }
    # NSIS _?= keeps the process synchronous; run a guest-local copy outside the install tree.
    $copy = Join-Path $work "$label-uninstall.exe"
    Copy-Item -LiteralPath $uninstaller -Destination $copy
    $flag = if ($scope -eq 'allusers') { '/allusers' } else { '/currentuser' }
    Run-Checked $copy "/S $flag _?=$root" "$label uninstall"
    if ((Test-Path -LiteralPath (Join-Path $root 'Canvas Fogworks.exe')) -or
        @(Installed-Entry 'currentuser').Count -ne 0 -or @(Installed-Entry 'allusers').Count -ne 0) {
        throw 'Uninstall left executable or registration behind.'
    }
    Assert-Preserved
    Complete-Phase $label "$label removed executable/registration and preserved project/recovery bytes"
}
function Install-Silent([string]$label, [string]$file, [string]$scope, [string]$destination, [string]$version, [bool]$checkArchive = $true) {
    $flag = if ($scope -eq 'allusers') { '/allusers' } else { '/currentuser' }
    Run-Checked $file "/S $flag /D=$destination" $label
    $root = Assert-Installed $version $scope $destination
    # The synthetic baseline is the same application with a replaced package version, so its archive
    # hash is not the current package hash. Current installers must match byte for byte.
    if ($checkArchive -and (Get-FileHash -LiteralPath (Join-Path $root 'resources\app.asar')).Hash -ne $manifest.archiveSha256) {
        throw "$label archive differs from verified package."
    }
    Assert-Preserved
    Complete-Phase $label "$label installed at $root"
    return $root
}
function Ensure-GuiAutomation {
    if ($script:GuiReady) { return }
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    if (-not ('FogworksWin32' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class FogworksWin32 {
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);
}
'@
    }
    $script:GuiReady = $true
}
function Find-Controls($parent, [string]$typeName) {
    $type = [System.Windows.Automation.ControlType]::$typeName
    $condition = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty, $type)
    $found = $parent.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
    $items = @()
    foreach ($item in $found) { $items += $item }
    return $items
}
function Find-Wizard {
    $condition = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::Window)
    $found = [System.Windows.Automation.AutomationElement]::RootElement.FindAll(
        [System.Windows.Automation.TreeScope]::Children, $condition)
    $matches = @()
    foreach ($window in $found) {
        if ($window.Current.Name -like '*Canvas Fogworks*') { $matches += $window }
    }
    foreach ($window in $matches) {
        if (-not $window.Current.IsOffscreen) { return $window }
    }
    if ($matches.Count -gt 0) { return $matches[0] }
    return $null
}
function Click-Element($element) {
    [void][FogworksWin32]::SendMessage([IntPtr]$element.Current.NativeWindowHandle, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero)
}
function Invoke-NamedButton($wizard, [string]$pattern) {
    $button = Find-Controls $wizard 'Button' | Where-Object { $_.Current.Name -match $pattern } | Select-Object -First 1
    if (-not $button) { throw "Wizard button matching '$pattern' was not available." }
    Click-Element $button
}
# Assisted pages, in electron-builder 26.15.3 order: install mode, directory, instfiles, finish.
# /S and /currentuser or /allusers are omitted on purpose: those flags skip the pages this phase exists to drive.
function Install-Assisted([string]$label, [string]$scope, [string]$destination, [string]$version) {
    Ensure-GuiAutomation
    $process = Start-Process -FilePath "$work\current.exe" -PassThru -WindowStyle Normal
    $null = $process.Handle
    $deadline = [DateTime]::UtcNow.AddMinutes(3)
    $modeSelected = $false
    $directorySet = $false
    $finished = $false
    $radioPattern = if ($scope -eq 'allusers') { 'all users' } else { 'Only for' }
    while ([DateTime]::UtcNow -lt $deadline -and -not $process.HasExited) {
        $wizard = Find-Wizard
        if (-not $wizard) { Start-Sleep -Milliseconds 200; continue }
        if (-not $modeSelected) {
            $radios = @(Find-Controls $wizard 'RadioButton')
            if ($radios.Count -ge 1) {
                $radio = $radios | Where-Object { $_.Current.Name -match $radioPattern } | Select-Object -First 1
                if (-not $radio) { throw "$label install-mode page did not offer '$radioPattern'." }
                Click-Element $radio
                Start-Sleep -Milliseconds 200
                Invoke-NamedButton $wizard 'Next'
                $modeSelected = $true
                Start-Sleep -Milliseconds 500
                continue
            }
        } elseif (-not $directorySet) {
            $edits = @(Find-Controls $wizard 'Edit')
            if ($edits.Count -ge 1) {
                $value = $edits[0].GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
                $value.SetValue($destination)
                Invoke-NamedButton $wizard 'Install|Next'
                $directorySet = $true
                Start-Sleep -Milliseconds 500
                continue
            }
        } else {
            $finish = @(Find-Controls $wizard 'Button' | Where-Object { $_.Current.Name -match 'Finish' })
            if ($finish.Count -ge 1) {
                foreach ($check in @(Find-Controls $wizard 'CheckBox' | Where-Object { $_.Current.Name -match 'Run' })) {
                    $toggle = $check.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
                    if ($toggle.Current.ToggleState -eq [System.Windows.Automation.ToggleState]::On) { $toggle.Toggle() }
                }
                Click-Element $finish[0]
                $finished = $true
                break
            }
        }
        Start-Sleep -Milliseconds 200
    }
    $remaining = [int][Math]::Max(1, ($deadline - [DateTime]::UtcNow).TotalMilliseconds)
    if (-not $process.HasExited -and -not $process.WaitForExit($remaining)) {
        throw "$label GUI installer timed out; guest left for inspection."
    }
    if (-not $modeSelected -or -not $directorySet -or -not $finished) { throw "$label GUI installer did not complete the wizard." }
    if ($process.ExitCode -ne 0) { throw "$label GUI installer failed with exit code $($process.ExitCode)." }
    $root = Assert-Installed $version $scope $destination
    if ((Get-FileHash -LiteralPath (Join-Path $root 'resources\app.asar')).Hash -ne $manifest.archiveSha256) {
        throw "$label archive differs from verified package."
    }
    Assert-Preserved
    Complete-Phase $label "$label installed at $root"
    return $root
}
try {
    Record-Step 'Sandbox guest started'
    if (Test-Path -LiteralPath $work) { throw 'Guest test workspace already exists.' }
    New-Item -ItemType Directory -Path $work | Out-Null
    Copy-Item -Path 'C:\FogworksInput\*' -Destination $work -Recurse
    New-Item -ItemType Directory -Path "$work\dist" | Out-Null
    $manifest = Get-Content -LiteralPath "$work\manifest.json" -Raw | ConvertFrom-Json
    if ($manifest.syntheticBaseline -ne $true) { throw 'Synthetic baseline must stay labeled as a test-only version.' }
    if ($manifest.historicalReleaseInstaller -ne $false) { throw 'This guest does not install a historical release binary.' }
    if ($manifest.hardwareGpu.certifiedByThisSandbox -ne $false) { throw 'Software sandbox cannot certify hardware GPU.' }
    if ($manifest.historical.sourceVersion -ne '0.0.4') { throw 'Historical fixture is not the 0.0.4 project format.' }
    if ($manifest.signing -ne $false -or $manifest.publisherMetadata -ne $false) { throw 'Publisher metadata and signing stay omitted.' }
    $result.installerSha256 = $manifest.installerSha256
    foreach ($pair in @(@('current.exe', $manifest.installerSha256), @('baseline.exe', $manifest.baselineSha256))) {
        if ((Get-FileHash -LiteralPath "$work\$($pair[0])" -Algorithm SHA256).Hash -ne $pair[1]) { throw 'Installer input hash mismatch.' }
    }
    $historicalPath = Join-Path $work $manifest.historical.file
    if ((Get-FileHash -LiteralPath $historicalPath -Algorithm SHA256).Hash -ne $manifest.historical.sha256) {
        throw 'Historical project hash mismatch.'
    }
    Assert-AnonymousUnsigned "$work\current.exe" 'Current installer'
    Assert-AnonymousUnsigned "$work\baseline.exe" 'Synthetic baseline installer'
    Complete-Phase 'unsigned-anonymous' 'unsigned-anonymous installers have blank CompanyName and are NotSigned'
    if (@(Installed-Entry 'currentuser').Count -ne 0 -or @(Installed-Entry 'allusers').Count -ne 0) {
        throw 'Sandbox is not clean: existing app registration.'
    }
    $preserved = @()
    $migratedHashes = @{}
    $document = Get-Content -LiteralPath "$work\owned-example.vde" -Raw
    $project = Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'owned-example.vde'
    [System.IO.File]::WriteAllText($project, $document)
    $preserved += @{ path = $project; hash = (Get-FileHash -LiteralPath $project).Hash }
    # Cover both product-name and package-name profile conventions without touching host data.
    foreach ($name in @('Canvas Fogworks', 'canvas-fogworks')) {
        $profile = Join-Path $env:APPDATA $name
        New-Item -ItemType Directory -Path $profile | Out-Null
        $recovery = Join-Path $profile 'project-recovery.json'
        $snapshot = @{ content = $document; savedContent = '{}'; filePath = $project } | ConvertTo-Json
        [System.IO.File]::WriteAllText($recovery, $snapshot)
        $preserved += @{ path = $recovery; hash = (Get-FileHash -LiteralPath $recovery).Hash }
    }
    $freshRoot = Install-Silent 'fresh-per-user' "$work\current.exe" 'currentuser' $perUser $manifest.version
    $freshExe = Join-Path $freshRoot 'Canvas Fogworks.exe'
    Smoke-Startup 'fresh-startup-smoke' $freshExe
    Smoke-Workflow 'fresh-workflow-smoke' $freshExe
    Smoke-Historical 'fresh-historical-migration' $freshExe
    Uninstall-App 'fresh-uninstall' 'currentuser' $freshRoot
    $baselineRoot = Install-Silent 'synthetic-baseline' "$work\baseline.exe" 'currentuser' $perUser $manifest.baselineVersion $false
    Record-Step 'synthetic-baseline installed the test-only 0.0.4 package'
    $upgradeRoot = Install-Silent 'upgrade-per-user' "$work\current.exe" 'currentuser' $perUser $manifest.version
    $upgradeExe = Join-Path $upgradeRoot 'Canvas Fogworks.exe'
    Smoke-Startup 'upgraded-startup-smoke' $upgradeExe
    Smoke-Workflow 'upgraded-workflow-smoke' $upgradeExe
    Smoke-Historical 'upgraded-historical-migration' $upgradeExe
    Uninstall-App 'upgraded-uninstall' 'currentuser' $upgradeRoot
    $machineRoot = Install-Silent 'per-machine-silent' "$work\current.exe" 'allusers' $perMachine $manifest.version
    $machineExe = Join-Path $machineRoot 'Canvas Fogworks.exe'
    Smoke-Startup 'per-machine-startup-smoke' $machineExe
    Smoke-Historical 'per-machine-historical-migration' $machineExe
    Uninstall-App 'per-machine-uninstall' 'allusers' $machineRoot
    $guiUserRoot = Install-Assisted 'gui-per-user' 'currentuser' $guiUser $manifest.version
    $guiUserExe = Join-Path $guiUserRoot 'Canvas Fogworks.exe'
    Smoke-Startup 'gui-per-user-startup-smoke' $guiUserExe
    Smoke-Historical 'gui-per-user-historical-migration' $guiUserExe
    Uninstall-App 'gui-per-user-uninstall' 'currentuser' $guiUserRoot
    $guiMachineRoot = Install-Assisted 'gui-per-machine' 'allusers' $guiMachine $manifest.version
    $guiMachineExe = Join-Path $guiMachineRoot 'Canvas Fogworks.exe'
    Smoke-Startup 'gui-per-machine-startup-smoke' $guiMachineExe
    Smoke-Historical 'gui-per-machine-historical-migration' $guiMachineExe
    Uninstall-App 'gui-per-machine-uninstall' 'allusers' $guiMachineRoot
    $expectedIds = @($manifest.phases | ForEach-Object { [string]$_.id })
    $actualIds = @($completed.ToArray())
    if (@($expectedIds).Count -ne @($actualIds).Count) {
        throw "Completed $(@($actualIds).Count) phases; manifest lists $(@($expectedIds).Count)."
    }
    for ($i = 0; $i -lt @($expectedIds).Count; $i++) {
        if ($actualIds[$i] -ne $expectedIds[$i]) {
            throw "Completed phase '$($actualIds[$i])' where manifest requires '$($expectedIds[$i])'."
        }
    }
    $result.status = 'passed'
    Record-Step 'Lifecycle checks complete; close Sandbox to discard guest state'
} catch {
    $result.status = 'failed'
    $result.error = $_.Exception.Message
    Record-Step 'Lifecycle checks failed; guest retained for diagnosis'
    exit 1
}
