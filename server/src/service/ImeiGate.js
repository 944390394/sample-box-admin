/**
 * 按 IMEI 串行处理上报。
 * 同一台设备的两包同时到达时，后一包会看到前一包已经建好的箱子，不会再领一个新箱号。
 */
export class ImeiGate {
  constructor() {
    this.tails = new Map();
  }

  run(imei, task) {
    const previous = this.tails.get(imei) || Promise.resolve();
    const run = previous.then(task, task);
    const tail = run.then(
      () => undefined,
      () => undefined
    );
    this.tails.set(imei, tail);
    tail.then(() => {
      if (this.tails.get(imei) === tail) this.tails.delete(imei);
    });
    return run;
  }
}
