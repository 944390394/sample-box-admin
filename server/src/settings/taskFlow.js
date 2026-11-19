/**
 * 转发到 shared/taskFlow.js。
 *
 * 任务流程的枚举服务端和网页要用同一份，所以真正的定义放在仓库根的 shared/（和 shared/labels.js、shared/org.js 一样）。
 * 这个路径保留着：服务端各处、`server/test/*` 和已经写好的验收脚本都从这儿 import，改路径要一起动十几处，得不偿失。
 */
export * from "../../../shared/taskFlow.js";
