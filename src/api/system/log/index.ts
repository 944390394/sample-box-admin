import request from "@/utils/request";
import type {
  LogQueryParams,
  LogItem,
  VisitTrendQueryParams,
  VisitTrendDetail,
  VisitOverviewDetail,
  OnlineActorCount,
  UserStatsDetail,
} from "./types";
import type { PageResult } from "@/api/common";

const LOG_BASE_URL = "/api/v1/logs";

const LogAPI = {
  /** 获取日志分页列表 */
  getPage(queryParams: LogQueryParams) {
    return request<unknown, PageResult<LogItem>>({
      url: `${LOG_BASE_URL}`,
      method: "get",
      params: queryParams,
    });
  },

  /** 获取访问趋势统计 */
  getVisitTrend(queryParams: VisitTrendQueryParams) {
    return request<unknown, VisitTrendDetail>({
      url: `${LOG_BASE_URL}/analytics/trend`,
      method: "get",
      params: queryParams,
    });
  },

  /** 获取访问概览统计 */
  getVisitOverview() {
    return request<unknown, VisitOverviewDetail>({
      url: `${LOG_BASE_URL}/analytics/overview`,
      method: "get",
    });
  },

  /** 最近 15 分钟在线人数。失败由首页自己显示离线，不弹全局错误。 */
  getOnlineActors() {
    return request<unknown, OnlineActorCount>({
      url: `${LOG_BASE_URL}/analytics/online`,
      method: "get",
      silent: true,
    });
  },

  /** 系统用户人数和今天相对昨天的新增增长率 */
  getUserStats() {
    return request<unknown, UserStatsDetail>({
      url: `${LOG_BASE_URL}/analytics/users`,
      method: "get",
    });
  },
};

export default LogAPI;

// 重导出类型
export * from "./types";
