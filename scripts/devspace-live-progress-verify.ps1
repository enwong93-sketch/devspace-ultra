param([int]$ProcessId = 0)
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class DevSpaceWindowProbe {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  public static IntPtr[] VisibleWindowsForPid(uint pid) {
    var list = new List<IntPtr>();
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p == pid && IsWindowVisible(h)) list.Add(h);
      return true;
    }, IntPtr.Zero);
    return list.ToArray();
  }
}
'@

if ($ProcessId -le 0) {
  $candidate = Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'devspace-live-progress-overlay\.ps1' -and $_.CommandLine -match '(?i)-Action\s+show' } |
    Select-Object -First 1
  if (-not $candidate) { throw "overlay-process-not-found" }
  $ProcessId = [int]$candidate.ProcessId
}

$windows = @()
foreach ($handle in [DevSpaceWindowProbe]::VisibleWindowsForPid([uint32]$ProcessId)) {
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
  if (-not $root) { continue }
  $items = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  $names = @()
  foreach ($item in $items) {
    $name = [string]$item.Current.Name
    if (-not [string]::IsNullOrWhiteSpace($name)) { $names += $name }
  }
  $rect = $root.Current.BoundingRectangle
  $windows += [ordered]@{
    Handle = $handle.ToInt64()
    Name = $root.Current.Name
    Left = [math]::Round($rect.Left)
    Top = [math]::Round($rect.Top)
    Width = [math]::Round($rect.Width)
    Height = [math]::Round($rect.Height)
    Offscreen = $root.Current.IsOffscreen
    Text = $names
  }
}
[ordered]@{ Ok = ($windows.Count -gt 0); ProcessId = $ProcessId; Windows = $windows } | ConvertTo-Json -Depth 5 -Compress
