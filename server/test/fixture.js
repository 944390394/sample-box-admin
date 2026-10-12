/** 测试用的设备报文。字段和银尔达实际上报一致，缺的坐标写成 000.0000000。 */
export function packet(overrides = {}) {
  return JSON.stringify({
    uart: "why=timer,aa55=0",
    lbslat: "000.0000000",
    gpsfix: 0,
    lbslng: "000.0000000",
    imsi: "460130610629998",
    iccid: "898608911026D0279998",
    time: "2026-09-28 17:11:27",
    csq: 19,
    vbat: 3760,
    imei: "864317080992517",
    ...overrides,
  });
}
