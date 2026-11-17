/** 误差范围给人看：不到 1 公里用米，到了就换成公里。 */
export function radiusText(m: number) {
  if (m < 1000) return `${m} 米`;
  const km = m / 1000;
  return `${Number.isInteger(km) ? km : km.toFixed(km < 10 ? 1 : 0)} 公里`;
}
