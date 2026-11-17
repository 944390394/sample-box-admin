# 双击「烧录固件.bat」打开。点一次：编译当前固件，然后用 ST-Link 反复尝试，直到写进去。
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$gcc = "C:\Users\94439\AppData\Local\stm32-tools\arm-gcc\xpack-arm-none-eabi-gcc-15.2.1-1.1\bin\arm-none-eabi-gcc.exe"
$objcopy = "C:\Users\94439\AppData\Local\stm32-tools\arm-gcc\xpack-arm-none-eabi-gcc-15.2.1-1.1\bin\arm-none-eabi-objcopy.exe"
$openocd = "C:\Users\94439\AppData\Local\Microsoft\WinGet\Packages\xpack-dev-tools.openocd-xpack_Microsoft.Winget.Source_8wekyb3d8bbwe\xpack-openocd-0.12.0-7\bin\openocd.exe"
$build = Join-Path $root "build"
$elf = Join-Path $build "led.elf"
$script:stop = $false

function Add-Log([string]$text) {
    $log.AppendText(($text -replace "`r`n", "`n").TrimEnd() + "`r`n")
    $log.SelectionStart = $log.TextLength
    $log.ScrollToCaret()
    [System.Windows.Forms.Application]::DoEvents()
}

function Build-Firmware {
    if (-not (Test-Path $gcc)) { throw "找不到编译器：$gcc" }
    New-Item -ItemType Directory -Force -Path $build | Out-Null
    $sources = @(Get-ChildItem (Join-Path $root "src\*.c") | ForEach-Object { $_.FullName })
    $args = @(
        "-mcpu=cortex-m0plus", "-mthumb", "-Os",
        "-ffunction-sections", "-fdata-sections", "-ffreestanding",
        "-Wall", "-Wextra", "-g3", "-Wl,--gc-sections", "-nostdlib",
        "-T$(Join-Path $root 'STM32L051C8Tx_FLASH.ld')",
        "-o", $elf
    ) + $sources + @((Join-Path $root "startup\startup_stm32l051xx.s"), "-lgcc")
    $out = & $gcc @args 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) { throw "编译失败`r`n$out" }
    & $objcopy -O binary $elf (Join-Path $build "led.bin")
    if ($out.Trim()) { Add-Log $out.Trim() }
    Add-Log "编译完成"
}

function Flash-Once {
    $elfFwd = ($elf -replace '\\', '/')
    $out = & $openocd -f interface/stlink.cfg -c "transport select swd" -f target/stm32l0.cfg -c "program $elfFwd verify reset exit" 2>&1 | Out-String
    return @{ Ok = ($LASTEXITCODE -eq 0 -and $out -match "Verified OK"); Text = $out }
}

$form = New-Object System.Windows.Forms.Form
$form.Text = "烧录固件"
$form.Size = New-Object System.Drawing.Size(560, 460)
$form.StartPosition = "CenterScreen"
$form.Font = New-Object System.Drawing.Font("Microsoft YaHei UI", 10)

$status = New-Object System.Windows.Forms.Label
$status.Location = New-Object System.Drawing.Point(16, 16)
$status.Size = New-Object System.Drawing.Size(510, 48)
$status.Text = "点「烧录」。板子在休眠时请按一下复位键，程序会一直试到写进去。"

$button = New-Object System.Windows.Forms.Button
$button.Text = "烧录"
$button.Location = New-Object System.Drawing.Point(16, 72)
$button.Size = New-Object System.Drawing.Size(160, 40)

$stopButton = New-Object System.Windows.Forms.Button
$stopButton.Text = "停止"
$stopButton.Location = New-Object System.Drawing.Point(188, 72)
$stopButton.Size = New-Object System.Drawing.Size(100, 40)
$stopButton.Enabled = $false

$log = New-Object System.Windows.Forms.TextBox
$log.Location = New-Object System.Drawing.Point(16, 128)
$log.Size = New-Object System.Drawing.Size(510, 270)
$log.Multiline = $true
$log.ScrollBars = "Vertical"
$log.ReadOnly = $true
$log.Font = New-Object System.Drawing.Font("Consolas", 9)

$button.Add_Click({
    $script:stop = $false
    $button.Enabled = $false
    $stopButton.Enabled = $true
    $log.Clear()
    try {
        if (-not (Test-Path $openocd)) { throw "找不到 ST-Link 工具：$openocd" }
        $status.Text = "正在编译…"
        Add-Log "正在编译"
        Build-Firmware
        $try = 0
        while (-not $script:stop) {
            $try++
            $status.Text = "第 $try 次连接。连不上就按一下复位键。"
            Add-Log "第 $try 次"
            $result = Flash-Once
            $line = ($result.Text -split "`n" | Where-Object { $_ -match "Verified OK|init mode failed|Error:|voltage" } | Select-Object -Last 3) -join " "
            if ($line) { Add-Log $line.Trim() }
            if ($result.Ok) {
                $status.Text = "烧录完成，已校验并复位。"
                Add-Log "烧录完成"
                break
            }
            [System.Windows.Forms.Application]::DoEvents()
        }
        if ($script:stop) {
            $status.Text = "已停止。"
            Add-Log "已停止"
        }
    } catch {
        $status.Text = "失败。"
        Add-Log $_.Exception.Message
    } finally {
        $button.Enabled = $true
        $stopButton.Enabled = $false
    }
})

$stopButton.Add_Click({ $script:stop = $true })
$form.Controls.AddRange(@($status, $button, $stopButton, $log))
[void]$form.ShowDialog()
