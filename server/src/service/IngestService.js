import { EventStream } from "../transport/EventStream.js";
import { ImeiGate } from "./ImeiGate.js";

/**
 * 设备上报的唯一入口。
 * 同一台设备先串行，箱子和原始报文在一个事务里提交；提交成功后才进入事件流。
 * 缓存或推送失败只记日志，不把已经提交的状态再回滚。
 */
export class IngestService {
  constructor({ boxes, cache, hub, clock, parser }) {
    this.boxes = boxes;
    this.cache = cache;
    this.hub = hub;
    this.clock = clock;
    this.parser = parser;
    this.gate = new ImeiGate();
    this.events = new EventStream();
    this.events.subscribe((event) => this.cache.put(event.box));
    this.events.subscribe((event) => {
      this.hub.publish(event.box, event.record);
    });
  }

  async accept(rawText) {
    const uplink = this.parser.parse(rawText);
    const committed = await this.gate.run(uplink.imei, () =>
      this.boxes.commitUplink(uplink, this.clock.now())
    );
    await this.events.publish(committed);
    return committed;
  }
}
