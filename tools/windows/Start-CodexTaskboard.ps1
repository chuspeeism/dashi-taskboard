#Requires -Version 5.1
<#
.SYNOPSIS
    启动带任务面板的 Codex 桌面版（Windows）。

.DESCRIPTION
    Codex 桌面版必须带 --remote-debugging-port 启动，Taskboard 注入器才能通过 CDP
    挂载面板。本脚本用日常 Codex profile 启动 Codex 并开启 CDP，然后让
    codex-injector.mjs 常驻注入，最后在 Codex 主窗口打开任务面板。

    脚本会关闭现有的 Codex 主进程，使新的 CDP 启动参数生效。进行中的对话会中断，
    Codex 重新打开后会自动恢复。使用 -NoRestart 可以只走快速路径，不关闭任何进程。

.PARAMETER CdpPort
    传给 Codex 的 CDP 端口，默认 9231。

.PARAMETER CodexApp
    ChatGPT.exe 的完整路径。省略时从当前用户的 OpenAI.Codex 应用包自动发现。

.PARAMETER TaskboardDir
    Taskboard 仓库或安装目录。省略时使用本脚本的上两级目录。

.PARAMETER UserDataDir
    可选的 Codex 用户数据目录。省略时使用 Codex 日常 profile。

.PARAMETER NoRestart
    仅尝试快速路径。若 Codex 未带 CDP 运行，脚本失败退出而不关闭任何进程。

.EXAMPLE
    .\Start-CodexTaskboard.ps1

.EXAMPLE
    .\Start-CodexTaskboard.ps1 -CdpPort 9232 -UserDataDir "$env:TEMP\codex-taskboard-isolated"
#>
[CmdletBinding()]
param(
    [int]$CdpPort = 9231,
    [string]$CodexApp,
    [string]$TaskboardDir,
    [string]$UserDataDir,
    [switch]$NoRestart
)

$ErrorActionPreference = "Continue"
$ProgressPreference = "SilentlyContinue"
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$startedAt = Get-Date

function Write-Step($message) {
    $elapsed = [int]((Get-Date) - $startedAt).TotalSeconds
    Write-Host ("[{0:mm\:ss}] +{1,2}s {2}" -f (Get-Date), $elapsed, $message)
}

function Write-Ok($message) { Write-Host $message -ForegroundColor Green }

function Write-Fail($message) {
    Write-Host ""
    Write-Host $message -ForegroundColor Red
    exit 1
}

function Resolve-TaskboardDirectory($explicitPath) {
    $candidates = @()
    if ($explicitPath) {
        if (-not (Test-Path -LiteralPath $explicitPath)) {
            throw "Taskboard directory does not exist: $explicitPath"
        }
        $candidates += (Resolve-Path -LiteralPath $explicitPath).Path
    } else {
        $candidates += (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..\..")).Path
    }
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath (Join-Path $candidate "scripts\codex-injector.mjs")) {
            return $candidate
        }
        if (Test-Path -LiteralPath (Join-Path $candidate "app\scripts\codex-injector.mjs")) {
            return $candidate
        }
    }
    throw "Unable to locate codex-injector.mjs. Pass -TaskboardDir explicitly."
}

function Resolve-CodexAppPath($explicitPath) {
    if ($explicitPath) {
        if (-not (Test-Path -LiteralPath $explicitPath)) {
            throw "Codex executable does not exist: $explicitPath"
        }
        return (Resolve-Path -LiteralPath $explicitPath).Path
    }
    $package = Get-AppxPackage |
        Where-Object { $_.Name -like "OpenAI.Codex*" } |
        Sort-Object Version -Descending |
        Select-Object -First 1
    if (-not $package) {
        throw "The OpenAI.Codex app package is not installed for the current user."
    }
    $candidate = Join-Path $package.InstallLocation "app\ChatGPT.exe"
    if (-not (Test-Path -LiteralPath $candidate)) {
        throw "Unable to find ChatGPT.exe under $($package.InstallLocation)"
    }
    return $candidate
}

function Resolve-NodeExecutable($taskboardPath) {
    $bundled = Join-Path $taskboardPath "node.exe"
    if (Test-Path -LiteralPath $bundled) { return $bundled }
    $command = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    throw "node.exe not found. Install Node.js or place node.exe in the Taskboard directory."
}

