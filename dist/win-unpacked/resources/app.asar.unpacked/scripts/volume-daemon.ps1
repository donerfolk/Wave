# Per-app volume daemon — Apple Music / AMPLibraryAgent only (never system volume).
# Commands: get | set <0-100> | adjust <delta> | mute <0|1>

Add-Type @"
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;

public static class MusicVolume
{
    static readonly string[] PreferredProcessNames = { "AppleMusic", "Music", "iTunes" };
    static readonly string[] FallbackProcessNames = { "AMPLibraryAgent" };

    static bool IsPreferredProcess(string name)
    {
        if (string.IsNullOrEmpty(name)) return false;
        foreach (var preferred in PreferredProcessNames)
        {
            if (string.Equals(name, preferred, StringComparison.OrdinalIgnoreCase)) return true;
        }
        return false;
    }

    static bool IsFallbackProcess(string name)
    {
        if (string.IsNullOrEmpty(name)) return false;
        foreach (var fallback in FallbackProcessNames)
        {
            if (string.Equals(name, fallback, StringComparison.OrdinalIgnoreCase)) return true;
        }
        return false;
    }

    static string GetProcessName(uint pid)
    {
        if (pid == 0) return null;
        try { return Process.GetProcessById((int)pid).ProcessName; }
        catch { return null; }
    }

    static bool IsMusicProcess(string name)
    {
        return IsPreferredProcess(name) || IsFallbackProcess(name);
    }

    // Active preferred > active fallback > inactive preferred > inactive fallback
    static int SessionRank(int state, bool preferred)
    {
        bool active = state == 1;
        if (active && preferred) return 3;
        if (active && !preferred) return 2;
        if (!active && preferred) return 1;
        return 0;
    }

    static bool ForEachMusicSession(Action<ISimpleAudioVolume> action)
    {
        IMMDeviceEnumerator deviceEnumerator = (IMMDeviceEnumerator)(new MMDeviceEnumerator());
        IMMDevice speakers;
        deviceEnumerator.GetDefaultAudioEndpoint(EDataFlow.eRender, ERole.eMultimedia, out speakers);

        Guid IID_IAudioSessionManager2 = typeof(IAudioSessionManager2).GUID;
        object o;
        speakers.Activate(ref IID_IAudioSessionManager2, 0, IntPtr.Zero, out o);
        IAudioSessionManager2 mgr = (IAudioSessionManager2)o;

        IAudioSessionEnumerator sessionEnumerator;
        mgr.GetSessionEnumerator(out sessionEnumerator);
        int count;
        sessionEnumerator.GetCount(out count);

        bool handled = false;
        for (int i = 0; i < count; i++)
        {
            IAudioSessionControl ctl;
            sessionEnumerator.GetSession(i, out ctl);
            try
            {
                var ctl2 = (IAudioSessionControl2)(object)ctl;
                uint pid;
                ctl2.GetProcessId(out pid);
                string processName = GetProcessName(pid);
                if (!IsMusicProcess(processName)) continue;

                handled = true;
                var vol = (ISimpleAudioVolume)(object)ctl;
                action(vol);
            }
            catch { }
            finally
            {
                Marshal.ReleaseComObject(ctl);
            }
        }

        Marshal.ReleaseComObject(sessionEnumerator);
        Marshal.ReleaseComObject(mgr);
        Marshal.ReleaseComObject(speakers);
        Marshal.ReleaseComObject(deviceEnumerator);
        return handled;
    }

    static bool TryReadBestSession(out int volumePct, out bool muted)
    {
        volumePct = 0;
        muted = false;

        IMMDeviceEnumerator deviceEnumerator = (IMMDeviceEnumerator)(new MMDeviceEnumerator());
        IMMDevice speakers;
        deviceEnumerator.GetDefaultAudioEndpoint(EDataFlow.eRender, ERole.eMultimedia, out speakers);

        Guid IID_IAudioSessionManager2 = typeof(IAudioSessionManager2).GUID;
        object o;
        speakers.Activate(ref IID_IAudioSessionManager2, 0, IntPtr.Zero, out o);
        IAudioSessionManager2 mgr = (IAudioSessionManager2)o;

        IAudioSessionEnumerator sessionEnumerator;
        mgr.GetSessionEnumerator(out sessionEnumerator);
        int count;
        sessionEnumerator.GetCount(out count);

        bool found = false;
        int bestRank = -1;
        for (int i = 0; i < count; i++)
        {
            IAudioSessionControl ctl;
            sessionEnumerator.GetSession(i, out ctl);
            try
            {
                var ctl2 = (IAudioSessionControl2)(object)ctl;
                uint pid;
                ctl2.GetProcessId(out pid);
                string processName = GetProcessName(pid);
                if (!IsMusicProcess(processName)) continue;

                int state;
                ctl.GetState(out state);
                int rank = SessionRank(state, IsPreferredProcess(processName));
                if (rank < bestRank) continue;

                var vol = (ISimpleAudioVolume)(object)ctl;
                float level;
                bool isMuted;
                vol.GetMasterVolume(out level);
                vol.GetMute(out isMuted);

                bestRank = rank;
                volumePct = (int)Math.Round(level * 100);
                muted = isMuted;
                found = true;
            }
            catch { }
            finally
            {
                Marshal.ReleaseComObject(ctl);
            }
        }

        Marshal.ReleaseComObject(sessionEnumerator);
        Marshal.ReleaseComObject(mgr);
        Marshal.ReleaseComObject(speakers);
        Marshal.ReleaseComObject(deviceEnumerator);
        return found;
    }

