import request from "@/utils/request";

/** 地名搜索结果：regions 是「先选地区」的候选，pois 是具体地点。 */
export interface RegionHit {
  name: string;
  code: string;
  count: number;
  leaf: boolean;
  lng?: number;
  lat?: number;
}
export interface PlaceHit {
  name: string;
  address: string;
  type?: string;
  lng: number;
  lat: number;
}
export type PlaceSearch =
  | { kind: "regions"; items: RegionHit[]; total: number }
  | { kind: "pois"; items: PlaceHit[]; total: number }
  | { kind: "none"; items: never[]; total: number };

const GeoAPI = {
  /** region 是 9 位国标码（如合肥市 156340100），不传为全国。 */
  search(q: string, region = "", page = 0) {
    return request<unknown, PlaceSearch>({
      url: "/api/v1/geo/search",
      params: { q, region: region || undefined, page: page || undefined },
    });
  },
};

export default GeoAPI;

/** 省市数据里的 2 位省码、4 位市码、6 位区县码换成天地图用的 9 位国标码。 */
export function toGbCode(code: string) {
  return `156${code.padEnd(6, "0")}`;
}
