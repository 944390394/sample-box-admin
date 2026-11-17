import { decompressRaw } from "../src/store/rawCodec.js";

/**
 * 插着充电器时「充电中」和「已充满」来回跳的充电上报，改记成 chgs（充电状态），不再算事件。
 * 只有插上、拔掉充电器（没插 ↔ 插着）还是 chg。
 *
 * 每台箱子按收到顺序看它的上电、充电上报：前一条和这条一样是插着（或一样是没插），这条就是跳动。
 * 定时上报不改充电状态，所以只看这两类就够了。报文里读不到 chg= 的不动。
 */
/** 原文可能压缩存在 raw 或 raw_gz 里。 */
function textOf(row) {
  try {
    return decompressRaw(row.raw_gz) || decompressRaw(row.raw);
  } catch {
    return "";
  }
}

function chargeOf(text) {
  const match =
    String(text).match(/(?:^|[,\\\n"])chg=(\d+)/) || String(text).match(/"chg"\s*:\s*(\d+)/);
  return match ? Number(match[1]) : null;
}

const plugged = (charge) => charge === 1 || charge === 2;

export async function up(db) {
  const where = "WHERE kind IN ('boot', 'chg') ORDER BY box_id, received_at, id";
  // 老库可能只有 raw 或只有 raw_gz：按列依次试
  let rows = null;
  for (const columns of ["raw, raw_gz", "raw_gz", "raw"]) {
    try {
      rows = await db.all(`SELECT id, box_id, kind, ${columns} FROM sample_uplink ${where}`);
      break;
    } catch {
      rows = null;
    }
  }
  if (!rows) return;
  const flips = [];
  let box = null;
  let before = null;
  for (const row of rows) {
    if (row.box_id !== box) {
      box = row.box_id;
      before = null;
    }
    const charge = chargeOf(textOf(row));
    if (charge == null) continue;
    if (row.kind === "chg" && before != null && plugged(before) === plugged(charge))
      flips.push(row.id);
    before = charge;
  }
  for (let i = 0; i < flips.length; i += 500) {
    const ids = flips.slice(i, i + 500);
    await db.run(
      `UPDATE sample_uplink SET kind = 'chgs', summary = REPLACE(summary, '充电上报', '充电状态') WHERE id IN (${ids.map(() => "?").join(", ")})`,
      ids
    );
  }
}
