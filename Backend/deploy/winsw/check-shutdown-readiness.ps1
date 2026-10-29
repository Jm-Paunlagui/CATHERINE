<#
.SYNOPSIS
  READ-ONLY report: how much time the CATHERINE backend service gets to stop on a
  service stop and on a host reboot, and how the last few stops ended.

.DESCRIPTION
  Changes nothing. Run from an elevated PowerShell on the server (some service
  and event-log reads need admin). It reports:
    - the installed WinSW version and the controls the service accepts
      (ACCEPTS_SHUTDOWN = WinSW 2.x handles a host shutdown;
       ACCEPTS_PRESHUTDOWN = the preshutdown window is active, WinSW 3.x only)
    - the stop window (<stoptimeout>) and the host-reboot window
      (PreshutdownTimeout when preshutdown is accepted, otherwise the
       machine-wide WaitToKillServiceTimeout)
    - the restart marker dist\data\server-run.json
    - the System-log events that explain recent restarts
  See deploy/RESTART_VERIFICATION.md for what to do with the result.

.PARAMETER ServiceId
  Default: catherine-backend

.PARAMETER ExeName
  Backend executable process name. Default: catherine-backend.exe

.PARAMETER DisplayName
  Service display name, used to filter event 7036. Default: CATHERINE Backend

.EXAMPLE
  .\check-shutdown-readiness.ps1
#>
param(
    [string]$ServiceId = "catherine-backend",
    [string]$ExeName = "catherine-backend.exe",
    [string]$DisplayName = "CATHERINE Backend"
)

$ErrorActionPreference = "Continue"
function Section($t) { Write-Host ""; Write-Host "== $t" -ForegroundColor Cyan }
# Values read from the marker file and the event log are untrusted text: strip
# control characters (ESC sequences could rewrite the console, CWE-150) and the
# bidi direction controls (CWE-451), and keep each value on one line. Used for every printed value that comes from data.
function Clean($v) { ([string]$v) -replace '[\x00-\x08\x0A-\x1F\x7F-\x9F\u200E\u200F\u202A-\u202E\u2066-\u2069]', '?' }
function Row($k, $v) { Write-Host ("  {0,-34} {1}" -f $k, (Clean $v)) }

$svc = Get-CimInstance Win32_Service -Filter "Name='$ServiceId'" -ErrorAction SilentlyContinue
if (-not $svc) { Write-Host "Service '$ServiceId' is not installed." -ForegroundColor Red; exit 1 }

Section "Service"
Row "State" $svc.State
Row "Start mode" $svc.StartMode
Row "Service process id" $svc.ProcessId
$wrapper = ($svc.PathName -replace '^"([^"]+)".*$', '$1') -replace '^(\S+\.exe).*$', '$1'
Row "Wrapper" $wrapper
$winswVersion = $null
if (Test-Path $wrapper) {
    $winswVersion = (Get-Item $wrapper).VersionInfo.ProductVersion
    Row "WinSW version" $winswVersion
}
$query = (& sc.exe query $ServiceId) -join " "
$acceptsShutdown = $query -match "ACCEPTS_SHUTDOWN"
$acceptsPreshutdown = $query -match "ACCEPTS_PRESHUTDOWN"
Row "Accepts SHUTDOWN" $acceptsShutdown
Row "Accepts PRESHUTDOWN" $acceptsPreshutdown
if ($svc.State -ne "Running") { Write-Host "  (accepted controls are only reported while the service runs)" -ForegroundColor Yellow }

