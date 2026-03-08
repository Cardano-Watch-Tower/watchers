# WATCHDOG — Overnight process guardian for CardanoWatchTower
# Monitors: agent (always-on) + drain-trace (finite job)
# Run: powershell -ExecutionPolicy Bypass -File watchdog.ps1
# Checks every 5 minutes. Restarts crashed processes. Logs everything.

$AgentDir = "C:\Users\thisc\Documents\Projects\CardanoWatchTower\watchers\agent"
$ScanDir  = "C:\Users\thisc\Documents\Projects\CardanoWatchTower\watchers\investigations\genesis-trace\tools"
$LogFile  = "C:\Users\thisc\Documents\Projects\CardanoWatchTower\watchers\watchdog.log"
$CheckInterval = 300  # seconds between checks
$StaleMinutes  = 10   # log not updated = stalled

function Log($msg) {
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $line = "[$ts] $msg"
    Write-Host $line
    Add-Content -Path $LogFile -Value $line
}

function Find-Process($pattern) {
    $procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'"
    foreach ($p in $procs) {
        if ($p.CommandLine -match $pattern) {
            return $p.ProcessId
        }
    }
    return $null
}

function Is-LogStale($logPath, $minutes) {
    if (-not (Test-Path $logPath)) { return $true }
    $lastWrite = (Get-Item $logPath).LastWriteTime
    return ((Get-Date) - $lastWrite).TotalMinutes -gt $minutes
}

function Start-Agent {
    Log "RESTART: Starting agent..."
    Start-Process -FilePath "node" -ArgumentList "src/index.js" `
        -WorkingDirectory $AgentDir -WindowStyle Hidden `
        -RedirectStandardOutput "$AgentDir\agent.log" `
        -RedirectStandardError "$AgentDir\agent-err.log"
    Start-Sleep -Seconds 5
    $pid = Find-Process "src/index.js"
    if ($pid) { Log "RESTART: Agent alive at PID $pid" }
    else { Log "RESTART: Agent failed to start!" }
}

function Start-DrainTrace {
    # Check if drain-trace is already complete
    $progressFile = "$ScanDir\output\drain-trace-progress.json"
    if (Test-Path $progressFile) {
        $content = Get-Content $progressFile -Raw | ConvertFrom-Json
        if ($content.complete -eq $true) {
            Log "DRAIN: Drain-trace already complete. Skipping restart."
            return "complete"
        }
    }

    Log "RESTART: Starting drain-trace..."
    Start-Process -FilePath "node" -ArgumentList "drain-trace.js" `
        -WorkingDirectory $ScanDir -WindowStyle Hidden `
        -RedirectStandardOutput "$ScanDir\drain-trace.log" `
        -RedirectStandardError "$ScanDir\drain-trace-err.log"
    Start-Sleep -Seconds 5
    $pid = Find-Process "drain-trace"
    if ($pid) { Log "RESTART: Drain-trace alive at PID $pid" }
    else { Log "RESTART: Drain-trace failed to start!" }
    return "running"
}

# --- Main Loop ---
Log "========================================="
Log "WATCHDOG STARTED"
Log "Monitoring: Agent + Drain-Trace"
Log "Check interval: ${CheckInterval}s | Stale threshold: ${StaleMinutes}min"
Log "========================================="

while ($true) {
    # --- Check Agent ---
    $agentPid = Find-Process "src/index\.js"
    if (-not $agentPid) {
        Log "ALERT: Agent process not found! Restarting..."
        Start-Agent
    } else {
        $agentStale = Is-LogStale "$AgentDir\agent.log" $StaleMinutes
        if ($agentStale) {
            Log "ALERT: Agent log stale (>$StaleMinutes min). Killing PID $agentPid and restarting..."
            Stop-Process -Id $agentPid -Force -ErrorAction SilentlyContinue
            Start-Sleep -Seconds 2
            Start-Agent
        } else {
            Log "OK: Agent running (PID $agentPid)"
        }
    }

    # --- Check Drain-Trace ---
    $drainPid = Find-Process "drain-trace"
    if (-not $drainPid) {
        # Process gone — check if it finished or crashed
        $progressFile = "$ScanDir\output\drain-trace-progress.json"
        $drainComplete = $false
        if (Test-Path $progressFile) {
            $content = Get-Content $progressFile -Raw | ConvertFrom-Json
            if ($content.complete -eq $true) {
                $drainComplete = $true
            }
        }

        if ($drainComplete) {
            Log "DONE: Drain-trace complete! All addresses processed."
            Log "NEXT: Ready for link-chain aggregator re-run"
        } else {
            # Check error log for crash info
            $errLog = "$ScanDir\drain-trace-err.log"
            if (Test-Path $errLog) {
                $errContent = Get-Content $errLog -Tail 3
                if ($errContent) {
                    Log "CRASH: Drain-trace crashed with: $($errContent -join ' | ')"
                }
            }
            Log "ALERT: Drain-trace not found and not complete. Restarting..."
            Start-DrainTrace
        }
    } else {
        $drainStale = Is-LogStale "$ScanDir\drain-trace.log" $StaleMinutes
        if ($drainStale) {
            Log "ALERT: Drain-trace log stale (>$StaleMinutes min). Killing PID $drainPid and restarting..."
            Stop-Process -Id $drainPid -Force -ErrorAction SilentlyContinue
            Start-Sleep -Seconds 2
            Start-DrainTrace
        } else {
            Log "OK: Drain-trace running (PID $drainPid)"
        }
    }

    Start-Sleep -Seconds $CheckInterval
}
