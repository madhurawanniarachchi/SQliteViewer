"""
Builds sqliteviewer_fixed/tools/Install-ADB-Bridge.cmd

The installer is one self-contained file: a batch header that starts PowerShell, and the
PowerShell installer (with the C# source of the bridge embedded) after a marker line.
It needs nothing but Windows: the C# compiler that ships with .NET Framework 4 builds
adb-bridge.exe on the user's own PC, so there is no downloaded program and no Python.

Run from the repository root:   python scripts/build-bridge-installer.py
"""

import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOURCE = os.path.join(ROOT, "scripts", "bridge", "AdbBridge.cs")
TARGET = os.path.join(ROOT, "sqliteviewer_fixed", "tools", "Install-ADB-Bridge.cmd")

MARKER_A = "#### POWER"
MARKER_B = "SHELL ####"

BATCH_HEADER = r'''@echo off
setlocal
title SQLite Viewer - ADB bridge installer
set "BRIDGE_SELF=%~f0"
set BRIDGE_ARGS=%*
powershell -NoProfile -ExecutionPolicy Bypass -Command "$t=[IO.File]::ReadAllText($env:BRIDGE_SELF); $i=$t.IndexOf('#### POWER'+'SHELL ####'); & ([scriptblock]::Create($t.Substring($i)))"
exit /b %errorlevel%
'''

