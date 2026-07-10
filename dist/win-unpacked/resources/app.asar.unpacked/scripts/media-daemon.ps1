# Persistent media control daemon — loads WinRT once, reads commands from stdin.
# Commands: toggle | next | previous

Add-Type -AssemblyName System.Runtime.WindowsRuntime

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.ToString() -eq 'System.Threading.Tasks.Task`1[TResult] AsTask[TResult](Windows.Foundation.IAsyncOperation`1[TResult])'
})[0]

Function AwaitAction($WinRtAction) {
    $asTask = $asTaskGeneric.MakeGenericMethod([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
    $netTask = $asTask.Invoke($null, @($WinRtAction))
    $netTask.Wait() | Out-Null
    $netTask.Result
}

Function AwaitBool($WinRtAction) {
    $asTask = $asTaskGeneric.MakeGenericMethod([bool])
    $netTask = $asTask.Invoke($null, @($WinRtAction))
    $netTask.Wait() | Out-Null
    $netTask.Result
}

[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media, ContentType = WindowsRuntime] | Out-Null

$script:CachedManager = $null

function Get-Manager {
    if ($null -ne $script:CachedManager) { return $script:CachedManager }
    $script:CachedManager = AwaitAction([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync())
    return $script:CachedManager
}

function Get-TargetSession($manager) {
    $sessions = $manager.GetSessions()
    foreach ($session in $sessions) {
        $id = $session.SourceAppUserModelId
        if ($id -match 'AppleInc|AppleMusic|music\.exe') {
            return $session
        }
    }
    return $manager.GetCurrentSession()
}

function Invoke-MediaAction([string]$action) {
    try {
        $manager = Get-Manager
        $session = Get-TargetSession $manager
        if ($null -eq $session) { return }
        $task = $session."Try${action}Async"()
        [void](AwaitBool $task)
    } catch {}
}

while ($null -ne ($line = [Console]::In.ReadLine())) {
    switch ($line.Trim()) {
        'toggle'   { Invoke-MediaAction 'TogglePlayPause' }
        'next'     { Invoke-MediaAction 'SkipNext' }
        'previous' { Invoke-MediaAction 'SkipPrevious' }
    }
}
