import { defineCapability } from '@objectstack/spec';

// 应用自己的授权能力（平台 ADR-0066 D1）。字段、应用、按钮用 requiredPermissions 引用，权限集用 systemPermissions 授予。
export const ViewBankAccountNo = defineCapability({
  name: 'srm_view_bank_account_no',
  label: '查看完整银行账号',
  description: '读取供应商银行账号的完整值；没有这项能力的人只看到后 4 位（BR-20）',
  scope: 'org',
});

// 门户（v0.6）：只决定看不看得到门户应用和门户上的按钮，是体验；数据边界仍是门户 RLS（05 §1）
export const PortalAccess = defineCapability({
  name: 'srm_portal_access',
  label: '使用供应商门户',
  description: '看到供应商门户应用和门户用户的按钮（如准入申请「补充完成，重新提交」）；能看哪些数据仍由门户行级规则决定',
  scope: 'org',
});

export const PortalManage = defineCapability({
  name: 'srm_portal_manage',
  label: '门户管理员操作',
  description: '看到门户管理员的按钮（如「提交变更申请」）；谁能提交仍由 flow 按门户名册检查',
  scope: 'org',
});

// 核验证书（v0.6）：只决定按钮显示给谁，谁能核验仍由 srm_certificate_verify 检查岗位
export const VerifyCertificate = defineCapability({
  name: 'srm_verify_certificate',
  label: '核验证书',
  description: '看到证书上的「核验证书」按钮（SQE、质量经理）',
  scope: 'org',
});

export const SrmCapabilities = [ViewBankAccountNo, PortalAccess, PortalManage, VerifyCertificate];
