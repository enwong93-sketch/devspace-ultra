param(
    [ValidateSet("show", "install", "start", "stop", "remove", "status", "validate")]
    [string]$Action = "show"
)

$ErrorActionPreference = "Stop"
$taskName = "DevSpace-Live-Progress-Overlay"
$scriptPath = [System.IO.Path]::GetFullPath($MyInvocation.MyCommand.Path)
$progressFileName = "devspace-live-progress.json"
$controlFileName = "stable-gateway-control.json"
$strings = '{"waiting":"\u6211\u6703\u55ba\u5462\u5ea6\u4e3b\u52d5\u540c\u4f60\u8b1b\u6700\u65b0\u9032\u5ea6\u3002","waitingBackend":"\u6b63\u5728\u7b49\u5019 DevSpace \u5f8c\u7aef\u56de\u5fa9\u2026","staleHeartbeat":"\u5f8c\u7aefheartbeat\u5df2\u7d93 {0} \u79d2\u5187\u66f4\u65b0\uff1b\u6d6e\u7a97\u4ecd\u4fdd\u7559\u6700\u5f8c\u5df2\u78ba\u8a8d\u9032\u5ea6\uff0c\u7b49DevSpace Core\u6062\u5fa9\u5f8c\u6703\u81ea\u52d5\u63a5\u4f4f\u3002"}' | ConvertFrom-Json

$controlCandidates = @()
if ($env:DEVSPACE_CONFIG_DIR) {
    $controlCandidates += (Join-Path $env:DEVSPACE_CONFIG_DIR (Join-Path "logs" $controlFileName))
}
$controlCandidates += (Join-Path $env:USERPROFILE ".devspace-tailscale-bootstrap\logs\$controlFileName")
$controlCandidates += (Join-Path $env:USERPROFILE ".devspace\logs\$controlFileName")

$fallbackProgressCandidates = @()
if ($env:DEVSPACE_STATE_DIR) {
    $fallbackProgressCandidates += (Join-Path $env:DEVSPACE_STATE_DIR $progressFileName)
}
$fallbackProgressCandidates += (Join-Path $env:USERPROFILE ".local\share\devspace-tailscale-bootstrap\$progressFileName")
$fallbackProgressCandidates += (Join-Path $env:USERPROFILE ".local\share\devspace\$progressFileName")

function Get-OverlayProcesses {
    Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" -ErrorAction SilentlyContinue |
        Where-Object {
            $_.CommandLine -and
            $_.CommandLine -like "*$scriptPath*" -and
            $_.CommandLine -match '(?i)-Action\s+show'
        }
}

function Get-OverlayTask {
    Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
}

if ($Action -eq "validate") {
    [ordered]@{
        Ok = $true
        Width = 460
        Height = 340
        Topmost = $true
        Surface = "#FFFFFF"
        Source = "durable-state-file"
        NaturalLanguageStream = $true
        StatusBoard = $false
        ChatGptControl = $false
    } | ConvertTo-Json -Compress
    exit 0
}

switch ($Action) {
    "status" {
        $task = Get-OverlayTask
        $processes = @(Get-OverlayProcesses)
        [ordered]@{
            Ok = $true
            Installed = ($null -ne $task)
            TaskState = if ($task) { $task.State.ToString() } else { $null }
            Running = ($processes.Count -gt 0)
            ProcessIds = @($processes | ForEach-Object { [int]$_.ProcessId })
        } | ConvertTo-Json -Compress
        exit 0
    }
    "stop" {
        $task = Get-OverlayTask
        if ($task -and $task.State -eq "Running") {
            Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
            Start-Sleep -Milliseconds 300
        }
        foreach ($process in @(Get-OverlayProcesses)) {
            Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
        }
        Write-Output '{"ok":true,"state":"stopped"}'
        exit 0
    }
    "remove" {
        & $scriptPath -Action stop | Out-Null
        $task = Get-OverlayTask
        if ($task) { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false }
        Write-Output '{"ok":true,"state":"removed"}'
        exit 0
    }
    "install" {
        $existing = Get-OverlayTask
        if ($existing) {
            if ($existing.State -eq "Running") { Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue }
            Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
        }
        $arguments = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}" -Action show' -f $scriptPath
        $taskAction = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $arguments
        $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
        $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Seconds 0)
        $principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
        Register-ScheduledTask -TaskName $taskName -Action $taskAction -Trigger $trigger -Settings $settings -Principal $principal | Out-Null
        Start-ScheduledTask -TaskName $taskName
        Write-Output '{"ok":true,"state":"installed"}'
        exit 0
    }
    "start" {
        $task = Get-OverlayTask
        if ($task) {
            Start-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        } else {
            Start-Process powershell.exe -ArgumentList @("-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", $scriptPath, "-Action", "show") -WindowStyle Hidden | Out-Null
        }
        Write-Output '{"ok":true,"state":"started"}'
        exit 0
    }
}

