#include "factory_state.h"

void factory_state_init(factory_state_t *state)
{
    state->phase = FACTORY_IDLE;
    state->elapsed = 0;
    state->armed = 0;
}

void factory_state_tick(factory_state_t *state, int pressed)
{
    if (state->phase == FACTORY_RUN) { state->elapsed++; return; }
    if (state->phase == FACTORY_ERROR) {
        state->elapsed++;
        if (!pressed) state->armed = 1;
        else if (state->armed) { state->phase = FACTORY_DEBOUNCE; state->elapsed = 0; }
        return;
    }
    if (!pressed) {
        state->armed = 1; state->phase = FACTORY_IDLE; state->elapsed = 0;
        return;
    }
    if (!state->armed) return;
    if (state->phase == FACTORY_IDLE) { state->phase = FACTORY_DEBOUNCE; state->elapsed = 0; }
    if (state->phase == FACTORY_DEBOUNCE) {
        if (++state->elapsed >= 30u) { state->phase = FACTORY_HOLD; state->elapsed = 0; }
    } else if (++state->elapsed >= 5000u) {
        state->phase = FACTORY_RUN; state->elapsed = 0; state->armed = 0;
    }
}

int factory_state_lights(const factory_state_t *state)
{
    if (state->phase == FACTORY_HOLD) return state->elapsed < 1667u ? 1 : state->elapsed < 3334u ? 3 : 7;
    if (state->phase == FACTORY_RUN) return (state->elapsed / 125u) % 2u ? 0 : 7;
    if (state->phase == FACTORY_ERROR) return (state->elapsed / 250u) % 2u ? 6 : 1;
    return -1;
}