    public static string GetStateJson()
    {
        int pct;
        bool muted;
        if (!TryReadBestSession(out pct, out muted))
            return "{\"volume\":0,\"muted\":false,\"available\":false}";
        return "{\"volume\":" + pct + ",\"muted\":" + (muted ? "true" : "false") + ",\"available\":true}";
    }

    public static void SetVolume(int level)
    {
        int clamped = Math.Max(0, Math.Min(100, level));
        Guid guid = Guid.Empty;
        ForEachMusicSession(vol =>
        {
            vol.SetMasterVolume(clamped / 100f, ref guid);
            if (clamped > 0) vol.SetMute(false, ref guid);
        });
    }

    public static void SetMuted(bool muted)
    {
        Guid guid = Guid.Empty;
        ForEachMusicSession(vol => vol.SetMute(muted, ref guid));
    }

    public static void Adjust(int delta)
    {
        int currentPct;
        bool wasMuted;
        if (!TryReadBestSession(out currentPct, out wasMuted)) return;

        int clamped = Math.Max(0, Math.Min(100, currentPct + delta));
        Guid guid = Guid.Empty;
        ForEachMusicSession(vol =>
        {
            if (wasMuted && delta > 0) vol.SetMute(false, ref guid);
            vol.SetMasterVolume(clamped / 100f, ref guid);
        });
    }
}

[ComImport]
[Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
class MMDeviceEnumerator { }

enum EDataFlow { eRender, eCapture, eAll, EDataFlow_enum_count }
enum ERole { eConsole, eMultimedia, eCommunications, ERole_enum_count }

[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator
{
    int NotImpl1();
    [PreserveSig] int GetDefaultAudioEndpoint(EDataFlow dataFlow, ERole role, out IMMDevice ppDevice);
}

[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice
{
    [PreserveSig] int Activate(ref Guid iid, int dwClsCtx, IntPtr pActivationParams, [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface);
}

[Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionManager2
{
    int NotImpl1();
    int NotImpl2();
    [PreserveSig] int GetSessionEnumerator(out IAudioSessionEnumerator SessionEnum);
}

[Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionEnumerator
{
    [PreserveSig] int GetCount(out int SessionCount);
    [PreserveSig] int GetSession(int SessionCount, out IAudioSessionControl Session);
}

[Guid("F4B1A599-7266-4319-A8CA-E70ACB11E8CD"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionControl
{
    [PreserveSig] int GetState(out int pRetVal);
    [PreserveSig] int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string value);
    [PreserveSig] int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string value, ref Guid eventContext);
    [PreserveSig] int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string value);
    [PreserveSig] int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string value, ref Guid eventContext);
    [PreserveSig] int GetGroupingParam(out Guid groupingId);
    [PreserveSig] int SetGroupingParam(ref Guid groupingId, ref Guid eventContext);
    [PreserveSig] int RegisterAudioSessionNotification(IntPtr client);
    [PreserveSig] int UnregisterAudioSessionNotification(IntPtr client);
}

[Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionControl2
{
    [PreserveSig] int GetState(out int pRetVal);
    [PreserveSig] int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string value);
    [PreserveSig] int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string value, ref Guid eventContext);
    [PreserveSig] int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string value);
    [PreserveSig] int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string value, ref Guid eventContext);
    [PreserveSig] int GetGroupingParam(out Guid groupingId);
    [PreserveSig] int SetGroupingParam(ref Guid groupingId, ref Guid eventContext);
    [PreserveSig] int RegisterAudioSessionNotification(IntPtr client);
    [PreserveSig] int UnregisterAudioSessionNotification(IntPtr client);
    [PreserveSig] int GetSessionIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string retVal);
    [PreserveSig] int GetSessionInstanceIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string retVal);
    [PreserveSig] int GetProcessId(out uint pProcessId);
    [PreserveSig] int IsSystemSoundsSession();
    [PreserveSig] int SetDuckingPreference(bool optOut);
}

[Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ISimpleAudioVolume
{
    [PreserveSig] int SetMasterVolume(float fLevel, ref Guid EventContext);
    [PreserveSig] int GetMasterVolume(out float pfLevel);
    [PreserveSig] int SetMute(bool bMute, ref Guid EventContext);
    [PreserveSig] int GetMute(out bool pbMute);
}
"@

while ($null -ne ($line = [Console]::In.ReadLine())) {
    $trimmed = $line.Trim()
    try {
        if ($trimmed -eq 'get') {
            [Console]::Out.WriteLine([MusicVolume]::GetStateJson())
            continue
        }
        if ($trimmed -match '^set (\d+)$') {
            [MusicVolume]::SetVolume([int]$Matches[1])
            continue
        }
        if ($trimmed -match '^adjust (-?\d+)$') {
            [MusicVolume]::Adjust([int]$Matches[1])
            continue
        }
        if ($trimmed -match '^mute ([01])$') {
            [MusicVolume]::SetMuted($Matches[1] -eq '1')
            continue
        }
    } catch {
        [Console]::Error.WriteLine($_.Exception.Message)
    }
}
