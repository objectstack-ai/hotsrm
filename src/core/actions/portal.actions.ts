import { P } from '@objectstack/spec';
import { defineAction } from '@objectstack/spec/ui';

// v0.6 门户自助维护的按钮（03 §3、§5、§11）。requiredPermissions 只决定按钮显示给谁，谁能操作仍由 flow 自己检查
// （门户按钮查门户名册，核验按钮查岗位）。

// 供应商档案上的「提交变更申请」：本公司门户管理员提交关键信息变更（srm_change_submit）
export const ChangeSubmitAction = defineAction({
  name: 'srm_change_submit',
  label: '提交变更申请',
  objectName: 'srm_supplier',
  icon: 'file-pen',
  type: 'flow',
  target: 'srm_change_submit',
  locations: ['record_header'],
  requiredPermissions: ['srm_portal_manage'],
  refreshAfter: true,
});

// 准入申请上的「补充完成，重新提交」：退回补充后由供应商门户提交（srm_application_resubmit）
export const ApplicationResubmitAction = defineAction({
  name: 'srm_application_resubmit',
  label: '补充完成，重新提交',
  objectName: 'srm_supplier_application',
  icon: 'send',
  type: 'flow',
  target: 'srm_application_resubmit',
  locations: ['record_header'],
  visible: P`record.status == 'returned'`,
  requiredPermissions: ['srm_portal_access'],
  refreshAfter: true,
});

// 证书上的「核验证书」：SQE、质量经理核对门户上传或修改的证书（srm_certificate_verify）
export const CertificateVerifyAction = defineAction({
  name: 'srm_certificate_verify',
  label: '核验证书',
  objectName: 'srm_supplier_certificate',
  icon: 'shield-check',
  type: 'flow',
  target: 'srm_certificate_verify',
  locations: ['record_header', 'list_item'],
  visible: P`record.verified != true && record.status != 'expired'`,
  requiredPermissions: ['srm_verify_certificate'],
  refreshAfter: true,
});

// 门户邀请上的「开通门户」（04 §3.3 第 2 步）：组织管理员在成员页发出邀请、对方接受后运行。谁能开通由 flow 自己检查
export const PortalEnableAction = defineAction({
  name: 'srm_portal_enable',
  label: '开通门户',
  objectName: 'srm_supplier_invitation',
  icon: 'key-round',
  type: 'flow',
  target: 'srm_portal_enable',
  locations: ['record_header', 'list_item'],
  visible: P`record.status == 'sent'`,
  refreshAfter: true,
});

// 门户公司资料上的「提交准入申请」（03 §3 第 1 步，FR-202）：只对受邀的门户用户有效，flow 按调用者的名册行确定供应商
export const ApplicationSubmitAction = defineAction({
  name: 'srm_application_submit',
  label: '提交准入申请',
  objectName: 'srm_supplier',
  icon: 'send',
  type: 'flow',
  target: 'srm_application_submit',
  locations: ['record_header'],
  visible: P`record.status == 'potential' || record.status == 'eliminated'`,
  requiredPermissions: ['srm_portal_access'],
  refreshAfter: true,
});
