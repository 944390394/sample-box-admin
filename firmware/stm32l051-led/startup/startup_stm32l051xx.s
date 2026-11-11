.syntax unified
.cpu cortex-m0plus
.thumb

.section .isr_vector, "a", %progbits
.align 2
.global g_pfnVectors
g_pfnVectors:
    .word _estack
    .word Reset_Handler
    .word NMI_Handler
    .word HardFault_Handler
    .word 0
    .word 0
    .word 0
    .word 0
    .word 0
    .word 0
    .word 0
    .word SVC_Handler
    .word 0
    .word 0
    .word PendSV_Handler
    .word SysTick_Handler
    .word 0                     /* IRQ0  WWDG */
    .word PVD_IRQHandler        /* IRQ1  PVD（EXTI16），Stop 里掉电叫醒 */
    .rept 5                     /* IRQ2-6 */
    .word 0
    .endr
    .word EXTI4_15_IRQHandler   /* IRQ7  按键 PB5、充电 PB8/PB9、箱盖 PB10 */
    .rept 5                     /* IRQ8-12 */
    .word 0
    .endr
    .word LPTIM1_IRQHandler     /* IRQ13 LPTIM1 定时叫醒 */
    .rept 13                    /* IRQ14-26 */
    .word 0
    .endr
    .word USART1_IRQHandler     /* IRQ27 USB 串口（CH340）收命令 */
    .word USART2_IRQHandler     /* IRQ28 */

.section .text
.global Default_Handler
.type Default_Handler, %function
.thumb_func
Default_Handler:
    b .

.weak NMI_Handler
.thumb_set NMI_Handler, Default_Handler
.weak HardFault_Handler
.thumb_set HardFault_Handler, Default_Handler
.weak SVC_Handler
.thumb_set SVC_Handler, Default_Handler
.weak PendSV_Handler
.thumb_set PendSV_Handler, Default_Handler
.weak SysTick_Handler
.thumb_set SysTick_Handler, Default_Handler

.weak USART1_IRQHandler
.thumb_set USART1_IRQHandler, Default_Handler
.weak USART2_IRQHandler
.thumb_set USART2_IRQHandler, Default_Handler
.weak PVD_IRQHandler
.thumb_set PVD_IRQHandler, Default_Handler
.weak EXTI4_15_IRQHandler
.thumb_set EXTI4_15_IRQHandler, Default_Handler
.weak LPTIM1_IRQHandler
.thumb_set LPTIM1_IRQHandler, Default_Handler

.global Reset_Handler
.type Reset_Handler, %function
.thumb_func
Reset_Handler:
    ldr   r0, =_estack
    mov   sp, r0

    movs  r1, #0
    b     LoopCopyDataInit
CopyDataInit:
    ldr   r3, =_sidata
    ldr   r3, [r3, r1]
    str   r3, [r0, r1]
    adds  r1, r1, #4
LoopCopyDataInit:
    ldr   r0, =_sdata
    ldr   r3, =_edata
    adds  r2, r0, r1
    cmp   r2, r3
    bcc   CopyDataInit

    ldr   r2, =_sbss
    b     LoopFillZerobss
FillZerobss:
    movs  r3, #0
    str   r3, [r2]
    adds  r2, r2, #4
LoopFillZerobss:
    ldr   r3, =_ebss
    cmp   r2, r3
    bcc   FillZerobss

    bl    main
    b     .
