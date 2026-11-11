/* 主机验证真实按键、存储和恢复模块；仅替换 GPIO、SPI 芯片及复位寄存器。 */
#include <assert.h>
#include <stdio.h>
#include <string.h>
#include "board.h"
#include "clock.h"
#include "curve.h"
#include "factory_reset.h"
#include "factory_state.h"
#include "gd25.h"
#include "gpio.h"
#include "poff.h"
#include "store.h"
#include "report.h"
#include "remote.h"
#include "ringbuf.h"

static unsigned char flash[GD25_BYTES];
static int pins[16], rebooted, fail_erase;
static unsigned erases, poff_erases, programs;
int test_power_low;
static const char *rx = "";
static led_t led;
void SysTick_Handler(void);
int gd25_init(void) { return 1; }
void gd25_read(uint32_t addr, uint8_t *dst, unsigned n) { assert(addr+n <= sizeof flash); memcpy(dst,flash+addr,n); }
int gd25_page_program(uint32_t addr, const uint8_t *src, unsigned n) {
    assert(addr+n <= sizeof flash && addr/256 == (addr+n-1)/256);
    programs++;
    for(unsigned i=0;i<n;i++) flash[addr+i] &= src[i];
    return 1;
}
int gd25_erase_sector(uint32_t addr) {
    if (fail_erase) return 0;
    assert(addr%4096 == 0 && addr+4096 <= sizeof flash);
    erases++; if(addr<GD25_LOG_LIMIT)poff_erases++;
    memset(flash+addr,255,4096); return 1;
}
void gpio_write(uint32_t port,uint32_t pin,int high) { assert(port==BOARD_PORT_B); pins[pin]=!!high; }
int gpio_read(uint32_t port,uint32_t pin) { assert(port==BOARD_PORT_B); return pins[pin]; }
void gpio_set_output(uint32_t port,uint32_t pin) { (void)port; (void)pin; }
void gpio_set_input(uint32_t port,uint32_t pin,gpio_pull_t pull) { assert(port==BOARD_PORT_B && pin==5 && pull==GPIO_PULL_UP); }
void lid_on_ms(lid_t *lid) { (void)lid; }
void charger_on_ms(charger_t *charger) { (void)charger; }
int charger_status(void) { return 0; }
int timebase_synced(void) { return 1; }
uint64_t timebase_now(void) { return 1793000000000ull; }
void timebase_on_line(const char *line) { (void)line; }
static char last_tx[400], txall[8192]; static unsigned tx_n, txlen;
void uart_write_text(uint32_t usart,const char *line) { (void)usart; strncpy(last_tx,line,sizeof last_tx-1); tx_n++; if(txlen+strlen(line)<sizeof txall){strcpy(txall+txlen,line);txlen+=(unsigned)strlen(line);} }
int uart_read_byte(uint32_t usart,uint8_t *out) { (void)usart; if(!*rx)return 0; *out=(uint8_t)*rx++; return 1; }
void factory_test_reboot(void) { rebooted++; }
static void boot(void) {
    clock_start(0,0,0,5000); poff_init(); curve_init(); store_init(); led_init(&led); factory_reset_init(&led);
}
static void tick(unsigned n) { while(n--)SysTick_Handler(); }
static void run_reset(void) { for(unsigned n=0;n<5000 && !rebooted;n++){tick(1);factory_reset_poll();} }
static void ack(void) { rx="ok p=5 c=0 a=2147483647 v=0\n"; store_poll(0); }

