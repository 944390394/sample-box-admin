#ifndef SAMPLE_BOX_INPUTS_H
#define SAMPLE_BOX_INPUTS_H

void inputs_init(void);
int lid_is_open(void);
void lid_irq_set(int enable);
/* 0 没有，1 短按，2 长按。 */
int take_button_gesture(void);
void take_lid_edge(int *opened, int *closed);

#endif
