import { spawnSync } from "node:child_process";
import path from "node:path";

const inspectProcessesScript = String.raw`
$ErrorActionPreference = 'Stop'
$app = $env:CODEX_TASKBOARD_CODEX_APP_PATH
$name = [IO.Path]::GetFileName($app)
$processes = @(Get-CimInstance Win32_Process -Filter "Name = '$name'" |
  Where-Object { $_.ExecutablePath -eq $app } |
  Select-Object ProcessId, ParentProcessId, ExecutablePath, CommandLine)
[Console]::Out.Write(($processes | ConvertTo-Json -Compress))
`;

const activatePackagedAppScript = String.raw`
$ErrorActionPreference = 'Stop'
$source = @'
using System;
using System.Runtime.InteropServices;

[ComImport]
[Guid("2E941141-7F97-4756-BA1D-9DECDE894A3D")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IApplicationActivationManager
{
    [PreserveSig]
    int ActivateApplication(
        [MarshalAs(UnmanagedType.LPWStr)] string appUserModelId,
        [MarshalAs(UnmanagedType.LPWStr)] string arguments,
        uint options,
        out uint processId);
}

[ComImport]
[Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")]
class ApplicationActivationManager {}

public static class PackagedAppActivator
{
    public static uint Activate(string appUserModelId, string arguments)
    {
        var manager = (IApplicationActivationManager)new ApplicationActivationManager();
        try
        {
            uint processId;
            var result = manager.ActivateApplication(appUserModelId, arguments, 0, out processId);
            if (result < 0) Marshal.ThrowExceptionForHR(result);
            return processId;
        }
        finally
        {
            Marshal.FinalReleaseComObject(manager);
        }
    }
}
'@
Add-Type -TypeDefinition $source

$app = $env:CODEX_TASKBOARD_CODEX_APP_PATH
$profile = $env:CODEX_TASKBOARD_CODEX_PROFILE
$port = $env:CODEX_TASKBOARD_CODEX_PORT
$package = Get-AppxPackage | Where-Object {
  $app.StartsWith(($_.InstallLocation + [IO.Path]::DirectorySeparatorChar), [StringComparison]::OrdinalIgnoreCase)
} | Select-Object -First 1
if ($null -eq $package) { throw "Unable to find the Codex package for $app" }

$relativeExecutable = $app.Substring($package.InstallLocation.Length).TrimStart('\', '/').Replace('\', '/')
$manifest = $package | Get-AppxPackageManifest
$application = @($manifest.Package.Applications.Application) | Where-Object {
  ([string]$_.Executable).Replace('\', '/') -eq $relativeExecutable
} | Select-Object -First 1
if ($null -eq $application) { throw "Unable to find the Codex application manifest entry" }

$appUserModelId = $package.PackageFamilyName + '!' + $application.Id
$escapedProfile = $profile.Replace('"', '\"')
$arguments = '--user-data-dir="' + $escapedProfile + '"' +
  ' --remote-debugging-address=127.0.0.1' +
  ' --remote-debugging-port=' + $port +
  ' --remote-allow-origins=http://127.0.0.1:' + $port
$processId = [PackagedAppActivator]::Activate($appUserModelId, $arguments)
[Console]::Out.Write($processId)
`;