/* 掉电日志区：n 条 16 字节记录，kind=1+i%4，时间 1793000000+i 秒，开箱次数=i。 */
static void put_log(unsigned n) {
    for(unsigned i=0;i<n;i++){
        unsigned char *r=flash+i*16u; unsigned long long ms=(1793000000ull+i)*1000ull;
        memset(r,0,16); r[0]=0xA5; r[1]=(unsigned char)(1+i%4);
        for(unsigned b=0;b<8;b++)r[4+b]=(unsigned char)(ms>>(8*b));
        r[12]=(unsigned char)i; r[13]=(unsigned char)(i>>8);
    }
}
static int log_blank(void) {
    for(uint32_t a=0;a<GD25_LOG_LIMIT;a++)if(flash[a]!=0xFF)return 0;
    return 1;
}
/* 把一行下行文字交给 store 解析，取出指令；解析不出来返回 0。 */
static int feed(const char *line, store_cmd_t *cmd) { rx=line; store_poll(0); return store_take_cmd(cmd); }
static void fresh(unsigned log_records) {
    memset(flash,255,sizeof flash); put_log(log_records); pins[5]=1; rebooted=0; erases=poff_erases=0; fail_erase=0; boot(); clock_set_period(60000); tick(1);
}
static void test_remote(void) {
    store_cmd_t cmd; report_t rep; remote_ctx_t ctx={9,0,0,3800}; char line[240+1]; unsigned i;
    /* 解析：只认完整合法的行，其余整行丢弃 */
    fresh(600);
    assert(!feed("wipe m=x s=1\n",&cmd) && !feed("wipe m=q\n",&cmd) && !feed("dump f=1 n=2 s=3\n",&cmd));
    assert(!feed("wipe m=q s=1 z=2\n",&cmd) && !feed("dump q f=1 s=3\n",&cmd));
    assert(feed("wipe m=q s=7\n",&cmd) && cmd.kind==STORE_CMD_WIPE && !cmd.full && cmd.seq==7);
    assert(feed("wipe m=f s=4294967295\n",&cmd) && cmd.full && cmd.seq==4294967295u);
    assert(feed("dump q s=3\n",&cmd) && cmd.kind==STORE_CMD_DUMP_INFO && cmd.seq==3);
    assert(feed("dump f=1793000005 n=10 s=3 r=77\n",&cmd) && cmd.kind==STORE_CMD_DUMP && cmd.from==1793000005u && cmd.max==10 && cmd.req==77);
    /* s 与最近上报 seq 不符：忽略，不动任何数据 */
    assert(feed("wipe m=f s=8\n",&cmd) && !remote_apply(&cmd,7));
    for(i=0;i<2000;i++){tick(1);assert(!factory_reset_poll());}
    assert(erases==0 && !rebooted && flash[0]==0xA5);
    /* 快速：只擦非空白扇区（600 条占 3 个扇区），队列/开箱/曲线照常清 */
    assert(feed("wipe m=q s=7\n",&cmd) && remote_apply(&cmd,7));
    run_reset();
    assert(rebooted==1 && poff_erases==3 && erases==6 && log_blank() && flash[GD25_CURVE_BASE+GD25_SECTOR-16]==0xFF);
    boot(); assert(poff_opens()==0 && !poff_has() && poff_log_total()==0);
    /* 完整：每个扇区都擦 */
    fresh(600);
    assert(feed("wipe m=f s=9\n",&cmd) && remote_apply(&cmd,9));
    run_reset();
    assert(rebooted==1 && poff_erases==GD25_LOG_LIMIT/GD25_SECTOR && log_blank());
    /* 擦到一半断电：标记还在，重启后一律完整续做 */
    fresh(600);
    assert(feed("wipe m=q s=1\n",&cmd) && remote_apply(&cmd,1));
    while(poff_erases<2 && !rebooted){tick(1);factory_reset_poll();}
    assert(!rebooted && !log_blank());
    poff_erases=0; boot(); run_reset();
    assert(rebooted==1 && poff_erases==GD25_LOG_LIMIT/GD25_SECTOR && log_blank() && flash[GD25_CURVE_BASE+GD25_SECTOR-16]==0xFF);
    /* 恢复出厂按键留下的标记（第 2 字节未写）续做时不碰日志 */
    fresh(600);
    pins[5]=0; tick(5030); run_reset();
    assert(rebooted==1 && poff_erases==0 && flash[0]==0xA5);
    /* 回传：先估算，再按 7 条一行 */
    fresh(20); rep.seq=3;
    assert(feed("dump q s=3\n",&cmd) && remote_apply(&cmd,3) && remote_wants_line());
    assert(remote_next_line(&rep,&ctx,line,sizeof line) && rep.seq==4);
    assert(!strcmp(line,"why=dumpinfo,total=20,opens=9,lid=0,chg=0,bat=3800,pv=0,rp=60,rc=0,rl=1,rn=0,lp=0,fw=" BOARD_FIRMWARE ",seq=4\r\n"));
    assert(!remote_wants_line());
    assert(feed("dump f=1793000005 n=10 s=4 r=77\n",&cmd) && !remote_apply(&cmd,3) && remote_apply(&cmd,4));
    for(i=0;i<100 && !remote_wants_line();i++)remote_poll();
    assert(remote_next_line(&rep,&ctx,line,sizeof line) && strlen(line)<=240u);
    assert(!strcmp(line,"why=dump,r=77,part=1/2,d=2:1793000005:5;3:1793000006:6;4:1793000007:7;1:1793000008:8;2:1793000009:9;3:1793000010:10;4:1793000011:11,opens=9,lid=0,chg=0,bat=3800,pv=0,rp=60,rc=0,rl=1,rn=0,lp=0,fw=" BOARD_FIRMWARE ",seq=5\r\n"));
    for(i=0;i<100 && !remote_wants_line();i++)remote_poll();
    assert(remote_next_line(&rep,&ctx,line,sizeof line));
    assert(!strcmp(line,"why=dump,r=77,part=2/2,d=1:1793000012:12;2:1793000013:13;3:1793000014:14,opens=9,lid=0,chg=0,bat=3800,pv=0,rp=60,rc=0,rl=1,rn=0,lp=0,fw=" BOARD_FIRMWARE ",seq=6\r\n"));
    for(i=0;i<100;i++)remote_poll();
    assert(!remote_wants_line() && rep.seq==6);
    /* 没有符合条件的记录：回一行空 d，服务器据此知道结束 */
    assert(feed("dump f=1900000000 n=5 s=6 r=78\n",&cmd) && remote_apply(&cmd,6));
    for(i=0;i<100 && !remote_wants_line();i++)remote_poll();
    assert(remote_next_line(&rep,&ctx,line,sizeof line) && strstr(line,"why=dump,r=78,part=1/1,d=,opens=9"));
    assert(!remote_wants_line());
    /* 数字很大时整行放不下：少放几条，仍不超过 240 字节 */
    ctx.opens=4294967295u; ctx.battery_mv=-32768; clock_set_policy_version(4294967295u);
    put_log(20); for(i=0;i<20;i++){flash[i*16+14]=flash[i*16+15]=0x7F;}
    assert(feed("dump f=0 n=20 s=6 r=4294967295\n",&cmd) && remote_apply(&cmd,6));
    for(unsigned lines=0;lines<10;lines++){
        for(i=0;i<100 && !remote_wants_line();i++)remote_poll();
        if(!remote_wants_line())break;
        assert(remote_next_line(&rep,&ctx,line,sizeof line) && strlen(line)<=240u);
    }
    assert(!remote_wants_line());
}

