cmake_minimum_required(VERSION 3.16)
project(sample_box_l051 C)

option(BUILD_FIRMWARE "Cross-compile the STM32L051C8T6 image" OFF)

set(LOGIC_SOURCES
    src/crc16.c
    src/civil_time.c
    src/battery.c
    src/protocol.c
    src/box.c
    src/sector_log.c
    src/journal.c
    src/gd25.c
    src/persist.c
)

if(BUILD_FIRMWARE)
    enable_language(ASM)
    add_executable(sample_box.elf
        ${LOGIC_SOURCES}
        src/main.c
        src/clock.c
        src/delay.c
        src/pins.c
        src/lpuart.c
        src/spi_port.c
        src/adc_vbat.c
        src/rtc_wake.c
        src/module.c
        src/inputs.c
        src/link.c
        src/power.c
        src/newlib_stubs.c
        third_party/cmsis_device_l0/Source/Templates/system_stm32l0xx.c
        third_party/cmsis_device_l0/Source/Templates/gcc/startup_stm32l051xx.s
    )
    target_compile_definitions(sample_box.elf PRIVATE STM32L051xx)
    target_include_directories(sample_box.elf PRIVATE
        src
        third_party/CMSIS/Include
        third_party/cmsis_device_l0/Include
    )
    target_compile_options(sample_box.elf PRIVATE
        -mcpu=cortex-m0plus
        -mthumb
        -mfloat-abi=soft
        -ffunction-sections
        -fdata-sections
        -fno-common
        $<$<COMPILE_LANGUAGE:C>:-std=c11>
        $<$<COMPILE_LANGUAGE:C>:-Wall>
        $<$<COMPILE_LANGUAGE:C>:-Wextra>
        $<$<COMPILE_LANGUAGE:C>:-Werror>
        $<$<COMPILE_LANGUAGE:C>:-Os>
        $<$<COMPILE_LANGUAGE:C>:-ffreestanding>
    )
    set_source_files_properties(
        third_party/cmsis_device_l0/Source/Templates/system_stm32l0xx.c
        PROPERTIES COMPILE_OPTIONS "-w"
    )
    target_link_options(sample_box.elf PRIVATE
        -mcpu=cortex-m0plus
        -mthumb
        -mfloat-abi=soft
        -T${CMAKE_CURRENT_SOURCE_DIR}/ld/STM32L051C8Tx_FLASH.ld
        -nostartfiles
        -Wl,--gc-sections
        -Wl,-Map=$<TARGET_FILE_DIR:sample_box.elf>/sample_box.map
        --specs=nano.specs
        --specs=nosys.specs
    )
    add_custom_command(TARGET sample_box.elf POST_BUILD
        COMMAND arm-none-eabi-size $<TARGET_FILE:sample_box.elf>
        COMMAND arm-none-eabi-objcopy -O binary $<TARGET_FILE:sample_box.elf>
                $<TARGET_FILE_DIR:sample_box.elf>/sample_box.bin
        COMMAND arm-none-eabi-objcopy -O ihex $<TARGET_FILE:sample_box.elf>
                $<TARGET_FILE_DIR:sample_box.elf>/sample_box.hex
    )
else()
    add_executable(sample_box_tests
        ${LOGIC_SOURCES}
        test/fake_flash.c
        test/fake_gd25.c
        test/test_main.c
    )
    target_include_directories(sample_box_tests PRIVATE src test)
    target_compile_options(sample_box_tests PRIVATE -std=c11 -Wall -Wextra -Werror)
endif()
