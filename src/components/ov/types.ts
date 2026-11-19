/** 总览 ov 组件契约：三页复用，props/events 冻结于此。 */
import type { Component } from "vue";

export type Tone = "default" | "primary" | "success" | "warning" | "danger" | "info";

export interface KpiItem {
  key: string;
  label: string;
  value: number;
  /** 占比等真实 hint，不造假环比 */
  hint?: string;
  tone?: Tone;
  icon?: Component;
  clickable?: boolean;
}

export interface FlowStep {
  key: string;
  label: string;
  value: number;
  tone?: Tone;
}

export interface ChartSelect {
  seriesName?: string;
  name?: string;
  dataIndex?: number;
}