function Resolve-InjectorPath($taskboardPath) {
    foreach ($relativePath in @("scripts\codex-injector.mjs", "app\scripts\codex-injector.mjs")) {
        $candidate = Join-Path $taskboardPath $relativePath
        if (Test-Path -LiteralPath $candidate) { return $candidate }
    }
    throw "Unable to locate codex-injector.mjs under $taskboardPath"
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

function Invoke-CdpEval($port, $expression) {
    $target = Get-MainCodexTarget $port
    if (-not $target) { return $null }
    $raw = Invoke-CdpCall $target.webSocketDebuggerUrl @{
        id     = 1
        method = "Runtime.evaluate"
        params = @{ expression = $expression; returnByValue = $true }
    }
    if (-not $raw) { return $null }
    try { $obj = $raw | ConvertFrom-Json } catch { return $null }
    return $obj.result.result.value
}

# 只读探测。openTaskboard() 只能调用一次；重复调用会打断上一次准备流程。
function Get-PanelState($port) {
    $state = Invoke-CdpEval $port ('(() => {' +
        ' const t = window.__codexTaskboardInjection__;' +
        ' if (!t || typeof t.open !== "function") return "no-injection";' +
        ' const page = document.querySelector("#codex-taskboard-page");' +
        ' const status = document.querySelector("#codex-taskboard-status");' +
        ' const visible = !!(page && !page.hidden && page.offsetWidth > 0);' +
        ' if (visible && status && status.hidden) return "open";' +
        ' if (visible && status && !status.hidden) return "error:" + (status.innerText || "").replace(/\s+/g, " ").slice(0, 70);' +
        ' return "loading";' +
        '})()')
    if ($null -eq $state) { return "no-target" }
    return [string]$state
}

function Test-EntryInjected($port) {
    return (Invoke-CdpEval $port '!!document.querySelector("#codex-taskboard-entry")') -eq $true
}

function Invoke-PanelOpen($port) {
    return (Invoke-CdpEval $port '(() => { const t = window.__codexTaskboardInjection__; if (!t || typeof t.open !== "function") return false; t.open(); return true; })()') -eq $true
}

function Reset-CodexPage($port) {
    $target = Get-MainCodexTarget $port
    if (-not $target) { return $false }
    $raw = Invoke-CdpCall $target.webSocketDebuggerUrl @{
        id     = 2
        method = "Page.reload"
        params = @{ ignoreCache = $true }
    }
    return [bool]$raw
}

function Test-InjectorAlive($port) {
    return [bool](Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -match 'codex-injector' -and $_.CommandLine -match "--port\s+$port(?=\s|$)" })
}

function Stop-TaskboardInjector($port) {
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -match 'codex-injector' -and $_.CommandLine -match "--port\s+$port(?=\s|$)" } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

