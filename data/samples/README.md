# 样例导入表格

这里的表格演示从 ERP 导出数据、用平台导入写入 SRM 的格式。全部是标明「示例」的虚构数据，
不对应任何真实企业或物料清单（AGENTS.md 红线 5）。CI 用它们验证导入可重复执行（`test/material.test.ts`）。

## 物料 `srm_material.csv`

物料是 ERP 物料主数据的只读副本（[02 §4.1](../../docs/design/02-domain-model.md#41-供应商主数据)，
[ADR-0008](../../docs/adr/0008-order-to-pay-stays-in-erp.md)）。ERP 是源，SRM 不新建物料。

| 列 | 字段 | 说明 |
|---|---|---|
| `erp_material_no` | ERP 物料号 | 必填，组织内唯一；导入按它匹配，已有则更新、没有则新建 |
| `material_code` | 物料编码 | 必填 |
| `name` | 物料名称 | 必填 |
| `specification` | 规格型号 | |
| `uom` | 计量单位 | 文本，如「个」「卷」 |
| `active` | 启用 | `true` / `false`；ERP 中停用的物料导入为 `false`，不删除 |

### 导入步骤

1. 从 ERP 导出物料主数据，把列名改成上表的字段名（或在导入界面逐列映射）。
2. 以 `srm_admin` 岗位登录，打开「基础数据 › 物料」，选择导入，写入方式选 **upsert**，
   匹配字段选 **ERP 物料号**（`erp_material_no`）。
3. 先试运行（接口参数 `dryRun: true`）看预览，没有错误再正式导入。

接口方式等价于：

```http
POST /api/v1/data/srm_material/import
{ "format": "csv", "csv": "<表格内容>", "writeMode": "upsert", "matchFields": ["erp_material_no"] }
```

### 注意

- **日常重复导入不要带 `category` 列**。品类关联由采购员在 SRM 里维护，表格里带这一列会把它覆盖。
  首次初始化时如果 ERP 的物料组能对上 SRM 品类，可以带上，值填品类名称。
- 同一张表格导入两遍，第二遍只更新、不新增，记录数与字段值不变。
- 未关联品类的物料在「物料 › 未关联品类」视图里，供采购员补齐。
