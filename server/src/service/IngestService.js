import { logSystem } from "../log/systemLog.js";
import { EventStream } from "../transport/EventStream.js";
import { ImeiGate } from "./ImeiGate.js";

/**
 * 设备上报的唯一入口。
 * 同一台设备先串行，箱子和原始报文在一个事务里提交；提交成功后才进入事件流。
 * 缓存或推送失败只记日志，不把已经提交的状态再回滚。
 */
export class IngestService {
  constructor({
    boxes,
    cache,
    hub,
    clock,
    parser,
    geocoder = null,
    policies = null,
    commands = null,
    queue = null,
    videos = null,
  }) {
    this.boxes = boxes;
    this.videos = videos;
    this.queue = queue;
    this.policies = policies;
    this.commands = commands;
    this.cache = cache;
    this.hub = hub;
    this.clock = clock;
    this.parser = parser;
    this.geocoder = geocoder;
    this.gate = new ImeiGate();
    this.events = new EventStream();
    this.events.subscribe((event) => this.cache.put(event.box));
    this.events.subscribe((event) => {
      this.hub.publish(event.box, event.record);
    });
  }

  async accept(rawText) {
    const uplinks = this.parser.parseMany(rawText);
    let last = null;
    for (const uplink of uplinks) {
      last = await this.#acceptOne(uplink);
      last.scheduled = uplink.scheduled;
    }
    return last;
  }

  async #acceptOne(uplink) {
    return this.gate.run(uplink.imei, async () => {
      if (this.commands) {
        if (uplink.dump) {
          // 板子回传的本机日志不进上报流水，也不确认，避免多出的 ok 把补传队列的记录确认掉。
          await this.commands.takeDump(await this.boxes.findByImei(uplink.imei), uplink);
          return { box: null, silent: true };
        }
        const verdict = await this.commands.onUplink(uplink);
        if (verdict?.wipe) return { box: null, downlink: this.commands.wipeLine(verdict.wipe) };
        if (verdict?.done) {
          // 设备已经抹除并重启：这时才删旧档案，这一包按新设备建档。
          await this.boxes.removeWiped(uplink.imei);
          try {
            await this.cache.remove(verdict.done.boxId);
          } catch (error) {
            logSystem({ source: "service", kind: "cache", deviceId: verdict.done.boxId, error });
          }
          await this.commands.finishWipe(uplink.imei);
        }
      }
      if (this.queue && uplink.q != null) {
        if (this.boxes.commitQueuedUplink) {
          const committed = await this.boxes.commitQueuedUplink(
            uplink,
            this.clock.now(),
            this.queue
          );
          committed.netLink = uplink.netLink;
          if (committed.record) await this.#publish(uplink, committed);
          return committed;
        }
        const state = await this.queue.seen(uplink);
        if (state?.dup) {
          // 重发的旧记录：已经存过，不再入库也不改箱子状态，只回累计确认号让设备清队列。
          const box = await this.boxes.findByImei(uplink.imei);
          if (box) return { box, ack: state.ack, netLink: uplink.netLink };
        }
        const committed = await this.#commitAndPublish(uplink);
        committed.ack = await this.queue.record(uplink);
        committed.netLink = uplink.netLink;
        return committed;
      }
      const committed = await this.#commitAndPublish(uplink);
      committed.netLink = uplink.netLink;
      return committed;
    });
  }

  /** wipe：只登记待抹除，档案保留；设备下次上报收到指令，重启确认后才真正删除。 */
  async deleteBox(box, authorize, options = {}) {
    return this.gate.run(box.imei, async () => {
      const result = await this.boxes.deleteBox(box.id, authorize, options);
      if (result.deleted) {
        try {
          await this.cache.remove(box.id);
        } catch (error) {
          logSystem({ source: "service", kind: "cache", deviceId: box.id, error });
        }
      }
      return result;
    });
  }

  async #commitAndPublish(uplink) {
    const committed = await this.boxes.commitUplink(uplink, this.clock.now());
    return this.#publish(uplink, committed);
  }

  async #publish(uplink, committed) {
    if (this.policies) {
      await this.policies.observe(committed.box, uplink);
      committed.box.reportPolicy = await this.policies.get(committed.box);
    }
    if (this.geocoder) {
      try {
        if (await this.geocoder.fill(committed.box)) await this.boxes.save(committed.box);
      } catch (error) {
        logSystem({ source: "service", kind: "geocoder", error, deviceId: committed.box.id });
        console.error("逆地理失败", error instanceof Error ? error.message : error);
      }
    }
    await this.events.publish(committed);
    if (this.videos && uplink.why === "pad") {
      // 采样机构开箱录像：只登记并异步请求平台，失败不影响上报
      try {
        await this.videos.onOpen(committed.box, uplink);
      } catch (error) {
        logSystem({ source: "service", kind: "video", deviceId: committed.box.id, error });
      }
    }
    if (this.commands) {
      try {
        committed.downlink = await this.commands.downlink(committed.box, uplink);
      } catch (error) {
        logSystem({ source: "service", kind: "command", deviceId: committed.box.id, error });
      }
    }
    return committed;
  }
}
