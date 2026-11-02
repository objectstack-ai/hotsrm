import { defineCapability } from '@objectstack/spec';

// 应用自己的授权能力（平台 ADR-0066 D1）。字段用 requiredPermissions 引用，权限集用 systemPermissions 授予。
export const ViewBankAccountNo = defineCapability({
  name: 'srm_view_bank_account_no',
  label: '查看完整银行账号',
  description: '读取供应商银行账号的完整值；没有这项能力的人只看到后 4 位（BR-20）',
  scope: 'org',
});

export const SrmCapabilities = [ViewBankAccountNo];
