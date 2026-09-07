# Runs ONLY inside Windows Sandbox. Never invoke an installer on the host.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($env:USERNAME -ne 'WDAGUtilityAccount') { throw 'Installer lifecycle tests require Windows Sandbox.' }
if (-not (Test-Path -LiteralPath 'C:\FogworksInput\manifest.json') -or
    -not (Test-Path -LiteralPath 'C:\FogworksResults')) { throw 'Expected Sandbox folder mappings are missing.' }

$work = 'C:\FogworksInstallerTest'
$install = 'C:\FogworksInstallerTest\Installed App'
$resultPath = 'C:\FogworksResults\result.json'
$steps = [System.Collections.Generic.List[string]]::new()
$result = [ordered]@{ status = 'running'; steps = @(); error = $null; syntheticBaseline = $true }
function Record-Step([string]$message) {
    $steps.Add($message)
    $result.steps = @($steps.ToArray())
    $result | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $resultPath -Encoding UTF8
}
function Run-Checked([string]$file, [string]$arguments, [string]$label) {
    $process = Start-Process -FilePath $file -ArgumentList $arguments -PassThru -WindowStyle Hidden
    # Windows PowerShell can otherwise lose ExitCode after a redirected process exits.
    $null = $process.Handle
    if (-not $process.WaitForExit(180000)) { throw "$label timed out; guest left for inspection." }
    if ($process.ExitCode -ne 0) { throw "$label failed with exit code $($process.ExitCode)." }
}
function Installed-Entry {
    $entries = @(Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' -ErrorAction SilentlyContinue |
        Get-ItemProperty | Where-Object { $_.PSObject.Properties['DisplayName'] -and $_.DisplayName -match '^Canvas Fogworks(?: .+)?$' })
    return $entries
}
function Assert-Installed([string]$version) {
    if (-not (Test-Path -LiteralPath "$install\Canvas Fogworks.exe")) { throw 'Installed executable missing from requested path.' }
    $entries = @(Installed-Entry)
    if ($entries.Count -ne 1 -or $entries[0].DisplayVersion -ne $version) {
        $observed = $entries | Select-Object DisplayName,DisplayVersion | ConvertTo-Json -Compress
        throw "Incorrect uninstall registration for $version. Observed: $observed"
    }
}
function Assert-Preserved {
    foreach ($item in $preserved) {
        if (-not (Test-Path -LiteralPath $item.path) -or (Get-FileHash -LiteralPath $item.path -Algorithm SHA256).Hash -ne $item.hash) {
            throw "Project/recovery data changed: $($item.path)"
        }
    }
}
function Smoke-Installed([string]$label) {
    foreach ($mode in @('startup', 'workflow')) {
        $extra = if ($mode -eq 'workflow') { '--project-open ' } else { '' }
        $stdout = "C:\FogworksResults\$label-$mode.stdout.log"
        $stderr = "C:\FogworksResults\$label-$mode.stderr.log"
        $process = Start-Process -FilePath "$work\node.exe" -ArgumentList "`"$work\scripts\smoke-startup.js`" ${extra}--packaged `"$install\Canvas Fogworks.exe`"" -PassThru -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr
        $null = $process.Handle
        if (-not $process.WaitForExit(60000)) { throw "$label $mode smoke timed out." }
        if ($process.ExitCode -ne 0) { throw "$label $mode smoke failed; see captured logs." }
        Record-Step "$label $mode smoke passed"
    }
}
function Uninstall-App([string]$label) {
    $uninstaller = "$install\Uninstall Canvas Fogworks.exe"
    if (-not (Test-Path -LiteralPath $uninstaller)) { throw 'Expected uninstaller missing.' }
    # NSIS _?= keeps the process synchronous; run a guest-local copy outside the install tree.
    $copy = "$work\$label-uninstall.exe"
    Copy-Item -LiteralPath $uninstaller -Destination $copy
    Run-Checked $copy "/S /currentuser _?=$install" "$label uninstall"
    if ((Test-Path -LiteralPath "$install\Canvas Fogworks.exe") -or @(Installed-Entry).Count -ne 0) {
        throw 'Uninstall left executable or registration behind.'
    }
    Assert-Preserved
    Record-Step "$label uninstall removed executable/registration and preserved project/recovery bytes"
}
try {
    Record-Step 'Sandbox guest started'
    if (Test-Path -LiteralPath $work) { throw 'Guest test workspace already exists.' }
    New-Item -ItemType Directory -Path $work | Out-Null
    Copy-Item -Path 'C:\FogworksInput\*' -Destination $work -Recurse
    New-Item -ItemType Directory -Path "$work\dist" | Out-Null
    $manifest = Get-Content -LiteralPath "$work\manifest.json" -Raw | ConvertFrom-Json
    $result.installerSha256 = $manifest.installerSha256
    foreach ($pair in @(@('current.exe', $manifest.installerSha256), @('baseline.exe', $manifest.baselineSha256))) {
        if ((Get-FileHash -LiteralPath "$work\$($pair[0])" -Algorithm SHA256).Hash -ne $pair[1]) { throw 'Installer input hash mismatch.' }
    }
    if (@(Installed-Entry).Count -ne 0) { throw 'Sandbox is not clean: existing app registration.' }
    $preserved = @()
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
    Run-Checked "$work\current.exe" "/S /currentuser /D=$install" 'fresh install'
    Assert-Installed $manifest.version
    if ((Get-FileHash -LiteralPath "$install\resources\app.asar").Hash -ne $manifest.archiveSha256) { throw 'Installed archive differs from verified package.' }
    Assert-Preserved
    Record-Step 'Fresh install, registration and archive hash passed'
    Smoke-Installed 'fresh'
    Uninstall-App 'fresh'
    Run-Checked "$work\baseline.exe" "/S /currentuser /D=$install" 'synthetic baseline install'
    Assert-Installed $manifest.baselineVersion
    Record-Step 'Synthetic 0.0.4 baseline installed'
    Run-Checked "$work\current.exe" "/S /currentuser /D=$install" 'upgrade'
    Assert-Installed $manifest.version
    if ((Get-FileHash -LiteralPath "$install\resources\app.asar").Hash -ne $manifest.archiveSha256) { throw 'Upgraded archive differs from verified package.' }
    Assert-Preserved
    Record-Step 'Upgrade to current version preserved project/recovery bytes and matched archive'
    Smoke-Installed 'upgraded'
    Uninstall-App 'upgraded'
    $result.status = 'passed'
    Record-Step 'Lifecycle checks complete; close Sandbox to discard guest state'
} catch {
    $result.status = 'failed'
    $result.error = $_.Exception.Message
    Record-Step 'Lifecycle checks failed; guest retained for diagnosis'
    exit 1
}
