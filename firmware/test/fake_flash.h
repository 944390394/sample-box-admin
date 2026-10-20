#ifndef SAMPLE_BOX_FAKE_FLASH_H
#define SAMPLE_BOX_FAKE_FLASH_H

#include "flash_ops.h"

#include <stdint.h>

void fake_flash_reset(uint32_t erase_size);
flash_ops_t *fake_flash_ops(void);
uint8_t *fake_flash_mem(void);

#endif