function Start-TaskboardInjector($taskboardPath, $nodePath, $injectorPath, $codexPath, $port) {
    $logDir = Join-Path $env:LOCALAPPDATA "Codex Taskboard\Logs"
    $injectorLog = Join-Path $logDir "manual-launch.log"
    if (-not (Test-Path -LiteralPath $logDir)) {
        New-Item -ItemType Directory -Path $logDir -Force | Out-Null
    }
    $argLine = '"' + $injectorPath + '" --port ' + $port + ' --watch --app-path "' + $codexPath + '"'
    Start-Process -FilePath $nodePath -ArgumentList $argLine -WorkingDirectory $taskboardPath -WindowStyle Hidden `
        -RedirectStandardOutput $injectorLog -RedirectStandardError ($injectorLog + ".err")
    for ($i = 0; $i -lt 40; $i++) {
        Start-Sleep -Milliseconds 250
        if (Test-InjectorAlive $port) { return $true }
    }
    return $false
}

function Start-PanelAndWait($port, $timeoutSeconds) {
    if (-not (Invoke-PanelOpen $port)) { return "no-injection" }
    $deadline = (Get-Date).AddSeconds($timeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 300
        $state = Get-PanelState $port
        if ($state -eq "open") { return "open" }
    }
    return (Get-PanelState $port)
}

function Wait-EntryInjected($port, $timeoutSeconds) {
    $deadline = (Get-Date).AddSeconds($timeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if (Test-EntryInjected $port) { return $true }
        Start-Sleep -Milliseconds 300
    }
    return $false
}

try {
    $resolvedTaskboardDir = Resolve-TaskboardDirectory $TaskboardDir
    $resolvedCodexApp = Resolve-CodexAppPath $CodexApp
    $resolvedNode = Resolve-NodeExecutable $resolvedTaskboardDir
    $resolvedInjector = Resolve-InjectorPath $resolvedTaskboardDir
} catch {
    Write-Fail $_.Exception.Message
}

Write-Step "Taskboard: $resolvedTaskboardDir"
Write-Step "Codex: $resolvedCodexApp"
Write-Step "CDP port: $CdpPort"

# 快速路径：Codex 与注入器都已就绪时只打开面板。
if ((Test-CdpAlive $CdpPort) -and (Test-InjectorAlive $CdpPort)) {
    $fastState = Start-PanelAndWait $CdpPort 6
    if ($fastState -eq "open") {
        Write-Ok "Done (fast path). The Taskboard panel is open."
        exit 0
    }
    if ($fastState -eq "no-injection") {
        Write-Step "The page lost the injection script; reloading the renderer..."
        Reset-CodexPage $CdpPort | Out-Null
        if (Wait-EntryInjected $CdpPort 20) {
            $fastState = Start-PanelAndWait $CdpPort 15
            if ($fastState -eq "open") {
                Write-Ok "Done (renderer reloaded). The Taskboard panel is open."
                exit 0
            }
        }
    }
    if ($NoRestart) {
        Write-Fail "Fast path failed ($fastState), and -NoRestart is set."
    }
    Write-Step "Fast path failed ($fastState); restarting Codex..."
} elseif ($NoRestart) {
    Write-Fail "Codex is not running with CDP on port $CdpPort, and -NoRestart is set."
}

Write-Step "1/6 Stopping Codex, Taskboard launcher, and stale injectors"
Get-CimInstance Win32_Process -Filter "Name='codex-taskboard-launcher.exe'" -ErrorAction SilentlyContinue |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Get-CimInstance Win32_Process -Filter "Name='ChatGPT.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -notmatch '--type=' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Stop-TaskboardInjector $CdpPort
$exitDeadline = (Get-Date).AddSeconds(10)
while ((Get-Date) -lt $exitDeadline) {
    $still = Get-CimInstance Win32_Process -Filter "Name='ChatGPT.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -notmatch '--type=' }
    if (-not $still) { break }
    Start-Sleep -Milliseconds 250
}

Write-Step "2/6 Starting Codex with CDP on port $CdpPort"
$codexArgs = @(
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=$CdpPort",
    "--remote-allow-origins=http://127.0.0.1:$CdpPort"
)
if ($UserDataDir) {
    $resolvedUserDataDir = [IO.Path]::GetFullPath($UserDataDir)
    $codexArgs = @("--user-data-dir=$resolvedUserDataDir") + $codexArgs
    Write-Step "Isolated profile: $resolvedUserDataDir"
}
Start-Process -FilePath $resolvedCodexApp -ArgumentList $codexArgs

Write-Step "3/6 Waiting for the CDP endpoint"
$portDeadline = (Get-Date).AddSeconds(60)
$portReady = $false
while ((Get-Date) -lt $portDeadline) {
    if (Test-CdpAlive $CdpPort) { $portReady = $true; break }
    Start-Sleep -Milliseconds 300
}
if (-not $portReady) {
    Write-Fail "Codex CDP port $CdpPort did not become ready."
}

Write-Step "4/6 Starting the Taskboard injector"
if (-not (Start-TaskboardInjector $resolvedTaskboardDir $resolvedNode $resolvedInjector $resolvedCodexApp $CdpPort)) {
    Write-Fail "The Taskboard injector did not stay running."
}

Write-Step "5/6 Waiting for injection"
if (-not (Wait-EntryInjected $CdpPort 30)) {
    Write-Host "The sidebar entry did not appear; opening the panel anyway." -ForegroundColor Yellow
}

Write-Step "6/6 Opening the Taskboard panel"
$state = Start-PanelAndWait $CdpPort 20
if ($state -ne "open") {
    Write-Step "First attempt failed ($state); reloading and retrying..."
    Reset-CodexPage $CdpPort | Out-Null
    if (Wait-EntryInjected $CdpPort 20) {
        $state = Start-PanelAndWait $CdpPort 20
    }
}

$total = [int]((Get-Date) - $startedAt).TotalSeconds
Write-Host ""
if ($state -eq "open") {
    Write-Ok "Done. The Taskboard panel is open in the Codex main window (${total}s)."
    exit 0
}
Write-Fail "The Taskboard panel did not open. State: $state (${total}s)."
