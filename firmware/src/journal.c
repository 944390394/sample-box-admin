#include "journal.h"

#include "crc16.h"
#include "sector_log.h"

#include <string.h>

#define JOURNAL_SLOT 32u
#define JOURNAL_MAGIC 0x31544F4Cu
#define JOURNAL_META_MAGIC 0x314D544Au

typedef struct __attribute__((packed)) {
    uint32_t magic;
    uint32_t seq;
    uint32_t rtc_sec;
    uint16_t opens;
    uint16_t mv;
    uint8_t why;
    uint8_t lid_open;
    uint16_t crc;
    uint8_t reserved[12];
} journal_slot_t;

typedef struct __attribute__((packed)) {
    uint32_t magic;
    uint32_t seq;
    uint32_t write_index;
    uint32_t read_index;
    uint32_t count;
    uint32_t seq_next;
    uint16_t crc;
    uint8_t reserved[6];
} journal_meta_t;

_Static_assert(sizeof(journal_slot_t) == 32, "journal slot");
_Static_assert(sizeof(journal_meta_t) == 32, "journal meta");

static int meta_valid(const void *rec)
{
    const journal_meta_t *meta = rec;
    if (meta->magic != JOURNAL_META_MAGIC) {
        return 0;
    }
    return crc16(rec, 24) == meta->crc;
}

static int slot_valid(const journal_slot_t *slot)
{
    if (slot->magic != JOURNAL_MAGIC) {
        return 0;
    }
    return crc16(slot, 18) == slot->crc;
}

static uint32_t slot_addr(const journal_t *journal, uint32_t index)
{
    return journal->data_base + (index % journal->capacity) * JOURNAL_SLOT;
}

static int read_slot(const journal_t *journal, uint32_t index, journal_slot_t *slot)
{
    return journal->ops->read(journal->ops->ctx, slot_addr(journal, index), slot, sizeof *slot);
}

static int sector_has_live(const journal_t *journal, uint32_t sector)
{
    uint32_t index = journal->read_index;
    uint32_t i;

    for (i = 0; i < journal->count; i++) {
        uint32_t addr = slot_addr(journal, index);
        if (addr >= sector && addr < sector + journal->erase_size) {
            return 1;
        }
        index++;
    }
    return 0;
}

static int slot_blank(const journal_t *journal, uint32_t index)
{
    uint8_t buf[JOURNAL_SLOT];
    uint32_t i;
    if (journal->ops->read(journal->ops->ctx, slot_addr(journal, index), buf, sizeof buf) != 0) {
        return 0;
    }
    for (i = 0; i < sizeof buf; i++) {
        if (buf[i] != 0xFFu) {
            return 0;
        }
    }
    return 1;
}

static int commit_meta(journal_t *journal)
{
    journal_meta_t meta;

    memset(&meta, 0, sizeof meta);
    meta.magic = JOURNAL_META_MAGIC;
    meta.seq = journal->meta_seq + 1u;
    meta.write_index = journal->write_index;
    meta.read_index = journal->read_index;
    meta.count = journal->count;
    meta.seq_next = journal->seq_next;
    meta.crc = crc16(&meta, 24);
    if (sector_log_append(&journal->meta_log, &meta, meta_valid) != 0) {
        return -1;
    }
    journal->meta_seq = meta.seq;
    return 0;
}

static void remember_meta(journal_t *journal, const journal_meta_t *meta)
{
    journal->write_index = meta->write_index;
    journal->read_index = meta->read_index;
    journal->count = meta->count;
    journal->seq_next = meta->seq_next == 0 ? 1u : meta->seq_next;
    journal->meta_seq = meta->seq;
}

static int heal(journal_t *journal)
{
    int changed = 0;
    int guard;

    while (journal->count > 0) {
        journal_slot_t slot;
        if (read_slot(journal, journal->read_index, &slot) != 0) {
            return -1;
        }
        if (slot_valid(&slot)) {
            break;
        }
        journal->read_index++;
        journal->count--;
        changed = 1;
    }

    for (guard = 0; guard < 4; guard++) {
        journal_slot_t slot;
        if (journal->count >= journal->capacity) {
            break;
        }
        if (slot_blank(journal, journal->write_index)) {
            break;
        }
        if (read_slot(journal, journal->write_index, &slot) != 0) {
            return -1;
        }
        if (!slot_valid(&slot) || slot.seq != journal->seq_next) {
            break;
        }
        journal->write_index++;
        journal->count++;
        journal->seq_next = slot.seq + 1u;
        changed = 1;
    }

    if (changed) {
        return commit_meta(journal);
    }
    return 0;
}

