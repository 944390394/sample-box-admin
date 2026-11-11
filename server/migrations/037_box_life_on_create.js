/**
 * 箱子从建任务单起就算占用（显示「在途」），不再等任务开始。
 * 补上已有数据：绑在没结束的任务单里、但还标着「未使用」的箱子（单子还在待寄出、待采样）改成「在途」。
 */
export async function up(db) {
  await db.run(
    `UPDATE sample_box SET life = '在途' WHERE life = '未使用' AND id IN (
      SELECT m.box_id FROM sample_task_box m JOIN sample_task t ON t.id = m.task_id
      WHERE t.status NOT IN ('已完成', '已签收', '已拒收', '已取消')
    )`
  );
}
