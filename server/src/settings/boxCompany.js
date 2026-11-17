/**
 * 公司：部门树的顶级部门。一个单位属于哪个公司，就是从它往上找到的顶级部门。
 * 没分配单位的箱子归第一个顶级部门（总公司），和数据范围里的约定一致（见 boxAccess）。
 *
 * 寄出采样箱时，寄出单位只能在箱子所属公司里选（公司本身或它下面的部门），不能从别的公司寄出。
 * 要把箱子给别的公司用，先在采样箱管理里分配。
 *
 * rows：sys_dept 的行，至少有 id、parent_id、sort、name。
 */
export function companyTool(rows) {
  const byId = new Map(rows.map((row) => [String(row.id), row]));
  const tops = rows
    .filter((row) => !byId.has(String(row.parent_id)))
    .sort(
      (a, b) =>
        (Number(a.sort) || 0) - (Number(b.sort) || 0) || String(a.id).localeCompare(String(b.id))
    );
  const hq = tops[0] ? String(tops[0].id) : "";
  const companyOf = (orgId) => {
    let cursor = orgId ? byId.get(String(orgId)) : null;
    if (!cursor) return hq;
    const seen = new Set();
    while (byId.has(String(cursor.parent_id)) && !seen.has(String(cursor.id))) {
      seen.add(String(cursor.id));
      cursor = byId.get(String(cursor.parent_id));
    }
    return String(cursor.id);
  };
  const nameOf = (id) => byId.get(String(id))?.name || "";
  return { hq, companyOf, nameOf };
}

/**
 * 寄出单位要和箱子同属一个公司。返回错误文字，没问题返回空串。
 * boxes：带 org_id / orgId 的箱子。
 */
export function senderProblem(rows, boxes, fromOrgId) {
  const { companyOf, nameOf } = companyTool(rows);
  const companies = [...new Set(boxes.map((box) => companyOf(box.org_id ?? box.orgId ?? "")))];
  if (companies.length > 1) {
    return `选中的箱子分属 ${companies.map(nameOf).join("、")}，一张单只能从一个公司寄出，请分开建单`;
  }
  if (companies.length === 1 && companyOf(fromOrgId) !== companies[0]) {
    return `寄出单位只能在箱子所属的「${nameOf(companies[0])}」里选；要从别的公司寄出，先在采样箱里把箱子分配过去`;
  }
  return "";
}