$createdNew = $false
$mutexName = "Local\DevSpaceUltraLiveProgress-$($env:USERNAME)"
$mutex = New-Object System.Threading.Mutex($true, $mutexName, [ref]$createdNew)
if (-not $createdNew) { exit 0 }

try {
    Add-Type -AssemblyName PresentationFramework
    Add-Type -AssemblyName PresentationCore
    Add-Type -AssemblyName WindowsBase

    [xml]$xaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="DevSpace Ultra Progress"
        Width="460" Height="340"
        Topmost="True"
        ShowInTaskbar="False"
        WindowStyle="None"
        ResizeMode="NoResize"
        AllowsTransparency="True"
        Background="Transparent"
        UseLayoutRounding="True">
  <Border Background="#FFFFFF" BorderBrush="#E6E6E6" BorderThickness="1" CornerRadius="16" Padding="18">
    <Border.Effect>
      <DropShadowEffect BlurRadius="18" ShadowDepth="3" Opacity="0.16" Color="#000000" />
    </Border.Effect>
    <Grid>
      <Grid.RowDefinitions>
        <RowDefinition Height="Auto" />
        <RowDefinition Height="1" />
        <RowDefinition Height="*" />
      </Grid.RowDefinitions>

      <Grid x:Name="DragArea" Grid.Row="0" Margin="0,0,0,13">
        <Grid.ColumnDefinitions>
          <ColumnDefinition Width="*" />
          <ColumnDefinition Width="32" />
        </Grid.ColumnDefinitions>
        <TextBlock Text="DevSpace Ultra" FontFamily="Microsoft JhengHei UI" FontSize="13" FontWeight="SemiBold" Foreground="#202124" VerticalAlignment="Center" />
        <Button x:Name="CloseButton" Grid.Column="1" Content="x" Width="28" Height="28" FontFamily="Segoe UI" FontSize="15" Foreground="#7A7A7A" Background="Transparent" BorderThickness="0" Cursor="Hand" Padding="0" />
      </Grid>

      <Border Grid.Row="1" Height="1" Background="#EEEEEE" />

      <ScrollViewer x:Name="MessageScroll" Grid.Row="2" Margin="0,15,0,0" VerticalScrollBarVisibility="Auto" HorizontalScrollBarVisibility="Disabled" CanContentScroll="True">
        <TextBlock x:Name="TranscriptText" TextWrapping="Wrap" FontFamily="Microsoft JhengHei UI" FontSize="14" Foreground="#202124" LineHeight="23" Padding="0,0,8,6" />
      </ScrollViewer>
    </Grid>
  </Border>
</Window>
'@

    $reader = New-Object System.Xml.XmlNodeReader $xaml
    $window = [Windows.Markup.XamlReader]::Load($reader)
    $transcriptText = $window.FindName("TranscriptText")
    $messageScroll = $window.FindName("MessageScroll")
    $closeButton = $window.FindName("CloseButton")
    $dragArea = $window.FindName("DragArea")

    $window.Add_Loaded({
        $workArea = [System.Windows.SystemParameters]::WorkArea
        $window.Left = [Math]::Max($workArea.Left + 12, $workArea.Right - $window.Width - 24)
        $window.Top = $workArea.Top + 24
    })
    $dragArea.Add_MouseLeftButtonDown({ if ($_.ButtonState -eq [System.Windows.Input.MouseButtonState]::Pressed) { $window.DragMove() } })
    $closeButton.Add_Click({ $window.Close() })

    $script:loadedOnce = $false
    $script:lastSignature = ""
    $script:progressStatePath = $null
    $script:goalRunStatePath = $null

    function Resolve-ProgressStatePath {
        if ($script:progressStatePath -and (Test-Path -LiteralPath $script:progressStatePath)) {
            return $script:progressStatePath
        }

        foreach ($controlPath in $controlCandidates) {
            if (-not (Test-Path -LiteralPath $controlPath)) { continue }
            try {
                $control = [System.IO.File]::ReadAllText($controlPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
                $candidate = [string]$control.progressStatePath
                if (-not [string]::IsNullOrWhiteSpace($candidate) -and (Test-Path -LiteralPath $candidate)) {
                    $script:progressStatePath = [System.IO.Path]::GetFullPath($candidate)
                    return $script:progressStatePath
                }
            } catch {}
        }

        $existing = @($fallbackProgressCandidates |
            Where-Object { Test-Path -LiteralPath $_ } |
            ForEach-Object { Get-Item -LiteralPath $_ -ErrorAction SilentlyContinue } |
            Sort-Object LastWriteTimeUtc -Descending |
            Select-Object -First 1)
        if ($existing.Count -gt 0 -and $existing[0]) {
            $script:progressStatePath = $existing[0].FullName
            return $script:progressStatePath
        }
        return $null
    }

    function Set-Transcript($items, $liveText = $null) {
        $rows = @($items) | Select-Object -Last 7
        $parts = @()
        foreach ($row in $rows) {
            $text = [string]$row.text
            if (-not [string]::IsNullOrWhiteSpace($text)) { $parts += $text.Trim() }
        }
        if (-not [string]::IsNullOrWhiteSpace([string]$liveText)) {
            $parts += ([string]$liveText).Trim()
        }
        $transcript = if ($parts.Count -gt 0) { $parts -join "`r`n`r`n" } else { $strings.waiting }
        if ($transcript -eq $script:lastSignature) { return }
        $script:lastSignature = $transcript
        $transcriptText.Text = $transcript
        $messageScroll.Dispatcher.BeginInvoke([Action]{ $messageScroll.ScrollToEnd() }, [System.Windows.Threading.DispatcherPriority]::Background) | Out-Null
    }

    function Refresh-Progress {
        try {
            $path = Resolve-ProgressStatePath
            if (-not $path -or -not (Test-Path -LiteralPath $path)) {
                if (-not $script:loadedOnce) { $transcriptText.Text = $strings.waitingBackend }
                return
            }
            $json = [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8)
            $state = $json | ConvertFrom-Json
            if (-not $script:goalRunStatePath) {
                $script:goalRunStatePath = Join-Path ([System.IO.Path]::GetDirectoryName($path)) "devspace-goal-run-live.json"
            }
            $liveText = $null
            if (Test-Path -LiteralPath $script:goalRunStatePath) {
                try {
                    $runState = [System.IO.File]::ReadAllText($script:goalRunStatePath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
                    $liveText = [string]$runState.active.currentText
                    $heartbeatAt = [DateTimeOffset]::MinValue
                    if ([DateTimeOffset]::TryParse([string]$runState.active.heartbeatAt, [ref]$heartbeatAt)) {
                        $age = [Math]::Max(0, [int]([DateTimeOffset]::UtcNow - $heartbeatAt.ToUniversalTime()).TotalSeconds)
                        if ($age -gt 45 -and -not [string]::IsNullOrWhiteSpace($liveText)) {
                            $liveText = "$liveText`r`n`r`n$($strings.staleHeartbeat -f $age)"
                        }
                    }
                } catch {}
            }
            Set-Transcript $state.messages $liveText
            $script:loadedOnce = $true
        }
        catch {
            $script:progressStatePath = $null
            $script:goalRunStatePath = $null
            if (-not $script:loadedOnce) {
                $transcriptText.Text = $strings.waitingBackend
            }
        }
    }

    $timer = New-Object System.Windows.Threading.DispatcherTimer
    $timer.Interval = [TimeSpan]::FromMilliseconds(700)
    $timer.Add_Tick({ Refresh-Progress })
    $window.Add_Closed({ $timer.Stop() })

    Refresh-Progress
    $timer.Start()
    [void]$window.ShowDialog()
}
finally {
    if ($mutex) { try { $mutex.ReleaseMutex() } catch {}; $mutex.Dispose() }
}
