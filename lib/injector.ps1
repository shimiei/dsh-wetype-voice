# dsh-wetype-voice keyboard injector.
#
# Long-lived helper: reads one command per line on stdin and writes one result
# line per command on stdout, so the host plugin pays the Add-Type compile cost
# exactly once instead of on every microphone click.
#
# Protocol (UTF-8, one record per line):
#   PING
#     -> READY|1
#   SEND|<hotkey>|<guard>|<leadMs>|<mode>
#     hotkey: ctrl+alt+space / lctrl+rshift+f7 / alt+0 ...
#     guard : any | auto:<exe name> | list:<exe1>;<exe2>
#     mode  : scan (scan codes) | vk (virtual keys)
#     -> OK|<hotkey> | SKIP|<reason> | ERR|<message>
#   STATE|<title needle>
#     -> OK|visible|<class>|<title>|<hwnd> | OK|hidden
#   QUIT
#     -> BYE
#
# Windows only. Uses SendInput with KEYEVENTF_SCANCODE so the injected keys
# carry real scan codes (left/right modifiers stay distinguishable), which is
# what IME hotkey handlers usually key off.

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class WvInput
{
    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

    [StructLayout(LayoutKind.Sequential)]
    public struct HARDWAREINPUT { public uint uMsg; public ushort wParamL; public ushort wParamH; }

    [StructLayout(LayoutKind.Explicit)]
    public struct INPUTUNION
    {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
        [FieldOffset(0)] public HARDWAREINPUT hi;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT { public uint type; public INPUTUNION u; }

    public const uint INPUT_KEYBOARD = 1;
    public const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
    public const uint KEYEVENTF_KEYUP = 0x0002;
    public const uint KEYEVENTF_SCANCODE = 0x0008;

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr OpenProcess(uint dwDesiredAccess, bool bInheritHandle, uint dwProcessId);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool QueryFullProcessImageNameW(IntPtr hProcess, uint dwFlags, StringBuilder lpExeName, ref uint lpdwSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr hObject);

    public static INPUT Key(ushort scan, bool extended, bool up)
    {
        INPUT input = new INPUT();
        input.type = INPUT_KEYBOARD;
        input.u.ki.wVk = 0;
        input.u.ki.wScan = scan;
        input.u.ki.dwFlags = KEYEVENTF_SCANCODE
            | (extended ? KEYEVENTF_EXTENDEDKEY : 0)
            | (up ? KEYEVENTF_KEYUP : 0);
        input.u.ki.time = 0;
        input.u.ki.dwExtraInfo = IntPtr.Zero;
        return input;
    }

    // Virtual-key variant: what a low-level hook reports in KBDLLHOOKSTRUCT.vkCode
    // even when the sender only filled in wVk.
    public static INPUT KeyVk(ushort vk, ushort scan, bool extended, bool up)
    {
        INPUT input = new INPUT();
        input.type = INPUT_KEYBOARD;
        input.u.ki.wVk = vk;
        input.u.ki.wScan = scan;
        input.u.ki.dwFlags = 0
            | (extended ? KEYEVENTF_EXTENDEDKEY : 0)
            | (up ? KEYEVENTF_KEYUP : 0);
        input.u.ki.time = 0;
        input.u.ki.dwExtraInfo = IntPtr.Zero;
        return input;
    }

    public static uint Send(INPUT[] inputs)
    {
        return SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
    }

    public static string ForegroundImageName()
    {
        IntPtr hwnd = GetForegroundWindow();
        if (hwnd == IntPtr.Zero) return "";
        uint pid;
        GetWindowThreadProcessId(hwnd, out pid);
        if (pid == 0) return "";
        IntPtr proc = OpenProcess(0x1000 /* PROCESS_QUERY_LIMITED_INFORMATION */, false, pid);
        if (proc == IntPtr.Zero) return "";
        try
        {
            StringBuilder sb = new StringBuilder(1024);
            uint size = 1024;
            if (!QueryFullProcessImageNameW(proc, 0, sb, ref size)) return "";
            return sb.ToString();
        }
        finally { CloseHandle(proc); }
    }

    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetClassNameW(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    // WeType keeps its dictation surface as a normally-hidden Flutter window
    // (class starts with "wetype.", title is the localized "voice input" label).
    // Visibility of that window is a reliable "is it listening" probe.
    public static string FindVisibleWeTypeWindow(string titleNeedle)
    {
        string found = "";
        EnumWindows(delegate(IntPtr hWnd, IntPtr lParam)
        {
            if (!IsWindowVisible(hWnd)) return true;
            StringBuilder cls = new StringBuilder(256);
            GetClassNameW(hWnd, cls, cls.Capacity);
            if (cls.ToString().IndexOf("wetype", StringComparison.OrdinalIgnoreCase) < 0) return true;
            StringBuilder title = new StringBuilder(256);
            GetWindowTextW(hWnd, title, title.Capacity);
            string text = title.ToString();
            if (titleNeedle.Length > 0 && text.IndexOf(titleNeedle, StringComparison.OrdinalIgnoreCase) < 0) return true;
            found = cls.ToString() + "|" + text + "|0x" + hWnd.ToInt64().ToString("X");
            return false;
        }, IntPtr.Zero);
        return found;
    }
}
'@

# Scan codes: physical set-1 codes. Extended flag is required for right-hand
# modifiers and the navigation/arrow cluster on Windows.
$script:ScanCodes = @{
    'escape' = 0x01; 'esc' = 0x01; 'tab' = 0x0F; 'enter' = 0x1C; 'return' = 0x1C
    'space' = 0x39; 'backspace' = 0x0E
    '0' = 0x0B; '1' = 0x02; '2' = 0x03; '3' = 0x04; '4' = 0x05; '5' = 0x06
    '6' = 0x07; '7' = 0x08; '8' = 0x09; '9' = 0x0A
    'a' = 0x1E; 'b' = 0x30; 'c' = 0x2E; 'd' = 0x20; 'e' = 0x12; 'f' = 0x21
    'g' = 0x22; 'h' = 0x23; 'i' = 0x17; 'j' = 0x24; 'k' = 0x25; 'l' = 0x26
    'm' = 0x32; 'n' = 0x31; 'o' = 0x18; 'p' = 0x19; 'q' = 0x10; 'r' = 0x13
    's' = 0x1F; 't' = 0x14; 'u' = 0x16; 'v' = 0x2F; 'w' = 0x11; 'x' = 0x2D
    'y' = 0x15; 'z' = 0x2C
    '`' = 0x29; '-' = 0x0C; '=' = 0x0D; '[' = 0x1A; ']' = 0x1B; '\' = 0x2B
    ';' = 0x27; "'" = 0x28; ',' = 0x33; '.' = 0x34; '/' = 0x35
    'f1' = 0x3B; 'f2' = 0x3C; 'f3' = 0x3D; 'f4' = 0x3E; 'f5' = 0x3F; 'f6' = 0x40
    'f7' = 0x41; 'f8' = 0x42; 'f9' = 0x43; 'f10' = 0x44; 'f11' = 0x57; 'f12' = 0x58
    'left' = 0x4B; 'right' = 0x4D; 'up' = 0x48; 'down' = 0x50
    'delete' = 0x53; 'insert' = 0x52; 'home' = 0x47; 'end' = 0x4F
}

# Modifier scan code + extended flag.
$script:Modifiers = @{
    'ctrl' = @(0x1D, $false); 'control' = @(0x1D, $false)
    'lctrl' = @(0x1D, $false); 'lcontrol' = @(0x1D, $false)
    'rctrl' = @(0x1D, $true); 'rcontrol' = @(0x1D, $true)
    'shift' = @(0x2A, $false); 'lshift' = @(0x2A, $false); 'rshift' = @(0x36, $false)
    'alt' = @(0x38, $false); 'lalt' = @(0x38, $false); 'ralt' = @(0x38, $true)
    'win' = @(0x5B, $true); 'lwin' = @(0x5B, $true); 'rwin' = @(0x5C, $true)
    'meta' = @(0x5B, $true); 'cmd' = @(0x5B, $true)
}

# Virtual-key codes, used by the 'vk' injection mode.
$script:VkCodes = @{
    'escape' = 0x1B; 'esc' = 0x1B; 'tab' = 0x09; 'enter' = 0x0D; 'return' = 0x0D
    'space' = 0x20; 'backspace' = 0x08
    '0' = 0x30; '1' = 0x31; '2' = 0x32; '3' = 0x33; '4' = 0x34; '5' = 0x35
    '6' = 0x36; '7' = 0x37; '8' = 0x38; '9' = 0x39
    'add' = 0x6B; 'subtract' = 0x6D; 'multiply' = 0x6A; 'divide' = 0x6F
    '`' = 0xC0; '-' = 0xBD; '=' = 0xBB; '[' = 0xDB; ']' = 0xDD; '\' = 0xDC
    ';' = 0xBA; "'" = 0xDE; ',' = 0xBC; '.' = 0xBE; '/' = 0xBF
    'left' = 0x25; 'up' = 0x26; 'right' = 0x27; 'down' = 0x28
    'delete' = 0x2E; 'insert' = 0x2D; 'home' = 0x24; 'end' = 0x23
}
for ($i = 0; $i -lt 26; $i++) { $script:VkCodes[[string][char](97 + $i)] = [uint16](0x41 + $i) }
for ($i = 1; $i -le 24; $i++) { $script:VkCodes["f$i"] = [uint16](0x6F + $i) }

$script:ModifierVk = @{
    'ctrl' = 0xA2; 'control' = 0xA2; 'lctrl' = 0xA2; 'lcontrol' = 0xA2
    'rctrl' = 0xA3; 'rcontrol' = 0xA3
    'shift' = 0xA0; 'lshift' = 0xA0; 'rshift' = 0xA1
    'alt' = 0xA4; 'lalt' = 0xA4; 'ralt' = 0xA5
    'win' = 0x5B; 'lwin' = 0x5B; 'rwin' = 0x5C; 'meta' = 0x5B; 'cmd' = 0x5B
}

function Test-Guard {
    param([string] $Guard)

    if ([string]::IsNullOrWhiteSpace($Guard) -or $Guard -eq 'any') { return $null }

    $image = [WvInput]::ForegroundImageName()
    $name = ''
    if (-not [string]::IsNullOrEmpty($image)) { $name = [System.IO.Path]::GetFileName($image) }

    if ($Guard -like 'auto:*') {
        $expected = $Guard.Substring(5)
        if ($name -ieq $expected) { return $null }
        # Electron helper windows may belong to the same product under a
        # different image name; allow the matching prefix as a courtesy.
        if ($name -and $expected -and ($name -ieq $expected -or $name.StartsWith([System.IO.Path]::GetFileNameWithoutExtension($expected)))) { return $null }
        return "foreground is '$name', expected '$expected'"
    }

    if ($Guard -like 'list:*') {
        $names = $Guard.Substring(5).Split(';') | Where-Object { $_ -and $_.Trim() -ne '' }
        foreach ($n in $names) { if ($name -ieq $n.Trim()) { return $null } }
        return "foreground is '$name', not in allow list"
    }

    return $null
}

function Invoke-Hotkey {
    param([string] $Spec, [string] $Guard, [int] $LeadMs = 60, [string] $Mode = 'scan')

    $skip = Test-Guard -Guard $Guard
    if ($null -ne $skip) { return "SKIP|$skip" }

    $tokens = $Spec.ToLowerInvariant().Split('+') | Where-Object { $_ -ne '' }
    if ($tokens.Count -eq 0) { return 'ERR|empty hotkey' }

    $main = $tokens[$tokens.Count - 1]
    if (-not $script:ScanCodes.ContainsKey($main)) { return "ERR|unknown key '$main'" }

    $mods = @()
    for ($i = 0; $i -lt $tokens.Count - 1; $i++) {
        $m = $tokens[$i]
        if (-not $script:Modifiers.ContainsKey($m)) { return "ERR|unknown modifier '$m'" }
        $mods += , @($script:Modifiers[$m][0], $script:Modifiers[$m][1], $script:ModifierVk[$m], $m)
    }

    Start-Sleep -Milliseconds $LeadMs

    $events = New-Object System.Collections.Generic.List[object]
    foreach ($m in $mods) {
        if ($Mode -eq 'vk') { $events.Add([WvInput]::KeyVk([uint16]$m[2], [uint16]$m[0], [bool]$m[1], $false)) }
        else { $events.Add([WvInput]::Key([uint16]$m[0], [bool]$m[1], $false)) }
    }
    $mainScan = [uint16]$script:ScanCodes[$main]
    $mainVk = 0
    if ($script:VkCodes.ContainsKey($main)) { $mainVk = [uint16]$script:VkCodes[$main] }
    if ($Mode -eq 'vk') {
        if ($mainVk -eq 0) { return "ERR|no virtual-key code for '$main'" }
        $events.Add([WvInput]::KeyVk($mainVk, $mainScan, $false, $false))
        $events.Add([WvInput]::KeyVk($mainVk, $mainScan, $false, $true))
    } else {
        $events.Add([WvInput]::Key($mainScan, $false, $false))
        $events.Add([WvInput]::Key($mainScan, $false, $true))
    }
    for ($i = $mods.Count - 1; $i -ge 0; $i--) {
        if ($Mode -eq 'vk') { $events.Add([WvInput]::KeyVk([uint16]$mods[$i][2], [uint16]$mods[$i][0], [bool]$mods[$i][1], $true)) }
        else { $events.Add([WvInput]::Key([uint16]$mods[$i][0], [bool]$mods[$i][1], $true)) }
    }

    $sent = [WvInput]::Send($events.ToArray())
    if ($sent -ne $events.Count) {
        $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
        return "ERR|SendInput sent $sent/$($events.Count) events (win32 $err)"
    }
    return "OK|$Spec"
}

function Write-Line {
    param([string] $Text)
    [Console]::Out.WriteLine($Text)
    [Console]::Out.Flush()
}

# Is WeType's dictation window currently on screen?
#   STATE|<title needle>  ->  OK|visible|<class>|<title>|<hwnd>  |  OK|hidden
function Get-VoiceState {
    param([string] $Needle = '语音')
    $found = [WvInput]::FindVisibleWeTypeWindow($Needle)
    if ([string]::IsNullOrEmpty($found)) { return 'OK|hidden' }
    return "OK|visible|$found"
}

Write-Line 'READY|1'

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    $line = $line.Trim()
    if ($line -eq '') { continue }

    if ($line -eq 'QUIT') { Write-Line 'BYE'; break }
    if ($line -eq 'PING') { Write-Line 'READY|1'; continue }

    if ($line -like 'SEND|*') {
        $parts = $line.Split('|')
        $spec = if ($parts.Count -ge 2) { $parts[1] } else { '' }
        $guard = if ($parts.Count -ge 3 -and $parts[2] -ne '') { $parts[2] } else { 'any' }
        $lead = if ($parts.Count -ge 4 -and $parts[3] -ne '') { [int]$parts[3] } else { 60 }
        $mode = if ($parts.Count -ge 5 -and $parts[4] -ne '') { $parts[4] } else { 'scan' }
        try {
            Write-Line (Invoke-Hotkey -Spec $spec -Guard $guard -LeadMs $lead -Mode $mode)
        } catch {
            Write-Line ("ERR|" + $_.Exception.Message)
        }
        continue
    }

    if ($line -eq 'STATE' -or $line -like 'STATE|*') {
        $needle = '语音'
        if ($line -like 'STATE|*') {
            $needle = $line.Substring(6)
            if ([string]::IsNullOrEmpty($needle)) { $needle = '语音' }
        }
        try {
            Write-Line (Get-VoiceState -Needle $needle)
        } catch {
            Write-Line ("ERR|" + $_.Exception.Message)
        }
        continue
    }

    Write-Line "ERR|unknown command '$line'"
}
