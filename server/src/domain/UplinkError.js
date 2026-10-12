/** 报文无法入库。接入层记下原因并丢掉这一包，不中断监听。 */
export class UplinkError extends Error {
  constructor(message) {
    super(message);
    this.name = "UplinkError";
  }
}
