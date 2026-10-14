import request from "@/utils/request";
import type { SampleBox } from "@/views/sample/data";

export interface BoxLogItem {
  id?: string;
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

export interface UplinkQuery {
  from?: string;
  to?: string;
  limit?: number;
  cursorTime?: string;
  cursorId?: string;
}

export interface UplinkPage {
  list: BoxLogItem[];
  nextCursor: { time: string; id: string } | null;
}

const SampleBoxAPI = {
  list() {
    return request<unknown, SampleBox[]>({ url: "/api/v1/sample/boxes", method: "get" });
  },
  detail(id: string) {
    return request<unknown, SampleBox>({ url: `/api/v1/sample/boxes/${id}`, method: "get" });
  },
  logs(id: string, params?: UplinkQuery) {
    return request<unknown, UplinkPage>({
      url: `/api/v1/sample/boxes/${id}/logs`,
      method: "get",
      params,
    });
  },
  raw(id: string, logId: string, receivedAt: string) {
    return request<unknown, { raw: string }>({
      url: `/api/v1/sample/boxes/${id}/logs/${logId}`,
      method: "get",
      params: { receivedAt },
    });
  },
  reports() {
    return request<unknown, BoxLogItem[]>({ url: "/api/v1/sample/reports", method: "get" });
  },
};

export default SampleBoxAPI;
