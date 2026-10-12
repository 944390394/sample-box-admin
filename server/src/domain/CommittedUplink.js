/** 一次已经提交的上报。缓存和页面推送只消费这个结果，不再参与落库。 */
export class CommittedUplink {
  constructor(box, record) {
    this.box = box;
    this.record = record;
  }
}
