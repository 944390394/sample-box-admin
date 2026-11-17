import { h, ref } from "vue";
import { ElMessage, ElMessageBox, ElRadio, ElRadioGroup } from "element-plus";
import SampleBoxAPI from "@/api/sample/box";

export function policyStatusText(status?: string) {
  if (!status) return "—";
  return status === "已生效" || status === "未生效" ? status : `未生效 · ${status}`;
}

/** 列表、详情和策略弹窗共用：只有已生效是成功色，其余统一为警告色。 */
export function policyStatusType(status?: string) {
  if (!status) return "info";
  return status === "已生效" ? "success" : "warning";
}

/** 1.0.6 起固件认抹除和导出指令；服务端仍会再核对一次。 */
export function supportsRemote(firmware?: string) {
  const parts = String(firmware || "")
    .split(".")
    .map(Number);
  if (parts.length < 3 || parts.some((n) => !Number.isInteger(n) || n < 0)) return false;
  const [major, minor, patch] = parts;
  return major > 1 || (major === 1 && (minor > 0 || patch >= 6));
}

type Wipe = "" | "quick" | "full";

/** 「抹除中」标签的悬停说明。 */
export function wipeTitle(wipe: { mode: string; issued: boolean }) {
  const kind = wipe.mode === "full" ? "完整" : "快速";
  return wipe.issued
    ? `已向设备下发${kind}抹除，等设备重启后确认`
    : `已请求${kind}抹除，等设备下次上报时下发`;
}

/**
 * 删除始终由服务端复核状态和任务关联；取消确认不产生请求。
 * remote：设备支持远程抹除、且自己有「远程抹除设备」权限（服务端给的 box.remote，不再看固件版本号）。
 * wiping 为真表示已经在等设备抹除；这里选「不抹除」会撤销请求并直接删档案。
 */
export async function deleteArchive(
  id: string,
  remote = false,
  wiping = false,
  name = id
): Promise<boolean> {
  const wipe = ref<Wipe>("");
  const note = (text: string) =>
    h(
      "p",
      {
        style: "margin:6px 0 0;color:var(--el-text-color-secondary);font-size:12px;line-height:1.6",
      },
      text
    );
  try {
    await ElMessageBox.confirm(
      () =>
        h("div", [
          h(
            "p",
            { style: "margin:0;line-height:1.6" },
            wiping
              ? `${name} 正在等设备抹除。选「不抹除」会撤销抹除请求并立即删除档案；再选抹除则重新登记请求，档案继续保留到设备确认。`
              : `删除 ${name} 的档案、上报和策略记录，保留已结束任务。若关联未结束任务将无法删除。同一设备再次上报会新建为待激活。此操作不可撤销。`
          ),
          remote
            ? h("div", { style: "margin-top:12px" }, [
                h("div", { style: "font-weight:600;margin-bottom:6px" }, "同时抹除设备本机数据"),
                h(
                  ElRadioGroup,
                  {
                    modelValue: wipe.value,
                    "onUpdate:modelValue": (value: unknown) => {
                      wipe.value = value as Wipe;
                    },
                  },
                  () => [
                    h(ElRadio, { value: "" }, () => "不抹除"),
                    h(ElRadio, { value: "quick" }, () => "快速抹除"),
                    h(ElRadio, { value: "full" }, () => "完整抹除"),
                  ]
                ),
                note(
                  "档案会先保留并显示「抹除中」。设备下次上报才会收到指令，之后清除离线队列、开箱次数、策略和掉电日志并重启；设备重启上报后，旧档案才会删除并重新建档为待激活。快速只擦有数据的日志扇区；完整逐个擦除整片日志区，耗时更长，期间设备不上报。设备长期离线，指令保留 30 天，到期档案恢复正常。"
                ),
              ])
            : note(
                "不能远程抹除（设备固件低于 1.0.6，或你没有「远程抹除设备」权限）；设备上的数据会保留，需要现场长按 PB5 恢复出厂。"
              ),
        ]),
      "删除采样箱档案",
      {
        type: "warning",
        confirmButtonText: "确认",
        cancelButtonText: "取消",
        closeOnClickModal: false,
      }
    );
  } catch {
    return false;
  }
  try {
    const result = await SampleBoxAPI.remove(id, remote ? wipe.value : "");
    ElMessage.success(
      result.wiping
        ? "已请求抹除，档案显示「抹除中」，设备确认后才会删除"
        : "档案已删除，再次上报后可重新激活"
    );
    return true;
  } catch {
    return false;
  }
}
