#Requires -Version 5.1
<#
.SYNOPSIS
    Read-only diagnostic probe for the Codex Taskboard panel on Windows.

.DESCRIPTION
    Inspects the Taskboard injector, the Codex CDP endpoint, the Codex main window,
    and the mounted panel state. It never calls open() or any other mutating action.

    Output is one JSON object. Exit codes:
      0  The panel entry and panel are mounted in a visible Codex window.
      1  The panel is not usable while the Codex CDP endpoint is reachable.
      2  The required environment (injector, CDP endpoint, or main target) is missing.

.PARAMETER CdpPort
    CDP port. When omitted, the port is read from the running codex-injector.mjs process.
#>
[CmdletBinding()]
param(
    [int]$CdpPort = 0
)

$ErrorActionPreference = "Continue"
$ProgressPreference = "SilentlyContinue"
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

function Write-Report($report, $exitCode) {
    $report | ConvertTo-Json -Depth 8
    exit $exitCode
}

function Get-InjectorProcesses {
    @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -match 'codex-injector' })
}

function Get-InjectorPort($commandLine) {
    $match = [regex]::Match($commandLine, '--port\s+(\d+)')
    if (-not $match.Success) { return $null }
    return [int]$match.Groups[1].Value
}

function Get-MainCodexWindowPids {
    @(Get-CimInstance Win32_Process -Filter "Name='ChatGPT.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -notmatch '--type=' } |
        ForEach-Object {
            $process = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
            if ($process -and $process.MainWindowHandle -ne 0) {
                [pscustomobject]@{
                    pid = $_.ProcessId
                    title = $process.MainWindowTitle
                    hasCdp = ($_.CommandLine -match '--remote-debugging-port')
                }
            }
        })
}

function Test-CdpAlive($port) {
    try {
        return (Invoke-WebRequest "http://127.0.0.1:$port/json/version" -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200
    } catch {
        return $false
    }
}

function Invoke-CdpCall($wsUrl, $payload) {
    $socket = [System.Net.WebSockets.ClientWebSocket]::new()
    try {
        $token = [System.Threading.CancellationToken]::None
        $socket.ConnectAsync([Uri]$wsUrl, $token).GetAwaiter().GetResult() | Out-Null
        $json = $payload | ConvertTo-Json -Compress -Depth 6
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
        $socket.SendAsync(
            [System.ArraySegment[byte]]::new($bytes),
            [System.Net.WebSockets.WebSocketMessageType]::Text,
            $true,
            $token
        ).GetAwaiter().GetResult() | Out-Null
        $buffer = New-Object byte[] 32768
        $received = $socket.ReceiveAsync(
            [System.ArraySegment[byte]]::new($buffer),
            $token
        ).GetAwaiter().GetResult()
        return [System.Text.Encoding]::UTF8.GetString($buffer, 0, $received.Count)
    } catch {
        return $null
    } finally {
        try { $socket.Dispose() } catch {}
    }
}

function Get-MainCodexTarget($port) {
    try {
        $targets = Invoke-RestMethod "http://127.0.0.1:$port/json" -TimeoutSec 3
    } catch {
        return $null
    }
    return $targets |
        Where-Object { $_.type -eq 'page' -and $_.url -like 'app://-/index.html*' } |
        Select-Object -First 1
}

$injectors = @(Get-InjectorProcesses)
$injector = $injectors | Select-Object -First 1
$injectorPid = if ($injector) { $injector.ProcessId } else { $null }
$injectorPort = if ($injector) { Get-InjectorPort $injector.CommandLine } else { $null }
$port = if ($CdpPort -gt 0) { $CdpPort } else { $injectorPort }

$base = [ordered]@{
    cdpPort = $port
    injectorPid = $injectorPid
    injectorCount = $injectors.Count
    visibleCodexWindows = @(Get-MainCodexWindowPids)
}

if (-not $port) {
    $base["status"] = "no-injector-port"
    Write-Report $base 2
}

if (-not (Test-CdpAlive $port)) {
    $base["status"] = "cdp-unreachable"
    Write-Report $base 2
}

$target = Get-MainCodexTarget $port
if (-not $target) {
    $base["status"] = "no-main-target"
    Write-Report $base 2
}

$expression = '(() => {' +
    ' const entry = document.querySelector("#codex-taskboard-entry");' +
    ' const page = document.querySelector("#codex-taskboard-page");' +
    ' const status = document.querySelector("#codex-taskboard-status");' +
    ' const injection = window.__codexTaskboardInjection__;' +
    ' const host = window.__CODEX_TASKBOARD_HOST_CAPABILITY__;' +
    ' return {' +
    '   hasInjection: !!(injection && typeof injection.open === "function"),' +
    '   hasHostCapability: !!host,' +
    '   entryMounted: !!entry,' +
    '   pageMounted: !!page,' +
    '   panelVisible: !!(page && !page.hidden && page.offsetWidth > 0),' +
    '   statusVisible: !!(status && !status.hidden),' +
    '   statusText: status && !status.hidden ? (status.innerText || "").replace(/\s+/g, " ").slice(0, 200) : ""' +
    ' };' +
    '})()'

$raw = Invoke-CdpCall $target.webSocketDebuggerUrl @{
    id     = 1
    method = "Runtime.evaluate"
    params = @{ expression = $expression; returnByValue = $true }
}

if (-not $raw) {
    $base["status"] = "cdp-evaluation-failed"
    $base["targetUrl"] = $target.url
    Write-Report $base 1
}

try {
    $state = ($raw | ConvertFrom-Json).result.result.value
} catch {
    $state = $null
}

$base["targetUrl"] = $target.url
$base["state"] = $state

$usable = $state `
    -and $state.hasInjection `
    -and $state.entryMounted `
    -and $state.panelVisible `
    -and (-not $state.statusVisible)

if ($usable) {
    $base["status"] = "panel-available"
    Write-Report $base 0
}

$base["status"] = "panel-unavailable"
Write-Report $base 1
