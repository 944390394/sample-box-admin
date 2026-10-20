#ifndef SAMPLE_BOX_LINK_H
#define SAMPLE_BOX_LINK_H

#include "box.h"
#include "journal.h"

#include <stdint.h>

int link_poll(box_t *box, journal_t *journal, int have_journal, uint32_t wait_ms);
int link_send(box_t *box, journal_t *journal, int have_journal, const box_plan_t *plan, uint16_t mv,
              uint32_t now, int rdy);

#endif
