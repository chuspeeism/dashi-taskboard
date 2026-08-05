[CmdletBinding()]
param(
  [ValidateRange(1, 65535)]
  [int]$Port = 9229,

  [switch]$NoOpen
)

$ErrorActionPreference = "Stop"

if ($env:OS -ne "Windows_NT") {
  throw "codex-windows.ps1 requires Windows."
}

$runningMainProcess = Get-CimInstance Win32_Process -Filter "Name = 'ChatGPT.exe'" |
  Where-Object { $_.CommandLine -notmatch "--type=" } |
  Select-Object -First 1

if ($runningMainProcess) {
  throw "Codex is already running without the requested CDP cold start. Quit Codex completely, then run npm run codex:windows again."
}

$codexApp = Get-StartApps |
  Where-Object { $_.AppID -like "OpenAI.Codex_*!App" } |
  Select-Object -First 1

if (-not $codexApp) {
  throw "The Microsoft Store Codex application is not installed for this Windows user."
}

$activationSource = @'
using System;
using System.Runtime.InteropServices;

[ComImport]
[Guid("2e941141-7f97-4756-ba1d-9decde894a3d")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IApplicationActivationManager {
  [PreserveSig]
  int ActivateApplication(
    [MarshalAs(UnmanagedType.LPWStr)] string appUserModelId,
    [MarshalAs(UnmanagedType.LPWStr)] string arguments,
    uint options,
    out uint processId);
}

[ComImport]
[Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")]
public class ApplicationActivationManager {}

public static class CodexStoreApplication {
  public static uint Activate(string appUserModelId, string arguments) {
    var manager = (IApplicationActivationManager)new ApplicationActivationManager();
    uint processId;
    int result = manager.ActivateApplication(appUserModelId, arguments, 0, out processId);
    Marshal.ThrowExceptionForHR(result);
    return processId;
  }
}
'@

Add-Type -TypeDefinition $activationSource

$launchArguments = "--remote-debugging-port=$Port --remote-allow-origins=http://127.0.0.1:$Port"
$launchedProcessId = [CodexStoreApplication]::Activate($codexApp.AppID, $launchArguments)
Write-Host "Started Codex process $launchedProcessId with CDP port $Port."

$targetsUrl = "http://127.0.0.1:$Port/json/list"
$deadline = [DateTime]::UtcNow.AddSeconds(30)
$readyChecks = 0
while ([DateTime]::UtcNow -lt $deadline) {
  try {
    $targets = @(Invoke-RestMethod -Uri $targetsUrl -TimeoutSec 1)
    $mainTarget = $targets | Where-Object {
      $_.type -eq "page" -and ($_.url -like "app://*" -or $_.title -eq "Codex")
    } | Select-Object -First 1
    if ($mainTarget) {
      $readyChecks += 1
      if ($readyChecks -ge 3) {
        break
      }
    } else {
      $readyChecks = 0
    }
  } catch {
    $readyChecks = 0
  }
  Start-Sleep -Milliseconds 250
}

if ($readyChecks -lt 3) {
  throw "Codex started, but its CDP renderer did not become ready at $targetsUrl within 30 seconds."
}

$injectorPath = Join-Path $PSScriptRoot "codex-injector.mjs"
$injectorArguments = @($injectorPath, "--watch", "--port", "$Port")
if (-not $NoOpen) {
  $injectorArguments += "--open"
}

& node @injectorArguments
exit $LASTEXITCODE
