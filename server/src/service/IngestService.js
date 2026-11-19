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
      // 待抹除：这一包照常入库，只把抹除指令附在下行里。
      // 修复前这里直接 return，设备在确认抹除前的数据全丢，最长 30 天不上报（体检编号 L-P1-2）。
      let wipeLine = null;
      if (this.commands) {
        if (uplink.dump) {
          // 板子回传的本机日志不进上报流水，也不确认，避免多出的 ok 把补传队列的记录确认掉。
          await this.commands.takeDump(await this.boxes.findByImei(uplink.imei), uplink);
          return { box: null, silent: true };
        }
        const verdict = await this.commands.onUplink(uplink);
        if (verdict?.wipe) wipeLine = this.commands.wipeLine(verdict.wipe);
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
        // 补传记录的「查重、入库、累计确认」必须在同一个事务里做完，缺这一步就会两条乱序连接
        // 同时判定「没见过」而重复入库，所以只认支持事务入库的存储（L-P2-1）。
        // 原来这里还有一条非事务的 queue.seen()/record() 退路：只有测试用的 MemoryBoxStore 会走到，
        // 生产上永远进不来，留着一个有竞态的分支只会误导后来人，已删。
        if (!this.boxes.commitQueuedUplink)
          throw new Error("补传队列要求存储实现 commitQueuedUplink 事务入库");
        const committed = await this.boxes.commitQueuedUplink(uplink, this.clock.now(), this.queue);
        committed.netLink = uplink.netLink;
        if (committed.record) await this.#publish(uplink, committed, wipeLine);
        // 重发的旧记录：这一包不再入库、也不改箱子状态，但待抹除的下行照常回，别多等一轮
        else if (wipeLine) committed.downlink = wipeLine;
        return committed;
      }
      return await this.#commitAndPublish(uplink, wipeLine);
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

  async #commitAndPublish(uplink, wipeLine = null) {
    const committed = await this.boxes.commitUplink(uplink, this.clock.now());
    committed.netLink = uplink.netLink;
    return this.#publish(uplink, committed, wipeLine);
  }

  async #publish(uplink, committed, wipeLine = null) {
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
    if (this.videos && (uplink.kind ?? uplink.why) === "pad") {
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
    // 下行只有一个坑位：待抹除时优先回抹除指令，导出请求留在下一包（没 issued_at 就一直会重发）
    if (wipeLine) committed.downlink = wipeLine;
    return committed;
  }
}