static void test_lights(void) {
    fresh(0); led_show(&led,1,LED_CHARGE_FULL,1);
    assert(pins[12]==0 && pins[13]==0 && pins[14]==0);
    rx="ok p=5 c=0 l=0 v=1\n"; store_poll(0);
    led_show(&led,1,LED_CHARGE_FULL,1);
    assert(clock_lights_on()==0 && pins[12]==1 && pins[13]==0 && pins[14]==1); /* off, but on charger the charge colour still shows */
    led_show(&led,1,LED_CHARGE_NONE,1);
    assert(pins[12]==1 && pins[13]==1 && pins[14]==1); /* off on battery: pins held high */
    led_override(&led,5); assert(pins[12]==0 && pins[13]==1 && pins[14]==0); /* progress lights still work */
    led_override(&led,-1); assert(pins[12]==1 && pins[13]==1 && pins[14]==1);
    rx="ok p=5 c=0 l=2 v=9\n"; store_poll(0); /* illegal value stops parsing: l and v untouched */
    assert(clock_lights_on()==0 && clock_policy_version()==1);
    rx="ok p=5 c=0 v=2\n"; store_poll(0); assert(clock_lights_on()==0); /* l= omitted keeps value */
    rx="ok p=5 c=0 l=1 v=3\n"; store_poll(0); led_show(&led,1,LED_CHARGE_FULL,1);
    assert(clock_lights_on()==1 && pins[12]==0 && pins[13]==0 && pins[14]==0 && clock_policy_version()==3);
}

