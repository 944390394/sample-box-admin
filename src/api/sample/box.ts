import request from "@/utils/request";
import type { SampleBox } from "@/views/sample/data";

export interface BoxLogItem {
  box: string;
  time: string;
  text: string;
  by: string;
  raw?: string;
  deviceTime?: string;
  kind?: string;
  lbsLng: number | null;
  lbsLat: number | null;
  gpsLng: number | null;
  gpsLat: number | null;
}

const SampleBoxAPI = {
  list() {
    return request<unknown, SampleBox[]>({ url: "/api/v1/sample/boxes", method: "get" });
  },
  detail(id: string) {
    return request<unknown, SampleBox>({ url: `/api/v1/sample/boxes/${id}`, method: "get" });
  },
  logs(id: string) {
    return request<unknown, BoxLogItem[]>({
      url: `/api/v1/sample/boxes/${id}/logs`,
      method: "get",
    });
  },
  reports() {
    return request<unknown, BoxLogItem[]>({ url: "/api/v1/sample/reports", method: "get" });
  },
};

export default SampleBoxAPI;