Section "Stop windows"
$dist = Split-Path $wrapper -Parent
$xmlPath = [System.IO.Path]::ChangeExtension($wrapper, ".xml")
$stopTimeout = $null
if (Test-Path $xmlPath) {
    [xml]$xml = Get-Content $xmlPath
    $stopTimeout = $xml.service.stoptimeout
    Row "Installed XML" $xmlPath
    Row "<stoptimeout> (service stop)" $stopTimeout
    Row "<preshutdown> in XML" ([bool]$xml.service.preshutdown)
}
$ctl = Get-ItemProperty "HKLM:\SYSTEM\CurrentControlSet\Control" -ErrorAction SilentlyContinue
$wtk = if ($ctl.WaitToKillServiceTimeout) { [int]$ctl.WaitToKillServiceTimeout } else { $null }
Row "WaitToKillServiceTimeout" ($(if ($wtk) { "$wtk ms" } else { "not set (Windows default, about 20 s)" }))
$svcKey = Get-ItemProperty "HKLM:\SYSTEM\CurrentControlSet\Services\$ServiceId" -ErrorAction SilentlyContinue
$pre = if ($svcKey.PreshutdownTimeout) { [int]$svcKey.PreshutdownTimeout } else { $null }
Row "PreshutdownTimeout (service)" ($(if ($pre) { "$pre ms" } else { "not set" }))

$rebootWindow = if ($acceptsPreshutdown -and $pre) { "$([math]::Round($pre/1000)) s (preshutdown)" }
                elseif ($acceptsShutdown) { "$(if ($wtk) { [math]::Round($wtk/1000) } else { '~20' }) s (WaitToKillServiceTimeout, via SHUTDOWN)" }
                else { "unknown (start the service and re-run)" }
Row "=> host-reboot window" $rebootWindow

Section "Restart marker"
$marker = Join-Path $dist "data\server-run.json"
if (Test-Path $marker) {
    try {
        $m = Get-Content $marker -Raw | ConvertFrom-Json
        Row "File" $marker
        Row "State" $m.state
        $hostOk = [string]::Equals([string]$m.hostname, $env:COMPUTERNAME, [StringComparison]::OrdinalIgnoreCase)
        Row "Host" "$($m.hostname) $(if ($hostOk) { '(this host)' } else { '(ANOTHER host - ignored on next start)' })"
        Row "Version" $m.version
        Row "Marker PID" $m.pid
        if ($m.lastHeartbeatAt) {
            $hb = [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$m.lastHeartbeatAt)
            $age = [int]([DateTimeOffset]::UtcNow - $hb).TotalSeconds
            Row "Last heartbeat" "$($hb.LocalDateTime) ($age s ago$(if ($m.state -eq 'RUNNING' -and $age -gt 90) { ' - STALE: the writer is not refreshing it' }))"
        }
        # Every $ExeName on the box. The service's own exe is the process
        # (single mode) or the cluster PRIMARY; its same-named children are
        # cluster workers, and the cron-leader worker owns this marker.
        # Anything outside that tree is a second copy (it would fight over this
        # marker and the scheduled jobs).
        $procs = @(Get-CimInstance Win32_Process -Filter "Name='$ExeName'" -ErrorAction SilentlyContinue)
        $main = $procs | Where-Object { $_.ParentProcessId -eq $svc.ProcessId } | Select-Object -First 1
        $workers = @($procs | Where-Object { $main -and $_.ParentProcessId -eq $main.ProcessId })
        $strays = @($procs | Where-Object { $_.ProcessId -ne $main.ProcessId -and $workers.ProcessId -notcontains $_.ProcessId })
        Row "Mode" $(if ($workers.Count -gt 0) { "cluster: primary $($main.ProcessId) + $($workers.Count) worker(s) (ENABLE_CLUSTERING=true)" } else { "single process ($($main.ProcessId))" })
        foreach ($p in $procs) {
            $role = if ($p.ProcessId -eq $main.ProcessId) { if ($workers.Count) { "primary" } else { "backend" } } elseif ($workers.ProcessId -contains $p.ProcessId) { "worker" } else { "NOT under the service" }
            $tag = if ($p.ProcessId -eq [int]$m.pid) { " [marker writer$(if ($role -eq 'worker') { ' = cron leader' })]" } else { "" }
            Row "$ExeName PID $($p.ProcessId)" "$role, started $($p.CreationDate)$tag"
        }
        if ($strays.Count -gt 0) { Write-Host "  WARNING: $($strays.Count) $ExeName process(es) outside the service's tree - a second copy is running." -ForegroundColor Yellow }
        if ($workers.Count -gt 0 -and $workers.ProcessId -notcontains [int]$m.pid) { Write-Host "  WARNING: in cluster mode the marker should be written by a worker (the cron leader)." -ForegroundColor Yellow }
        $writer = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$m.pid)" -ErrorAction SilentlyContinue
        if (-not $writer -and $m.state -eq "RUNNING") { Write-Host "  Marker PID $(Clean $m.pid) is not running (the record is from an earlier process)." -ForegroundColor Yellow }
        elseif ($writer -and $writer.Name -ne $ExeName) { Row "Marker PID process" "$($writer.Name), parent $($writer.ParentProcessId)" }
        # No .env or no PORT line must not turn the whole section into "unreadable".
        $portLine = Get-Content (Join-Path $dist ".env") -ErrorAction SilentlyContinue | Select-String '^\s*PORT\s*=' | Select-Object -First 1
        $port = if ($portLine) { ([regex]::Match([string]$portLine, '\d+')).Value } else { $null }
        if (-not $port) { $port = "3000" }
        $listen = Get-NetTCPConnection -State Listen -LocalPort ([int]$port) -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($listen) { Row "Listening on :$port" "PID $($listen.OwningProcess)" }
    } catch { Row "File" "$marker (unreadable: $($_.Exception.Message))" }
} else { Row "File" "$marker - not found (first start with restart tracking, or wrong dist)" }

