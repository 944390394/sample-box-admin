#include "radio.h"
#include "board.h"
#include "clock.h"
#include "gpio.h"
#include "timebase.h"
#include "uart.h"

#define WINDOW_MS 7200000u
#define JOIN_MS 60000u
#define FIX_MS 60000u
static uint32_t hold_until = WINDOW_MS, fix_due, last_fix_request, sleep_until, wake_at;
static uint32_t proposed_at;
static int proposal;
static uint32_t last_state, last_send, restored_until;
/* 没收到 saved= 时重发 lp save 的间隔：0 表示马上发，之后 5、10、20 秒……最长 5 分钟。 */
static uint32_t save_gap;
static int opened_since_boot;
static int task, gps, capable, admitted, sleeping, asserting, fresh_policy, state_ok, holding = 1;
static char sample[44], checkpoint[72];

static int prefix(const char *s, const char *p)
{
    while (*p && *s == *p) { s++; p++; }
    return !*p;
}

static int equal(const char *a, const char *b)
{
    while (*a && *a == *b) { a++; b++; }
    return *a == *b;
}

static char *decimal(char *dst, uint32_t n)
{
    if (n >= 10u) dst = decimal(dst, n / 10u);
    *dst++ = (char)('0' + n % 10u);
    return dst;
}

static int number(const char **p, uint32_t *out)
{
    uint32_t n = 0;
    const char *s = *p;
    if (*s < '0' || *s > '9') return 0;
    while (*s >= '0' && *s <= '9') {
        unsigned digit = (unsigned)(*s++ - '0');
        if (n > (0xffffffffu - digit) / 10u) return 0;
        n = n * 10u + digit;
    }
    *out = n;
    *p = s;
    return 1;
}

static void command(const char *name, uint32_t a, uint32_t b)
{
    char buf[56], *p = buf;
    while (*name) *p++ = *name++;
    p = decimal(p, a); *p++ = ' '; p = decimal(p, b);
    *p++ = '\r'; *p++ = '\n'; *p = 0;
    uart_write_text(BOARD_USART2, buf);
}

static void wake(void)
{
    if (!sleeping) return;
#if BOARD_DTR_WAKE_LEVEL >= 0
    gpio_write(BOARD_PORT_B, BOARD_PIN_DTR, BOARD_DTR_WAKE_LEVEL);
    gpio_set_output(BOARD_PORT_B, BOARD_PIN_DTR);
#endif
    if (asserting) return;
    asserting = 1;
    wake_at = sleep_until = clock_ms();
    uart_write_text(BOARD_USART2, "lp cancel\r\n");
}

int radio_sleeping(void) { return sleeping; }

void radio_option(char key, int on)
{
    if (!fresh_policy || (key=='j' ? gps : task)!=on) state_ok=0;
    fresh_policy = 1;
    if (key == 't') task = on;
    if (key == 'j') {
        if (gps && !on) {
            uart_write_text(BOARD_USART2, "lp gps-off\r\n");
            sample[0] = 0; fix_due = 0;
        }
        gps = on;
    }
}

void radio_reset(void)
{
    if (capable) uart_write_text(BOARD_USART2, "lp clear\r\n");
    proposal = 0;
    capable = admitted = sleeping = fresh_policy = task = gps = state_ok = 0;
    fix_due = restored_until = save_gap = 0;
    sample[0] = checkpoint[0] = 0;
    holding = 1; hold_until = clock_ms() + WINDOW_MS;
}

void radio_event(event_type_t type, int charge)
{
    if (type == EVENT_LID_OPEN && !task) {
        opened_since_boot = 1;
        holding = 1;
        hold_until = clock_ms() + WINDOW_MS;
        restored_until = 0;
        state_ok = 0;
    }
    if (type == EVENT_LID_OPEN || type == EVENT_LID_CLOSE || type == EVENT_TIMER || charge) {
        if (proposal) { proposal=0; uart_write_text(BOARD_USART2,"lp cancel\r\n"); }
        wake();
    }
}

/* Stored in the DTU's FSKV. Only a matching read-back permits a sleep handoff. */
static void save_state(uint32_t now)
{
    char line[72], *p = line;
    const char *name = "lp save ";
    while (*name) *p++ = *name++;
    uint32_t expires = 0;
    if (holding && !timebase_synced()) expires=0xffffffffu;
    if (holding && timebase_synced()) {
        if (!restored_until) restored_until = (uint32_t)((timebase_now() + (hold_until - now)) / 1000u);
        expires = restored_until;
    }
    p = decimal(p, clock_policy_version()); *p++ = ' ';
    p = decimal(p, clock_period_seconds()); *p++ = ' ';
    p = decimal(p, task + 2u * gps + 4u * clock_charge_only() + 8u * clock_lights_on()); *p++ = ' ';
    p = decimal(p, expires); *p = 0;
    if (!equal(checkpoint, line + 8)) {
        unsigned i = 0;
        do { checkpoint[i] = line[8+i]; } while (checkpoint[i++]);
        state_ok = 0; save_gap = 0;
    }
    /* DTU 没有 FSKV 时永远不回 saved=：按间隔翻倍重发，不再每 5 秒发一次。 */
    if (state_ok || now - last_send < save_gap) return;
    *p++ = '\r'; *p++ = '\n'; *p = 0;
    uart_write_text(BOARD_USART2, line);
    last_send = now;
    save_gap = save_gap == 0u ? 5000u : (save_gap >= 150000u ? 300000u : save_gap * 2u);
}

