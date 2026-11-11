#include "radio.h"
#include "board.h"
#include "gpio.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

static unsigned now, due, period=600, version=44, link=1;
static char tx[512];
static void clear(void) { tx[0]=0; }
uint32_t clock_ms(void) {return now;}
uint32_t clock_next_report_ms(void) {return due;}
uint32_t clock_period_seconds(void) {return period;}
uint32_t clock_policy_version(void) {return version;}
int clock_charge_only(void) {return 0;}
int clock_lights_on(void) {return 1;}
void clock_note_link(int on) {link=on;}
int clock_link_online(void) {return link;}
void clock_set_period(uint32_t ms) {period=ms/1000;}
void clock_set_charge_only(int on) {(void)on;}
void clock_set_lights(int on) {(void)on;}
void clock_set_policy_version(uint32_t v) {version=v;}
int timebase_synced(void) {return 1;}
uint64_t timebase_now(void) {return 1700000000000ULL+now;}
void uart_write_text(uint32_t port,const char *line) {(void)port; assert(strlen(tx)+strlen(line)<sizeof tx); strcat(tx,line);}
void gpio_write(uint32_t p,uint32_t pin,int v){(void)p;(void)pin;(void)v;}
void gpio_set_output(uint32_t p,uint32_t pin){(void)p;(void)pin;}
void gpio_set_input(uint32_t p,uint32_t pin,gpio_pull_t m){(void)p;(void)pin;(void)m;}
static void confirm_state(void) {
    char msg[100]; char *p=strstr(tx,"lp save "); assert(p);
    snprintf(msg,sizeof msg,"saved=%.*s",(int)strcspn(p+8,"\r"),p+8);
    assert(radio_line(msg)); clear();
}
int main(void) {
    now=1000; due=now+600000;
    radio_line("lpready=2"); radio_option('t',0); radio_option('j',0);
    radio_event(EVENT_LID_OPEN,0); radio_poll(0,1); confirm_state();
    now+=119*60000; due=now+600000;
    radio_poll(0,1); assert(!strstr(tx,"lp sleep"));
    radio_event(EVENT_LID_CLOSE,0); now+=60001; due=now+600000;
    radio_poll(0,1); confirm_state(); radio_poll(0,1);
    assert(strstr(tx,"lp sleep 540 44")); clear();
    radio_line("sleeping=1"); assert(radio_sleeping() && !link && strstr(tx,"lp commit")); clear();
    radio_event(EVENT_LID_OPEN,0); assert(strstr(tx,"lp cancel")); clear();
    radio_line("lpready=2"); assert(!radio_sleeping()); link=1;
    radio_option('j',1); due=now+59000; radio_poll(0,1);
    char reply[96], line[110]="why=timer\r\n";
    assert(strstr(tx,"lp fix")); snprintf(reply,sizeof reply,"fix=%u 1000000/2000000/1700000001",due);
    radio_line(reply); now=due; radio_attach_fix(line,sizeof line);
    assert(strstr(line,",xy=1000000/2000000/1700000001"));
    puts("PASS radio window, planned sleep, local wake and timestamped fix");
    return 0;
}