const activatePackagedAppWindowScript = String.raw`
$ErrorActionPreference = 'Stop'
$source = @'
using System;
using System.Runtime.InteropServices;

[ComImport]
[Guid("2E941141-7F97-4756-BA1D-9DECDE894A3D")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IApplicationActivationManager
{
    [PreserveSig]
    int ActivateApplication(
        [MarshalAs(UnmanagedType.LPWStr)] string appUserModelId,
        [MarshalAs(UnmanagedType.LPWStr)] string arguments,
        uint options,
        out uint processId);
}

[ComImport]
[Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")]
class ApplicationActivationManager {}

public static class PackagedAppActivator
{
    public static uint Activate(string appUserModelId, string arguments)
    {
        var manager = (IApplicationActivationManager)new ApplicationActivationManager();
        try
        {
            uint processId;
            var result = manager.ActivateApplication(appUserModelId, arguments, 0, out processId);
            if (result < 0) Marshal.ThrowExceptionForHR(result);
            return processId;
        }
        finally
        {
            Marshal.FinalReleaseComObject(manager);
        }
    }
}
'@
Add-Type -TypeDefinition $source

$app = $env:CODEX_TASKBOARD_CODEX_APP_PATH
$package = Get-AppxPackage | Where-Object {
  $app.StartsWith(($_.InstallLocation + [IO.Path]::DirectorySeparatorChar), [StringComparison]::OrdinalIgnoreCase)
} | Select-Object -First 1
if ($null -eq $package) { throw "Unable to find the Codex package for $app" }

$relativeExecutable = $app.Substring($package.InstallLocation.Length).TrimStart('\', '/').Replace('\', '/')
$manifest = $package | Get-AppxPackageManifest
$application = @($manifest.Package.Applications.Application) | Where-Object {
  ([string]$_.Executable).Replace('\', '/') -eq $relativeExecutable
} | Select-Object -First 1
if ($null -eq $application) { throw "Unable to find the Codex application manifest entry" }

$appUserModelId = $package.PackageFamilyName + '!' + $application.Id
$processId = [PackagedAppActivator]::Activate($appUserModelId, '')
[Console]::Out.Write($processId)
`;

function runWindowsPowerShell(script, environment, run = spawnSync) {
  const result = run(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      encoding: "utf8",
      env: environment,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || "Windows PowerShell command failed");
  }
  return result.stdout.trim();
}

export function windowsCodexProcesses(appPath, environment, run = spawnSync) {
  const output = runWindowsPowerShell(
    inspectProcessesScript,
    { ...environment, CODEX_TASKBOARD_CODEX_APP_PATH: appPath },
    run,
  );
  if (!output) return [];
  const parsed = JSON.parse(output);
  return (Array.isArray(parsed) ? parsed : [parsed]).map((record) => ({
    pid: Number(record.ProcessId),
    parentPid: Number(record.ParentProcessId),
    executable: record.ExecutablePath || appPath,
    command: record.CommandLine || record.ExecutablePath || appPath,
  }));
}

export function activateWindowsCodex(appPath, profilePath, port, environment, run = spawnSync) {
  const output = runWindowsPowerShell(
    activatePackagedAppScript,
    {
      ...environment,
      CODEX_TASKBOARD_CODEX_APP_PATH: appPath,
      CODEX_TASKBOARD_CODEX_PROFILE: profilePath,
      CODEX_TASKBOARD_CODEX_PORT: String(port),
    },
    run,
  );
  const pid = Number(output);
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`Packaged Codex activation returned an invalid process ID: ${output}`);
  }
  return pid;
}

export function activateWindowsCodexWindow(appPath, environment, run = spawnSync) {
  const output = runWindowsPowerShell(
    activatePackagedAppWindowScript,
    { ...environment, CODEX_TASKBOARD_CODEX_APP_PATH: appPath },
    run,
  );
  const pid = Number(output);
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`Packaged Codex window activation returned an invalid process ID: ${output}`);
  }
  return pid;
}

export function stopWindowsCodex(pid, environment, run = spawnSync) {
  const result = run("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
    encoding: "utf8",
    env: environment,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !/not found|not running/i.test(result.stderr || "")) {
    throw new Error(result.stderr?.trim() || `Unable to stop Codex process ${pid}`);
  }
}

export function windowsCodexProfileArgument(command, profilePath) {
  const normalizedCommand = command.toLocaleLowerCase("en-US");
  return normalizedCommand.includes("--user-data-dir")
    && normalizedCommand.includes(path.win32.resolve(profilePath).toLocaleLowerCase("en-US"));
}

export function windowsRootProcesses(processes) {
  const processIds = new Set(processes.map((record) => record.pid));
  return processes.filter((record) => !processIds.has(record.parentPid));
}
