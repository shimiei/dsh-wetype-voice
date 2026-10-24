<#
.SYNOPSIS
  Install (or remove) the dsh-wetype-voice plugin into one or more DSH profiles.

.DESCRIPTION
  Copies this plugin into <profile>\node_modules and <profile>\plugins, then
  registers it in the profile's package.json (dependencies + dsh.profile.bundles).
  The bundle's own cordis.patch.yml disables the built-in local voice input, so
  installing is all that is needed besides an app restart.

  Works on Windows PowerShell 5.1 and PowerShell 7+.

.PARAMETER Profile
  Profile name to install into. Default: "desktop" when it exists, otherwise
  every profile that has a package.json. Use "all" for every profile.

.PARAMETER Source
  Directory holding this plugin (lib\, client.js, cordis.patch.yml, ...).
  Defaults to the folder this script lives in.

.PARAMETER Uninstall
  Remove the plugin from the selected profiles instead of installing it.

.EXAMPLE
  .\install.ps1

.EXAMPLE
  .\install.ps1 -Profile desktop -Verbose

.EXAMPLE
  .\install.ps1 -Uninstall
#>
[CmdletBinding()]
param(
    [string] $Profile = '',
    [string] $Source = $PSScriptRoot,
    [switch] $Uninstall
)

$ErrorActionPreference = 'Stop'
$PackageName = 'dsh-wetype-voice'

function Write-Step  { param([string] $Text) Write-Host "  $Text" }
function Write-Ok    { param([string] $Text) Write-Host "  [ok] $Text" -ForegroundColor Green }
function Write-Warn2 { param([string] $Text) Write-Host "  [!]  $Text" -ForegroundColor Yellow }

function Get-DshHome {
    if ($env:DSH_HOME -and $env:DSH_HOME.Trim() -ne '') { return $env:DSH_HOME }
    return (Join-Path $HOME '.dsh')
}

function Resolve-Targets {
    param([string] $DshHome, [string] $Wanted)

    $root = Join-Path $DshHome 'profiles'
    if (-not (Test-Path -LiteralPath $root)) {
        throw "not found: $root (DSH_HOME points at $DshHome)"
    }
    $all = @(Get-ChildItem -LiteralPath $root -Directory |
        Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'package.json') } |
        ForEach-Object { $_.Name })

    if ($all.Count -eq 0) { throw "no profile with package.json under $root" }

    if ($Wanted -eq '') {
        if ($all -contains 'desktop') { return @('desktop') }
        return $all
    }
    if ($Wanted -eq 'all') { return $all }
    if ($all -notcontains $Wanted) {
        throw "profile '$Wanted' not found; available: $($all -join ', ')"
    }
    return @($Wanted)
}

function Set-ProfileRegistration {
    param([string] $PackageFile, [switch] $Remove)

    $json = [System.IO.File]::ReadAllText($PackageFile, [System.Text.UTF8Encoding]::new($false)) | ConvertFrom-Json

    if ($Remove) {
        if ($json.PSObject.Properties['dependencies']) {
            $dep = $json.dependencies.PSObject.Properties[$PackageName]
            if ($dep) { $json.dependencies.PSObject.Properties.Remove($PackageName) }
        }
        if ($json.PSObject.Properties['dsh'] -and $json.dsh.PSObject.Properties['profile']) {
            $bundles = @($json.dsh.profile.bundles | Where-Object { $_ -ne $PackageName })
            if ($bundles.Count -eq 0) { $bundles = @() }
            $json.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue $bundles -Force
        }
    }
    else {
        if (-not $json.PSObject.Properties['dependencies']) {
            $json | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{}) -Force
        }
        $json.dependencies | Add-Member -NotePropertyName $PackageName `
            -NotePropertyValue "file:./plugins/$PackageName" -Force

        if (-not $json.PSObject.Properties['dsh']) {
            $json | Add-Member -NotePropertyName dsh -NotePropertyValue ([pscustomobject]@{}) -Force
        }
        if (-not $json.dsh.PSObject.Properties['profile']) {
            $json.dsh | Add-Member -NotePropertyName profile -NotePropertyValue ([pscustomobject]@{}) -Force
        }
        $bundles = @()
        if ($json.dsh.profile.PSObject.Properties['bundles']) { $bundles = @($json.dsh.profile.bundles) }
        if ($bundles -notcontains $PackageName) { $bundles += $PackageName }
        $json.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue $bundles -Force
    }

    $text = $json | ConvertTo-Json -Depth 12
    [System.IO.File]::WriteAllText($PackageFile, $text + "`n", [System.Text.UTF8Encoding]::new($false))
}

