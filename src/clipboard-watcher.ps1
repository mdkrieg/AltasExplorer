#Requires -Version 5
# ---------------------------------------------------------------------------
# clipboard-watcher.ps1 — persistent OS clipboard change listener (Windows)
#
# Registers a hidden window with AddClipboardFormatListener so it receives a
# WM_CLIPBOARDUPDATE message every time ANY application changes the clipboard
# (including rdpclip.exe / VMware Tools syncing a remote/guest clipboard).
#
# On each change — and once at startup — it reads the clipboard and writes a
# single compact JSON line to stdout:
#
#   {"event":"change","type":"files","data":["C:\\a.txt"],"seq":123}
#   {"event":"change","type":"image","data":"<base64 png>","seq":124}
#   {"event":"change","type":"text","data":"hello","seq":125}
#   {"event":"change","type":"empty","seq":126}
#
# The parent (Electron main process) parses these lines and forwards them to
# the renderer. This avoids spawning a fresh PowerShell per read and works even
# when the app window is not focused.
#
# Must run under Windows PowerShell in STA mode (-Sta) so System.Windows.Forms
# .Clipboard can be accessed. Reads are retried briefly to ride out the short
# window where a remote/guest clipboard sync is still settling.
# ---------------------------------------------------------------------------

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type -ReferencedAssemblies 'System.Windows.Forms' -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;

// A never-visible Form that listens for clipboard-update messages.
public class AtlasClipboardListener : Form {
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool AddClipboardFormatListener(IntPtr hwnd);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool RemoveClipboardFormatListener(IntPtr hwnd);
    [DllImport("user32.dll")]
    private static extern uint GetClipboardSequenceNumber();

    private const int WM_CLIPBOARDUPDATE = 0x031D;

    public event Action ClipboardUpdated;

    public AtlasClipboardListener() {
        this.ShowInTaskbar = false;
        this.FormBorderStyle = FormBorderStyle.None;
        // Creating the handle is enough to receive messages; the form stays hidden.
        AddClipboardFormatListener(this.Handle);
    }

    // Force the form to never become visible.
    protected override void SetVisibleCore(bool value) {
        base.SetVisibleCore(false);
    }

    protected override void WndProc(ref Message m) {
        if (m.Msg == WM_CLIPBOARDUPDATE) {
            var handler = ClipboardUpdated;
            if (handler != null) handler();
        }
        base.WndProc(ref m);
    }

    protected override void Dispose(bool disposing) {
        try { RemoveClipboardFormatListener(this.Handle); } catch { }
        base.Dispose(disposing);
    }

    public static uint Sequence() { return GetClipboardSequenceNumber(); }
}
"@

# Write one compact JSON line to stdout and flush immediately so the parent
# process sees it without buffering delay.
function Write-Json($obj) {
    $json = ConvertTo-Json $obj -Compress -Depth 6
    [Console]::Out.WriteLine($json)
    [Console]::Out.Flush()
}

# Read the current clipboard into a normalized payload. Retries briefly to ride
# out remote/guest (RDP/VMware) sync settling, where the update message can fire
# a beat before the data is actually available.
function Read-Clipboard {
    $seq = [AtlasClipboardListener]::Sequence()
    $attempts = 0
    while ($true) {
        $attempts++
        try {
            if ([System.Windows.Forms.Clipboard]::ContainsFileDropList()) {
                $list = [System.Windows.Forms.Clipboard]::GetFileDropList()
                $paths = @()
                foreach ($p in $list) { $paths += [string]$p }
                if ($paths.Count -gt 0) {
                    return [ordered]@{ event = 'change'; type = 'files'; data = @($paths); seq = $seq }
                }
            }
            elseif ([System.Windows.Forms.Clipboard]::ContainsImage()) {
                $img = [System.Windows.Forms.Clipboard]::GetImage()
                if ($img -ne $null) {
                    $ms = New-Object System.IO.MemoryStream
                    $img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
                    $b64 = [Convert]::ToBase64String($ms.ToArray())
                    $ms.Dispose()
                    return [ordered]@{ event = 'change'; type = 'image'; data = $b64; seq = $seq }
                }
            }
            elseif ([System.Windows.Forms.Clipboard]::ContainsText()) {
                $t = [System.Windows.Forms.Clipboard]::GetText()
                if ($t -and $t.Trim().Length -gt 0) {
                    return [ordered]@{ event = 'change'; type = 'text'; data = $t; seq = $seq }
                }
            }
            # Nothing useful (or a transient lock that cleared): treat as empty.
            return [ordered]@{ event = 'change'; type = 'empty'; seq = $seq }
        }
        catch {
            # Clipboard momentarily locked by another app — retry a few times.
            if ($attempts -ge 3) {
                return [ordered]@{ event = 'change'; type = 'empty'; seq = $seq }
            }
            Start-Sleep -Milliseconds 80
        }
    }
}

$listener = New-Object AtlasClipboardListener
$listener.add_ClipboardUpdated({
    try { Write-Json (Read-Clipboard) } catch { }
})

# Emit the current state immediately so the parent has a value before the first
# change occurs.
try { Write-Json (Read-Clipboard) } catch { }

# Pump Windows messages so WM_CLIPBOARDUPDATE is delivered. Blocks until the
# parent kills this process.
[System.Windows.Forms.Application]::Run()
