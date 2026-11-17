/** 箱子状态跟随任务：已经在进行中任务里的「未使用」箱子改成「在途」。之后由任务流转维护。 */
export async function up(db) {
  try {
    await db.run(
      "UPDATE sample_box SET life = '在途' WHERE life = '未使用' AND id IN (SELECT box_id FROM box_active_task)"
    );
  } catch {
    /* 老库还没有任务表 */
  }
}