/* 在线先走内存、失败才落 Flash；批量发送；a= 累计确认；q 不复用。 */
static void send_all(unsigned n) { for(unsigned i=0;i<n;i++){ tick(1000); store_poll(1); } }
static char ackbuf[96];
static void ack_to(unsigned long n, int link) { snprintf(ackbuf,sizeof ackbuf,"ok p=5 c=0 a=%lu v=1\n",n); rx=ackbuf; store_poll(link); }
static void tx_reset(void) { tx_n=0; txlen=0; txall[0]=0; }
static unsigned last_q(void) { unsigned q=0; const char *at=strstr(last_tx,",q="); assert(at && sscanf(at,",q=%u",&q)==1); return q; }
static void test_queue(void) {
    char pad[160]; unsigned i, p0, q0, q1;
    /* Online fast path: one sequence bit per record, report bodies stay in RAM. */
    fresh(0); store_poll(1); tx_reset();
    assert(store_save("why=timer,opens=1\r\n")); /* first q persists the limit */
    p0=programs;
    assert(store_save("why=timer,opens=2\r\n") && store_save("why=timer,opens=3\r\n"));
    assert(programs==p0+2 && tx_n==3 && store_pending()==3);
    assert(!strcmp(last_tx,"why=timer,opens=3,q=2,qe=0\r\n"));
    ack_to(1,1); assert(store_pending()==1); /* a= clears the ring up to q */
    ack_to(1,1); assert(store_pending()==1); /* duplicate */
    ack_to(2,1); assert(store_pending()==0);
    rx="ok p=5 c=0 v=2\n"; assert(store_save("why=timer,opens=4\r\n")); store_poll(1);
    assert(store_pending()==1); /* ok without a= acknowledges nothing */
    ack_to(3,1); assert(store_pending()==0);
    /* no ack within ACK_WAIT_MS: ring goes to flash in order, keeps q, then is resent */
    tx_reset(); assert(store_save("why=timer,opens=5\r\n") && store_save("why=timer,opens=6\r\n"));
    tick(14999); store_poll(1); assert(tx_n==2 && store_pending()==2);
    p0=programs; tick(1); store_poll(1);
    assert(programs>p0 && store_pending()==2 && tx_n==4);
    assert(strstr(txall,"opens=5,q=4,qe=0\r\nwhy=timer,opens=6,q=5,qe=0\r\nwhy=timer,opens=5,q=4,qe=0,bf=1\r\nwhy=timer,opens=6,q=5,qe=0,bf=1\r\n")); /* resent from flash: marked bf=1 */
    ack_to(5,1); assert(store_pending()==0);
    /* link loss writes the ring to flash and does not send */
    fresh(0); store_poll(1); tx_reset(); assert(store_save("why=timer,opens=1\r\n"));
    store_poll(0); assert(store_pending()==1 && tx_n==1);
    send_all(1); assert(tx_n==2 && last_q()==0);
    /* backlog: a new report goes behind it in the flash, not into the ring */
    fresh(0); assert(store_save("why=timer,opens=1\r\n")); send_all(1); /* sent, not acked: still a backlog */
    p0=programs; assert(store_save("why=timer,opens=2\r\n")); assert(programs>p0 && store_pending()==2);
    assert(!strcmp(last_tx,"why=timer,opens=2,q=1,qe=0\r\n"));
    tx_reset(); send_all(1); assert(tx_n==0);
    tick(120000); store_poll(1);
    assert(tx_n==2 && strstr(last_tx,"opens=2,q=1,qe=0,bf=1"));
    ack_to(1,1); assert(store_pending()==0);
    /* batch: at most BATCH_MAX lines and BATCH_BYTES bytes, back to back, then wait */
    memset(pad,'x',80); pad[80]=0;
    fresh(0); for(i=0;i<12;i++){ char line[160]; snprintf(line,sizeof line,"why=timer,opens=1,pad=%s\r\n",pad); assert(store_save(line)); }
    tx_reset(); store_poll(1);
    assert(tx_n==7 && txlen<=900u);
    tick(500); store_poll(1); assert(tx_n==7); /* gap not over */
    tick(500); store_poll(1); assert(tx_n==12);
    /* a= covers the sent part only; later records stay */
    fresh(0); for(i=0;i<4;i++)assert(store_save("why=timer,opens=1\r\n"));
    tick(1); store_poll(1); tx_reset(); /* all four sent in one batch */
    assert(store_pending()==4);
    ack_to(1,0); assert(store_pending()==2);
    assert(store_save("why=timer,opens=9\r\n")); ack_to(100,0); assert(store_pending()==1); /* clipped to what was sent */
    /* q never repeats after a restart, even though the ring and counter are only in RAM */
    fresh(0); store_poll(1); tx_reset(); assert(store_save("why=timer,opens=1\r\n")); q0=last_q();
    boot(); store_poll(1); tx_reset(); assert(store_save("why=timer,opens=1\r\n")); q1=last_q(); assert(q1==q0+1);
    q0=q1; boot(); store_poll(1); tx_reset(); assert(store_save("why=timer,opens=1\r\n")); q1=last_q(); assert(q1>q0);
    /* Real resets, including crossing reservation blocks, consume no unused numbers. */
    fresh(0); store_poll(1); tx_reset(); assert(store_save("why=boot,opens=0\r\n"));
    assert(!strstr(last_tx,"qz=")); /* brand new flash: no gap */
    boot(); store_poll(1); tx_reset(); assert(store_save("why=boot,opens=0\r\n"));
    assert(!strcmp(last_tx,"why=boot,opens=0,q=1,qe=0\r\n"));
    assert(store_save("why=timer,opens=0\r\n") && !strstr(last_tx,"qz="));
    boot(); tx_reset(); assert(store_save("why=boot,opens=0\r\n")); /* offline: through the flash */
    send_all(1); store_poll(1);
    assert(!strcmp(last_tx,"why=boot,opens=0,q=3,qe=0,bf=1\r\n"));
    ack_to(3,1);
    for(i=4;i<48;i++) {
        boot(); store_poll(1); assert(store_save("why=timer,opens=0\r\n"));
        assert(last_q()==i && !strstr(last_tx,"qz=")); ack_to(i,1);
    }
    /* 1.0.17 stored a block limit and zero in the last two bytes. Keep its pending slot and epoch. */
    fresh(0); assert(store_save("why=timer,opens=8\r\n"));
    {   unsigned char *rec=flash+GD25_LOG_LIMIT+16;
        assert(rec[0]==0xA7); rec[8]=128; rec[14]=rec[15]=0; }
    boot(); assert(store_pending()==1); send_all(1);
    assert(last_q()==0 && strstr(last_tx,"bf=1"));
    assert(store_save("why=boot,opens=0\r\n"));
    assert(!strcmp(last_tx,"why=boot,opens=0,q=256,qe=0,qz=128\r\n"));
    ack_to(256,1); boot(); store_poll(1); assert(store_save("why=boot,opens=0\r\n"));
    assert(last_q()==257 && !strstr(last_tx,"qz="));
    /* A torn pointer snapshot after an already claimed q must never roll the counter back. */
    fresh(0); store_poll(1); assert(store_save("why=timer,opens=0\r\n") && last_q()==0);
    {   unsigned char *rec=flash+GD25_LOG_LIMIT+16;
        memcpy(rec+1, rec-16+1, 15); rec[14]=255; /* body programmed, header still erased */ }
    boot(); store_poll(1); assert(store_save("why=timer,opens=0\r\n") && last_q()==1);
    /* Reset after the one-bit claim but before UART: leave that uncertain number unacknowledged. */
    flash[GD25_LOG_LIMIT+14] &= (unsigned char)~4u;
    boot(); store_poll(1); assert(store_save("why=timer,opens=0\r\n") && last_q()==3);
    assert(!strstr(last_tx,"qz="));
    /* upgrading from a 1.0.8 pointer record drops the old queue and starts a new epoch */
    fresh(0);
    for(i=0;i<5;i++)assert(store_save("why=timer,opens=1\r\n"));
    memset(flash+GD25_LOG_LIMIT,255,4096);
    {   unsigned char *rec=flash+GD25_LOG_LIMIT; memset(rec,0,16); rec[0]=0xA7; rec[1]=0x5B; rec[6]=5; rec[10]=3; }
    boot(); assert(store_pending()==0);
    tx_reset(); store_poll(1); assert(store_save("why=timer,opens=1\r\n")); assert(strstr(last_tx,",q=0,qe=1\r\n"));
    /* resend: head stuck for 120 s with the link up pulls the send pointer back */
    fresh(0); assert(store_save("why=timer,opens=3\r\n")); send_all(1); tx_reset();
    tick(100000); store_poll(1); assert(tx_n==0);
    tick(21000); store_poll(0); assert(tx_n==0);
    store_poll(1); assert(tx_n==1);
    /* queue epoch grows on every clear and survives reboot */
    assert(store_factory_reset()); boot(); store_poll(0);
    assert(store_save("why=boot,opens=0\r\n")); tx_reset(); send_all(1);
    assert(strstr(last_tx,",qe=1,"));
    assert(store_factory_reset()); boot(); store_poll(0);
    assert(store_save("why=boot,opens=0\r\n")); tx_reset(); send_all(1);
    assert(strstr(last_tx,",qe=2,"));
}

