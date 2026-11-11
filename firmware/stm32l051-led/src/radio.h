#ifndef RADIO_H
#define RADIO_H
#include "event.h"

void radio_poll(int charge, int quiet);
void radio_event(event_type_t type, int charge);
int radio_line(const char *line);
void radio_option(char key, int on);
void radio_attach_fix(char *line, unsigned cap);
int radio_sleeping(void);
void radio_reset(void);
#endif