Section "Recent System-log events (newest first)"
$ids = 1074, 6005, 6006, 6008, 41, 7031, 7034
try {
    # Two queries: 7036 ("entered the running/stopped state") is logged for EVERY
    # service, so mixing it in would push older restart events out of the window.
    $events = @(Get-WinEvent -FilterHashtable @{ LogName = "System"; Id = $ids } -MaxEvents 15 -ErrorAction SilentlyContinue)
    $events += @(Get-WinEvent -FilterHashtable @{ LogName = "System"; Id = 7036 } -MaxEvents 400 -ErrorAction SilentlyContinue |
        Where-Object { $_.Message -like "*$DisplayName*" } | Select-Object -First 10)
    $events | Sort-Object TimeCreated -Descending | Select-Object -First 20 |
        # First line only, control characters stripped, and the account that asked for a
        # restart (1074 "on behalf of user DOMAIN\name") left out: this report is often
        # pasted into chats and tickets, and the account name is not needed here.
        ForEach-Object {
            $line = Clean ((($_.Message -split "`n")[0]).Trim())
            $line = $line -replace '(on behalf of user ).+?(?= for the following reason|$)', '$1<account>'
            Write-Host ("  {0:yyyy-MM-dd HH:mm:ss}  {1,5}  {2}" -f $_.TimeCreated, $_.Id, $line)
        }
} catch { Write-Host "  (cannot read the System log: $($_.Exception.Message))" -ForegroundColor Yellow }
Write-Host "  1074 planned restart/shutdown, 6006 clean shutdown, 6005 boot,"
Write-Host "  6008/41 unexpected shutdown or power loss, 7031/7034 service ended unexpectedly."

Section "Summary"
if ($acceptsPreshutdown) {
    Write-Host "  Preshutdown is active: a host reboot gives the backend the preshutdown window."
} elseif ($acceptsShutdown) {
    Write-Host "  WinSW 2.x: a host reboot sends the service a stop and waits up to WaitToKillServiceTimeout."
    Write-Host "  A quiet server stops in about a second, so a reboot should normally read CLEAN."
    Write-Host "  A request still running when that window ends is cut and the next start reports UNCLEAN."
}
Write-Host "  Prove it once with deploy/RESTART_VERIFICATION.md (Windows section)."