static void test_link(void) {
    fresh(0);
    assert(!clock_link_seen() && !clock_link_online()); /* none seen: modem falls back to RDY */
    rx="net=2\n"; store_poll(0);
    assert(!clock_link_seen()); /* illegal value dropped */
    rx="net=0\n"; store_poll(0);
    assert(clock_link_seen() && !clock_link_online());
    rx="net=1\n"; store_poll(0);
    assert(clock_link_online());
    tick(CLOCK_LINK_STALE_MS-1u); assert(clock_link_online());
    tick(1); assert(clock_link_seen() && !clock_link_online()); /* stale: treated as offline, still no RDY fallback */
    rx="net=1\n"; store_poll(0); assert(clock_link_online());
    rx="ok p=5 c=0 v=5\n"; store_poll(0); assert(clock_policy_version()==5); /* ok unaffected */
}

static void test_ring(void) {
    static ring_t ring; uint8_t b; unsigned i;
    ring_clear(&ring); assert(!ring_pop(&ring,&b));
    for(i=0;i<RING_SIZE-1u;i++)assert(ring_push(&ring,(uint8_t)i));
    assert(!ring_push(&ring,0xEE)); /* full: newest byte is refused, oldest kept */
    for(i=0;i<RING_SIZE-1u;i++){assert(ring_pop(&ring,&b)&&b==(uint8_t)i);}
    assert(!ring_pop(&ring,&b));
    for(i=0;i<3u*RING_SIZE;i++){assert(ring_push(&ring,(uint8_t)(i*7)));assert(ring_pop(&ring,&b)&&b==(uint8_t)(i*7));} /* wraps */
}