# --- main -------------------------------------------------------------------

if (-not (Test-Path -LiteralPath (Join-Path $Source 'cordis.patch.yml'))) {
    throw "source '$Source' does not look like $PackageName (cordis.patch.yml missing)"
}

$dshHome = Get-DshHome
Write-Host "DSH home: $dshHome"
$targets = Resolve-Targets -DshHome $dshHome -Wanted $Profile
Write-Host "profiles: $($targets -join ', ')"
Write-Host ''

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

foreach ($name in $targets) {
    $profileDir = Join-Path (Join-Path $dshHome 'profiles') $name
    Write-Host "[$name] $profileDir"

    $packageFile = Join-Path $profileDir 'package.json'
    $pluginCopy = Join-Path $profileDir "plugins\$PackageName"
    $moduleCopy = Join-Path $profileDir "node_modules\$PackageName"

    if ($Uninstall) {
        Set-ProfileRegistration -PackageFile $packageFile -Remove
        foreach ($dir in @($pluginCopy, $moduleCopy)) {
            if (Test-Path -LiteralPath $dir) {
                Remove-Item -LiteralPath $dir -Recurse -Force
                Write-Step "removed $dir"
            }
        }
        Write-Ok "unregistered from $name"
        continue
    }

    $backup = "$packageFile.bak-wetype-$stamp"
    Copy-Item -LiteralPath $packageFile -Destination $backup -Force
    Write-Step "backup: $(Split-Path -Leaf $backup)"

    foreach ($dir in @($pluginCopy, $moduleCopy)) {
        if (Test-Path -LiteralPath $dir) { Remove-Item -LiteralPath $dir -Recurse -Force }
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
        Copy-Item -Path (Join-Path $Source '*') -Destination $dir -Recurse -Force
        Write-Step "copied -> $dir"
    }

    Set-ProfileRegistration -PackageFile $packageFile

    $check = [System.IO.File]::ReadAllText($packageFile, [System.Text.UTF8Encoding]::new($false)) | ConvertFrom-Json
    $registered = @($check.dsh.profile.bundles) -contains $PackageName
    $depOk = $check.dependencies.PSObject.Properties[$PackageName] -ne $null
    if (-not ($registered -and $depOk)) { throw "registration verification failed for '$name'" }
    Write-Ok "registered bundle + dependency"
}

Write-Host ''
if ($Uninstall) {
    Write-Host 'Done. Restart DeepSeek Harness for the built-in voice input to come back.'
}
else {
    Write-Host 'Done. Next:'
    Write-Host '  1. Restart DeepSeek Harness (the plugin loads at boot, the browser half is not hot-reloaded).'
    Write-Host '  2. Focus the DSH window, then let it find the WeChat Input Method hotkey by itself:'
    Write-Host '       Invoke-RestMethod -Method Post -Uri http://127.0.0.1:<port>/wetype/api -ContentType application/json -Body ''{"op":"detect","persist":true}'''
    Write-Host '     (replace <port> with the port shown by the app; {"op":"status"} reports what it found)'
    Write-Host '  3. If detect finds nothing, open 微信输入法 → 设置 → 快捷键 → 语音输入 and copy那个绑定 into hotkey:'
    Write-Host '       $env:DSH_HOME\wetype-voice.json  ->  {"hotkey":"ralt+space"}   (no restart needed)'
}
