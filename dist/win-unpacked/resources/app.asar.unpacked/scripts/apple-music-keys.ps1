# Send Apple Music menu access keys for shuffle or repeat.
# Usage: apple-music-keys.ps1 shuffle | repeat
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('shuffle', 'repeat')]
    [string]$Action
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class MusicWin32 {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
"@

$key = if ($Action -eq 'shuffle') { 's' } else { 'r' }

$proc = Get-Process | Where-Object { $_.ProcessName -match '^(AppleMusic|Music)$' } | Select-Object -First 1
if ($null -eq $proc -or $proc.MainWindowHandle -eq [IntPtr]::Zero) {
    [Console]::Error.WriteLine('[apple-music-keys] Apple Music not found')
    exit 1
}

[void][MusicWin32]::ShowWindow($proc.MainWindowHandle, 9)
[void][MusicWin32]::SetForegroundWindow($proc.MainWindowHandle)
Start-Sleep -Milliseconds 120

# Apple Music access keys: Alt, L, then S (shuffle) or R (repeat)
[System.Windows.Forms.SendKeys]::SendWait('%')
Start-Sleep -Milliseconds 60
[System.Windows.Forms.SendKeys]::SendWait('l')
Start-Sleep -Milliseconds 60
[System.Windows.Forms.SendKeys]::SendWait($key)
