# Apple Music shuffle/repeat — UI Automation for playback bar buttons.
# Usage: apple-music-playback.ps1 shuffle | repeat | query

param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('shuffle', 'repeat', 'query')]
    [string]$Action
)

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

# ponytail: one UIA session at a time — concurrent query + toggle crashes Apple Music
$mutex = New-Object System.Threading.Mutex($false, 'Global\WaveAppleMusicUIA')
if (-not $mutex.WaitOne(30000)) {
    [Console]::Error.WriteLine('[apple-music-playback] busy')
    exit 1
}

try {

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class MusicWin32 {
    public const int SW_SHOWNOACTIVATE = 4;
    public const int SW_MINIMIZE = 6;
    public const int DWMWA_CLOAK = 13;
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("dwmapi.dll")] public static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int val, int sz);
}
"@

function Get-AppleMusicProcess {
    return Get-Process -Name 'AppleMusic', 'Music' -ErrorAction SilentlyContinue | Select-Object -First 1
}

function Set-Cloak([IntPtr]$hwnd, [int]$on) {
    [void][MusicWin32]::DwmSetWindowAttribute($hwnd, [MusicWin32]::DWMWA_CLOAK, [ref]$on, 4)
}

function Invoke-WithoutWindowFlash([scriptblock]$Action) {
    $proc = Get-AppleMusicProcess
    if ($null -eq $proc -or $proc.MainWindowHandle -eq [IntPtr]::Zero) {
        & $Action
        return
    }

    $hwnd = $proc.MainWindowHandle
    $wasMinimized = [MusicWin32]::IsIconic($hwnd)

    # ponytail: UIA Toggle() needs the window realized (non-minimized), which makes it surface
    # on screen. DWM cloaking (what UWP uses internally) keeps it rendered+UIA-interactive but
    # fully invisible — no flash, no foreground steal. finally always uncloaks so a mid-run
    # failure can't strand Apple Music invisible.
    if (-not $wasMinimized) {
        & $Action
        return
    }

    Set-Cloak $hwnd 1
    [void][MusicWin32]::ShowWindow($hwnd, [MusicWin32]::SW_SHOWNOACTIVATE)
    try {
        & $Action
        Start-Sleep -Milliseconds 400
    } finally {
        [void][MusicWin32]::ShowWindow($hwnd, [MusicWin32]::SW_MINIMIZE)
        Set-Cloak $hwnd 0
    }
}

function Get-PlaybackBar {
    $proc = Get-AppleMusicProcess
    if ($null -eq $proc -or $proc.MainWindowHandle -eq [IntPtr]::Zero) {
        return $null
    }

    $root = [System.Windows.Automation.AutomationElement]::FromHandle($proc.MainWindowHandle)
    $skipCond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::NameProperty, 'Skip Forward')
    $skip = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $skipCond)
    if ($null -eq $skip) {
        return $null
    }

    return [System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($skip)
}

function Find-BarButton([string]$NamePattern) {
    $bar = Get-PlaybackBar
    if ($null -eq $bar) { return $null }

    $children = $bar.FindAll(
        [System.Windows.Automation.TreeScope]::Children,
        [System.Windows.Automation.Condition]::TrueCondition)

    foreach ($child in $children) {
        if ($child.Current.ControlType.ProgrammaticName -ne 'ControlType.Button') { continue }
        $name = $child.Current.Name
        if ($name -notmatch $NamePattern) { continue }
        return $child
    }

    return $null
}

function Get-ToggleOn($element) {
    try {
        $toggle = $element.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
        if ($null -ne $toggle) {
            return $toggle.Current.ToggleState -eq [System.Windows.Automation.ToggleState]::On
        }
    } catch {}

    return $false
}

function Get-RepeatMode($element) {
    $name = $element.Current.Name
    if ($name -match 'one') { return 'one' }
    if ($name -match 'all') { return 'all' }
    if (Get-ToggleOn $element) { return 'all' }
    return 'off'
}

function Invoke-Element($element) {
    try {
        $toggle = $element.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
        if ($null -ne $toggle) {
            $toggle.Toggle()
            return $true
        }
    } catch {}

    try {
        $invoke = $element.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
        if ($null -ne $invoke) {
            $invoke.Invoke()
            return $true
        }
    } catch {}

    return $false
}

function Invoke-BarButton([string]$NamePattern) {
    $btn = Find-BarButton $NamePattern
    if ($null -eq $btn) {
        [Console]::Error.WriteLine("[apple-music-playback] No button matching '$NamePattern'")
        exit 1
    }

    if (Invoke-Element $btn) { return }

    [Console]::Error.WriteLine("[apple-music-playback] Button '$($btn.Current.Name)' could not be activated")
    exit 1
}

function Get-PlaybackState {
    $shuffle = $false
    $repeat = 'off'

    $shuffleBtn = Find-BarButton '^Shuffle$'
    if ($null -ne $shuffleBtn) { $shuffle = Get-ToggleOn $shuffleBtn }

    $repeatBtn = Find-BarButton 'Repeat|Do Not Repeat'
    if ($null -ne $repeatBtn) { $repeat = Get-RepeatMode $repeatBtn }

    return @{ shuffle = $shuffle; repeat = $repeat }
}

switch ($Action) {
    'shuffle' { Invoke-WithoutWindowFlash { Invoke-BarButton '^Shuffle$' } }
    'repeat'  { Invoke-WithoutWindowFlash { Invoke-BarButton 'Repeat|Do Not Repeat' } }
    'query'   {
        $state = Get-PlaybackState
        $state | ConvertTo-Json -Compress
    }
}

} finally {
    $mutex.ReleaseMutex()
    $mutex.Dispose()
}
