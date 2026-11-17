#ifndef CURVE_H
#define CURVE_H

void curve_init(void);
int curve_factory_reset(void);
void curve_observe(int millivolts, int charge);
int curve_learned(int *full_mv, int *empty_mv, int *count);

#endif