int radio_line(const char *line)
{
    const char *p = line;
    uint32_t v, period, flags, expires;
    if (equal(line,"lpreboot=1")) {
        capable=0; admitted=0; sleeping=0; proposal=0; state_ok=0; save_gap=0;
        fix_due=0; sample[0]=0;
        return 1;
    }
    if (equal(line,"sleeping=1")) {
        if (proposal && clock_ms()-proposed_at < 4000u) {
            uart_write_text(BOARD_USART2,"lp commit\r\n");
            sleeping = 1;
            clock_note_link(0);
        } else uart_write_text(BOARD_USART2,"lp cancel\r\n");
        proposal=0; return 1;
    }
    if (equal(line,"lpready=1") || equal(line,"lpready=2")) {
        capable = 1;
        admitted = line[8]=='2' && BOARD_DTR_WAKE_LEVEL >= 0;
        sleeping = 0;
        return 1;
    }
    if (prefix(line,"saved=")) { state_ok = equal(line+6, checkpoint); return 1; }
    if (prefix(line,"restore=")) {
        p += 8;
        if (fresh_policy || !number(&p,&v) || *p++!=' ' || !number(&p,&period) ||
            *p++!=' ' || !number(&p,&flags) || *p++!=' ' || !number(&p,&expires) ||
            *p || period<5 || period>3600 || flags>15 || !timebase_synced()) return 1;
        clock_set_period(period*1000u); clock_set_charge_only(flags & 4u);
        clock_set_lights(flags & 8u); clock_set_policy_version(v);
        task = flags & 1; gps = (flags & 2u)!=0; fresh_policy = 1;
        uint32_t sec = (uint32_t)(timebase_now()/1000u);
        if (expires && expires>sec && expires-sec <= 7200u) {
            uint32_t until = clock_ms()+(expires-sec)*1000u;
            /* A lid opening since reboot takes priority over the stored window. */
            if (!opened_since_boot) { hold_until=until; restored_until=expires; }
        } else if (!opened_since_boot && expires<=sec) { holding=0; restored_until=0; }
        return 1;
    }
    if (prefix(line,"fix=")) {
        p += 4;
        if (!gps || !number(&p,&v) || *p++!=' ' || v!=fix_due) return 1;
        unsigned n=0, slashes=0;
        while (p[n] && n+1u<sizeof sample) {
            if (p[n]=='/') slashes++;
            else if ((p[n]<'0' || p[n]>'9') && p[n]!='-') return 1;
            n++;
        }
        if (p[n] || slashes!=2 || !n) return 1;
        for (unsigned i=0;i<=n;i++) sample[i]=p[i];
        return 1;
    }
    return 0;
}

void radio_attach_fix(char *line, unsigned cap)
{
    if (!sample[0] || !gps) return;
    int32_t age = (int32_t)(clock_ms()-fix_due);
    if (age<0 || age>3000) return;
    unsigned end=0, n=0;
    while (line[end] && line[end]!='\r') end++;
    while (sample[n]) n++;
    if (end+n+7u > cap) {
        /* Keep the timestamped fix when optional diagnostics fill the 240-byte slot. */
        const char *optional[] = {",free=", ",hi=", ",lo=", ",n=", ",openage="};
        for (unsigned k=0; k<5 && end+n+7u>cap; k++) {
            unsigned i=0, j;
            while (i<end && !prefix(line+i,optional[k])) i++;
            if (i==end) continue;
            j=i+1;
            while (j<end && line[j]!=',') j++;
            unsigned removed=j-i;
            do { line[i++]=line[j]; } while (line[j++]);
            end-=removed;
        }
    }
    if (end+n+7u <= cap) {
        char *p = line+end;
        *p++=','; *p++='x'; *p++='y'; *p++='=';
        for (unsigned i=0;i<n;i++) *p++=sample[i];
        *p++='\r'; *p++='\n'; *p=0;
    }
    sample[0]=0;
}

void radio_poll(int charge, int quiet)
{
    uint32_t now=clock_ms(), due=clock_next_report_ms(), left=due-now;
    if (holding && (int32_t)(now-hold_until)>=0) { holding=0; restored_until=0; }
    if (asserting && now-wake_at >=1000u) {
#if BOARD_DTR_WAKE_LEVEL >= 0
        gpio_set_input(BOARD_PORT_B, BOARD_PIN_DTR, GPIO_PULL_NONE);
#endif
        asserting=0;
    }
    if (sleeping) {
        if (!asserting && (int32_t)(now-sleep_until)>=0 && now-wake_at>=3000u) wake();
        return;
    }
    if (!capable || !fresh_policy) return;
    if ((admitted && quiet) || now-last_state>=1000u) { last_state=now; save_state(now); }
    if (gps && left && left<=FIX_MS && (due!=fix_due || (!sample[0] && now-last_fix_request>=4000u))) {
        if (due!=fix_due) sample[0]=0;
        fix_due=due; last_fix_request=now;
        command("lp fix ",due,(left+999u)/1000u);
    }
    if (proposal && (charge || (!task && holding) || !quiet)) {
        proposal=0; uart_write_text(BOARD_USART2,"lp cancel\r\n");
    }
    if (proposal && now-proposed_at>=4000u) proposal=0;
    if (proposal || (proposed_at && now-proposed_at<15000u) || charge || (!task && holding) || !admitted || !quiet || !state_ok ||
        !timebase_synced() || !clock_link_online() || clock_period_seconds()<600 ||
        left <= JOIN_MS+10000u || left>3600000u) return;
    /* STM owns the absolute deadline. Network join and GNSS run concurrently. */
    proposed_at=now; proposal=1; sleep_until=due-JOIN_MS;
    command("lp sleep ",(left-JOIN_MS)/1000u,clock_policy_version());
}

