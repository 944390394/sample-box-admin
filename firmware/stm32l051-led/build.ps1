$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$gccBin = "C:\Users\94439\AppData\Local\stm32-tools\arm-gcc\xpack-arm-none-eabi-gcc-15.2.1-1.1\bin"
$openocd = "C:\Users\94439\AppData\Local\Microsoft\WinGet\Packages\xpack-dev-tools.openocd-xpack_Microsoft.Winget.Source_8wekyb3d8bbwe\xpack-openocd-0.12.0-7\bin\openocd.exe"
$build = Join-Path $root "build"
New-Item -ItemType Directory -Force -Path $build | Out-Null

$elf = Join-Path $build "led.elf"
$bin = Join-Path $build "led.bin"
$sources = @(Get-ChildItem (Join-Path $root "src\*.c") | ForEach-Object { $_.FullName })
$gccArgs = @(
    "-mcpu=cortex-m0plus",
    "-mthumb",
    "-Os",
    "-ffunction-sections",
    "-fdata-sections",
    "-ffreestanding",
    "-Wall",
    "-Wextra",
    "-g3",
    "-Wl,--gc-sections",
    "-nostdlib",
    "-T$(Join-Path $root 'STM32L051C8Tx_FLASH.ld')",
    "-o", $elf
) + $sources + @(
    (Join-Path $root "startup\startup_stm32l051xx.s"),
    "-lgcc"
)
& (Join-Path $gccBin "arm-none-eabi-gcc.exe") @gccArgs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

& (Join-Path $gccBin "arm-none-eabi-objcopy.exe") -O binary $elf $bin
& (Join-Path $gccBin "arm-none-eabi-size.exe") $elf

if ($args -contains "flash") {
    $elfFwd = ($elf -replace '\\', '/')
    & $openocd -f interface/stlink.cfg -c "transport select swd" -f target/stm32l0.cfg -c "program $elfFwd verify reset exit"
    exit $LASTEXITCODE
}