int journal_init(journal_t *journal, flash_ops_t *ops, const journal_geom_t *geom)
{
    journal_meta_t meta;
    int loaded;

    if (journal == 0 || ops == 0 || geom == 0) {
        return -1;
    }
    if (geom->erase_size < JOURNAL_SLOT || (geom->erase_size & (geom->erase_size - 1u)) != 0) {
        return -1;
    }
    if (geom->data_size < geom->erase_size || (geom->data_size % geom->erase_size) != 0) {
        return -1;
    }
    if ((geom->erase_size % JOURNAL_SLOT) != 0 || (geom->data_base % geom->erase_size) != 0) {
        return -1;
    }

    memset(journal, 0, sizeof *journal);
    journal->ops = ops;
    journal->data_base = geom->data_base;
    journal->data_size = geom->data_size;
    journal->erase_size = geom->erase_size;
    journal->capacity = geom->data_size / JOURNAL_SLOT;
    journal->seq_next = 1;
    sector_log_init(&journal->meta_log, ops, geom->meta_a, geom->meta_b, geom->erase_size);

    loaded = sector_log_load(&journal->meta_log, &meta, meta_valid);
    if (loaded < 0) {
        return -1;
    }
    if (loaded == 0) {
        remember_meta(journal, &meta);
    }
    return heal(journal);
}

static void fill_event(const journal_slot_t *slot, journal_event_t *event)
{
    event->seq = slot->seq;
    event->why = slot->why;
    event->lid_open = slot->lid_open;
    event->opens = slot->opens;
    event->mv = slot->mv;
    event->rtc_sec = slot->rtc_sec;
}

int journal_append(journal_t *journal, journal_event_t *event)
{
    uint32_t addr;
    uint32_t sector;
    journal_slot_t slot;

    if (journal == 0 || event == 0 || journal->capacity == 0) {
        return -1;
    }
    addr = slot_addr(journal, journal->write_index);
    if (!slot_blank(journal, journal->write_index)) {
        if (((addr - journal->data_base) % journal->erase_size) != 0) {
            return -1;
        }
        sector = addr & ~(journal->erase_size - 1u);
        /*
         * 扇区里还有没确认的记录时不能擦。只有整张日志都满了，才丢掉这一扇最旧的，
         * 给新的开箱记录腾位置。已经确认过、只是还没擦的扇区可以直接擦掉重写。
         */
        if (sector_has_live(journal, sector)) {
            if (journal->count < journal->capacity) {
                return -1;
            }
            while (journal->count > 0) {
                uint32_t oldest = slot_addr(journal, journal->read_index);
                if (oldest < sector || oldest >= sector + journal->erase_size) {
                    break;
                }
                journal->read_index++;
                journal->count--;
            }
        }
        if (journal->ops->erase(journal->ops->ctx, sector) != 0) {
            return -1;
        }
    }
    if (journal->count >= journal->capacity) {
        return -1;
    }

    memset(&slot, 0, sizeof slot);
    slot.magic = JOURNAL_MAGIC;
    slot.seq = journal->seq_next;
    slot.rtc_sec = event->rtc_sec;
    slot.opens = event->opens;
    slot.mv = event->mv;
    slot.why = event->why;
    slot.lid_open = event->lid_open ? 1u : 0u;
    slot.crc = crc16(&slot, 18);
    if (journal->ops->program(journal->ops->ctx, addr, &slot, sizeof slot) != 0) {
        return -1;
    }
    event->seq = slot.seq;
    journal->write_index++;
    journal->count++;
    journal->seq_next++;
    return commit_meta(journal);
}

int journal_peek(const journal_t *journal, journal_event_t *event)
{
    journal_slot_t slot;

    if (journal == 0 || event == 0) {
        return -1;
    }
    if (journal->count == 0) {
        return 1;
    }
    if (read_slot(journal, journal->read_index, &slot) != 0 || !slot_valid(&slot)) {
        return -1;
    }
    fill_event(&slot, event);
    return 0;
}

int journal_ack(journal_t *journal, uint32_t seq)
{
    journal_event_t event;

    if (journal_peek(journal, &event) != 0) {
        return -1;
    }
    if (event.seq != seq) {
        return -1;
    }
    journal->read_index++;
    journal->count--;
    return commit_meta(journal);
}

uint32_t journal_next_seq(const journal_t *journal)
{
    return journal->seq_next;
}

uint32_t journal_count(const journal_t *journal)
{
    return journal->count;
}