int main(void) {
    factory_state_t state; factory_state_init(&state);
    for(unsigned i=0;i<6000;i++)factory_state_tick(&state,1);
    assert(state.phase==FACTORY_IDLE); /* held across reboot cannot repeatedly erase */
    factory_state_tick(&state,0);
    for(unsigned i=0;i<29;i++)factory_state_tick(&state,1);
    assert(factory_state_lights(&state)==-1);
    factory_state_tick(&state,0);
    for(unsigned i=0;i<30;i++)factory_state_tick(&state,1);
    assert(state.phase==FACTORY_HOLD && factory_state_lights(&state)==1);
    for(unsigned i=0;i<1667;i++)factory_state_tick(&state,1);
    assert(factory_state_lights(&state)==3);
    for(unsigned i=0;i<1667;i++)factory_state_tick(&state,1);
    assert(factory_state_lights(&state)==7);
    for(unsigned i=3334;i<4999;i++)factory_state_tick(&state,1);
    factory_state_tick(&state,0); assert(state.phase==FACTORY_IDLE);
    for(unsigned i=0;i<5030;i++)factory_state_tick(&state,1);
    assert(state.phase==FACTORY_RUN && factory_state_lights(&state)==7);
    for(unsigned i=0;i<125;i++)factory_state_tick(&state,1);
    assert(factory_state_lights(&state)==0);

    memset(flash,255,sizeof flash); pins[5]=1; boot(); tick(1);
    assert(poff_note_opens(42)); poff_poll();
    curve_observe(4200,2);curve_observe(3900,0);curve_observe(3300,0);curve_observe(3400,1);
    assert(curve_learned(0,0,0));
    for(unsigned i=0;i<40;i++)assert(store_save("why=timer,opens=42\r\n"));
    clock_set_period(60000);clock_set_charge_only(1);clock_set_policy_version(999);
    led_show(&led,0,LED_CHARGE_FULL,0); pins[5]=0;tick(30);
    assert(pins[12]==0 && pins[13]==1 && pins[14]==1);
    led_show(&led,1,LED_CHARGE_FULL,1);assert(pins[13]==1); /* business cannot overwrite progress */
    pins[5]=1;tick(1);assert(pins[12]==0 && pins[13]==0 && pins[14]==0);
    assert(store_pending()==40 && poff_opens()==42);
    pins[5]=0;tick(5030);run_reset();
    assert(rebooted==1 && poff_opens()==0 && store_pending()==0 && !curve_learned(0,0,0));
    assert(clock_period_seconds()==60 && clock_policy_version()==0 && !clock_charge_only());
    assert(poff_erases==0 && erases==3 && poff_has());
    assert(flash[0]==0xA5); /* prior power log remains */
    boot();assert(store_pending()==0 && poff_opens()==0 && poff_has());
    for(unsigned i=0;i<16;i++){assert(store_save("why=timer,opens=0\r\n"));tick(1000);store_poll(1);ack();}
    boot();assert(store_pending()==0); /* stale slot 16 must not resurrect */
    assert(store_save("why=boot,pv=0\r\n"));assert(store_pending()==1);ack();
    rx="ok p=60 c=1 v=12345678\n";store_poll(0);
    assert(clock_period_seconds()==60 && clock_charge_only() && clock_policy_version()==12345678);
    rebooted=0;pins[5]=1;tick(1);pins[5]=0;tick(5030);
    assert(factory_reset_poll()); /* persisted marker */
    fail_erase=1;assert(factory_reset_poll()); assert(!rebooted);
    fail_erase=0;boot();run_reset(); /* resume after a simulated power cut */
    assert(rebooted==1 && store_pending()==0 && poff_opens()==0);
    fresh(0); store_poll(1);
    tx_reset();
    assert(store_save("why=pad,opens=1\r\n"));
    assert(store_save("why=shut,opens=1\r\n"));
    assert(tx_n==2 && !strstr(txall,"bf=1"));
    uint32_t stored, in_flight, next, epoch;
    store_stats(&stored,&in_flight,&next,&epoch);
    assert(stored==2 && in_flight==0);
    boot(); assert(store_pending()==2);
    test_queue();
    test_link();
    test_lights();
    test_ring();
    test_remote();
    puts("PASS: remote wipe/dump, debounce, 4999ms cancel, 5s hold, LED takeover, ACK compatibility, selective erase, queue boundaries, power-cut resume");
    return 0;
}
