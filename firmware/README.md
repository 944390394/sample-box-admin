# STM32L051C8T6 采样箱固件

主控是 STM32L051C8T6。银尔达 M100MG-C2 只负责 4G、GPS/北斗和基站定位，把串口上的一行放进 JSON 的 `uart` 字段。开箱、按键、电量灯、模组供电和离线补传都在这颗 MCU 上。

方案原稿写的是 STM32F103。这颗换成 L051，是为了 Stop 模式可以同时被同步键、箱盖和 RTC 唤醒，LPUART 用 32.768 kHz 跑 9600，深度睡眠时模组还能用 `AA 55` 把 MCU 喊醒。

## 行为

和《采样箱项目初步方案》一致：

- 出厂是软关机。长按同步键约 2 秒开机，再长按关机。关机切断模组电源，任务状态留在 GD25Q80C。MCU 一直带电，电池不物理断开。
- 软关机时短按只亮电量灯，不联网。
- 开机后模组上电并休眠。待机时按上报间隔醒来收指令，不发周期位置。
- `cmd=start` 后进入已授权，等第一次开箱。开箱次数加 1，发 `why=pad`，并从这一刻按间隔发 `why=timer`。间隔最短 5 分钟，指令没带间隔就用当前值（出厂 5 分钟）。
- 上报过程中再次开箱立刻上报并加 1。关箱发 `why=shut`，不加次数。
- `cmd=stop` 停止周期上报，开箱次数清零，回到待机。`cmd=reset` 只清次数。
- 短按发 `why=sync`，并顺带收指令。
- 模组没就绪时记录留在闪存里，下次按顺序补发，`cached=1`。

后台现在只认 `why=boot`、`why=timer`、`why=pad`，以及 `opens=`。`why=shut` 和 `why=sync` 会记成「设备上报」，`opens` 仍然入库。

## 串口

9600 8N1。模组已经供电且处于超低功耗时，先发两个原始字节 `AA 55`，等 200 ms，再发一行：

```text
why=pad,opens=2,lid=open,seq=15,cached=0,mv=3800
```

平台下行，一行一条：

```text
cmd=start
cmd=start,interval=600
cmd=stop
cmd=reset
cmd=interval,sec=600
cmd=ack,seq=15
```

DTU 通道 1 用 TCP，把这一行放进 JSON 的 `uart`。`AA 55` 只用来把超低功耗任务唤醒，不要写进 `uart`，否则后台认不出 `why=`。也不要再由 Lua 自己编 `why=`。`imei`、`csq`、`vbat`、`time`、基站和 GPS 仍由模组模板填。MCU 的 `mv` 是电池电压，模组自己的 `vbat` 是模块供电。

后台 TCP 目前只收不发，所以固件在 RDY 为高、这一行已经交给模组后就从队列删除。等平台会回 `cmd=ack`，把 `board.h` 里的 `BOARD_DROP_WHEN_MODEM_ACCEPTS` 改成 0。

## 引脚

原理图网表还没定，下表是按 L051C8 外设排的，改板子只动 `src/board.h`。

| 功能 | 引脚 | 说明 |
| --- | --- | --- |
| 模组 TX | PA2，LPUART1 AF6 | 接到 M100MG RXD |
| 模组 RX | PA3，LPUART1 AF6 | 接到 M100MG TXD |
| Flash CS | PA4 | 低有效，GD25Q80C |
| SPI SCK / MISO / MOSI | PA5 / PA6 / PA7 | SPI1 AF0 |
| 模组电源 | PB0 | 高 = 供电，关机拉低 |
| 模组 RST | PB1 | 低有效，空闲为高 |
| 模组 RDY | PB2 | 高 = 网络通道已建立 |
| 箱盖 | PB4 | 上拉，低 = 开箱 |
| 电量灯 | PB12 到 PB15 | 高电平点亮，1 到 4 格 |
| 同步键 | PC13 | 上拉，按下为低 |
| 电池电压 | PC0，ADC_IN10 | 默认 2:1 分压，VDDA 按 3.3 V |
| LSE | PC14 / PC15 | 32.768 kHz，必须焊 |
| SWD | PA13 / PA14 | 调试 |

SGM41513 只走 5 V / 12 V 充电，12 V 不进 MCU。电量用 ADC，不配充电芯片寄存器。4.20 V 当 100%，3.40 V 当 0%，电芯曲线实测前用这条直线。4 盏 ≥75%，3 盏 ≥50%，2 盏 ≥25%，1 盏 ≥5%，再低则 1 盏闪。

## 构建

逻辑测试在主机上跑，不需要开发板：

```bash
cmake -S firmware -B firmware/build-host
cmake --build firmware/build-host
./firmware/build-host/sample_box_tests
```

固件：

```bash
cmake -S firmware -B firmware/build \
  -DCMAKE_TOOLCHAIN_FILE=firmware/cmake/arm-none-eabi.cmake \
  -DBUILD_FIRMWARE=ON
cmake --build firmware/build
```

产物是 `firmware/build/sample_box.elf`、`.bin`、`.hex`。用 ST-Link 写入：

```bash
openocd -f interface/stlink.cfg -f target/stm32l0.cfg \
  -c "program firmware/build/sample_box.elf verify reset exit"
```

这台机器上编过 elf，也跑过主机测试。还没有接到 L051 和 M100MG 上电。