POWERSHELL = r"""#### POWERSHELL ####
$ErrorActionPreference = 'Stop'

$opts = [string]$env:BRIDGE_ARGS
function Option($name, $default) {
    $m = [regex]::Match($opts, '(?i)(?:^|\s)' + [regex]::Escape($name) + '=(?:"([^"]+)"|(\S+))')
    if ($m.Success) { if ($m.Groups[1].Success) { return $m.Groups[1].Value } else { return $m.Groups[2].Value } }
    return $default
}

$quiet     = $opts -match '(?i)(^|\s)/quiet'
$uninstall = $opts -match '(?i)(^|\s)/uninstall'
$installDir = Option '/dir' (Join-Path $env:LOCALAPPDATA 'SQLiteViewerBridge')
$startupDir = Option '/startup' ([Environment]::GetFolderPath('Startup'))
$port       = [int](Option '/port' '5038')
$extraOrigin = Option '/origin' ''
$shortcut   = Join-Path $startupDir 'SQLite Viewer ADB Bridge.lnk'
$exe        = Join-Path $installDir 'adb-bridge.exe'

function Step($text) { Write-Host ('  ' + $text) }
function Finish($message, $ok) {
    Write-Host ''
    if ($ok) { Write-Host $message -ForegroundColor Green } else { Write-Host $message -ForegroundColor Red }
    if (-not $quiet) { Write-Host ''; Read-Host 'Press Enter to close' | Out-Null }
    if ($ok) { exit 0 } else { exit 1 }
}
function Stop-Bridge {
    Get-Process -Name 'adb-bridge' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 400
}

Write-Host ''
Write-Host 'SQLite Viewer - ADB bridge' -ForegroundColor Cyan
Write-Host '--------------------------'

try {
    if ($uninstall) {
        Step 'Stopping the bridge...'
        Stop-Bridge
        if (Test-Path -LiteralPath $shortcut) { Remove-Item -LiteralPath $shortcut -Force }
        if (Test-Path -LiteralPath $installDir) { Remove-Item -LiteralPath $installDir -Recurse -Force -ErrorAction SilentlyContinue }
        Finish 'The ADB bridge was removed.' $true
    }

    Step 'Preparing...'
    Stop-Bridge
    New-Item -ItemType Directory -Force -Path $installDir | Out-Null
    New-Item -ItemType Directory -Force -Path $startupDir | Out-Null

    $csc = @(
        (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
        (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
    ) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    if (-not $csc) { Finish 'Windows needs the .NET Framework 4 to build the bridge. It is included with Windows 10 and 11.' $false }

    Step 'Building the bridge on this PC...'
    $source = Join-Path $installDir 'AdbBridge.cs'
    $code = @'
%%CSHARP%%
'@
    Set-Content -LiteralPath $source -Value $code -Encoding ASCII
    $compile = & $csc /nologo /optimize+ /target:winexe ('/out:' + $exe) $source 2>&1
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $exe)) {
        Write-Host ($compile | Out-String)
        Finish 'Could not build the bridge (see the messages above).' $false
    }

    if ($extraOrigin) { Set-Content -LiteralPath (Join-Path $installDir 'origins.txt') -Value $extraOrigin -Encoding ASCII }

    Step 'Starting it automatically when you sign in...'
    $shell = New-Object -ComObject WScript.Shell
    $link = $shell.CreateShortcut($shortcut)
    $link.TargetPath = $exe
    $link.Arguments = '--port ' + $port
    $link.WorkingDirectory = $installDir
    $link.WindowStyle = 7
    $link.Description = 'SQLite Viewer ADB bridge'
    $link.Save()

    $remove = '@echo off' + "`r`n" +
        'powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-Process adb-bridge -ErrorAction SilentlyContinue | Stop-Process -Force; Remove-Item -LiteralPath ''' + $shortcut + ''' -ErrorAction SilentlyContinue"' + "`r`n" +
        'echo The SQLite Viewer ADB bridge was removed.' + "`r`n" +
        'ping -n 3 127.0.0.1 >nul' + "`r`n" +
        '(goto) 2>nul & rd /s /q "%~dp0"' + "`r`n"
    Set-Content -LiteralPath (Join-Path $installDir 'uninstall.cmd') -Value $remove -Encoding ASCII

    Step 'Starting the bridge now...'
    Start-Process -FilePath $exe -ArgumentList ('--port ' + $port) -WorkingDirectory $installDir -WindowStyle Hidden

    $running = $false
    for ($i = 0; $i -lt 20 -and -not $running; $i++) {
        Start-Sleep -Milliseconds 400
        try {
            $probe = New-Object System.Net.Sockets.TcpClient
            $probe.Connect('127.0.0.1', $port)
            $probe.Close()
            $running = $true
        } catch { }
    }
    if (-not $running) { Finish ('The bridge did not start. Details: ' + (Join-Path $installDir 'bridge.log')) $false }

    $adb = Get-Command adb.exe -ErrorAction SilentlyContinue
    if (-not $adb) {
        foreach ($root in @($env:ANDROID_HOME, $env:ANDROID_SDK_ROOT, (Join-Path $env:LOCALAPPDATA 'Android\Sdk'))) {
            if ($root -and (Test-Path -LiteralPath (Join-Path $root 'platform-tools\adb.exe'))) { $adb = $true }
        }
    }

    Write-Host ''
    if ($adb) {
        Finish 'Done. The bridge is running and will start by itself every time you sign in. Go back to SQLite Viewer and click "Connect through bridge".' $true
    } else {
        Finish 'Done, but ADB was not found on this PC. Install Android Studio or the Android Platform Tools; the bridge will use ADB as soon as it exists. Then go back to SQLite Viewer and click "Connect through bridge".' $true
    }
}
catch {
    Finish ('Something went wrong: ' + $_.Exception.Message) $false
}
"""


def main():
    with open(SOURCE, encoding="utf-8") as f:
        csharp = f.read()

    csharp.encode("ascii")  # the installer is written as ASCII; fail loudly if the source is not
    assert "\n'@" not in csharp, "C# source must not contain a line starting with '@"

    text = BATCH_HEADER + POWERSHELL.replace("%%CSHARP%%", csharp.rstrip("\n"))
    text = text.replace("\r\n", "\n").replace("\n", "\r\n")

    assert text.count(MARKER_A + MARKER_B) == 1, "the PowerShell marker must appear exactly once"
    text.encode("ascii")

    os.makedirs(os.path.dirname(TARGET), exist_ok=True)
    with open(TARGET, "w", encoding="ascii", newline="") as f:
        f.write(text)

    print("wrote", TARGET, len(text), "bytes")


if __name__ == "__main__":
    main()
