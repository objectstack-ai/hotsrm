import { P } from '@objectstack/spec';
import { defineSharingRule } from '@objectstack/spec/security';

// 共享规则：对象 OWD 保持 public_read 时，让某个岗位能改别人建的记录而不能删（objectstack#25470 的裁定写法）。
// 对象权限仍要有 allowEdit，共享只放宽「哪些行」，不放宽「哪些动作」。

// 绩效指标库（02 §4.7，FR-701）：采购总监维护全部指标，包括系统种子建的示例指标。
// 条件不能是恒真（平台把恒真条件当作不匹配，ADR-0049），指标编码必填，所以 code != '' 覆盖全部指标
export const KpiDirectorEdit = defineSharingRule({
  name: 'srm_kpi_director_edit',
  label: '采购总监维护绩效指标',
  object: 'srm_kpi',
  type: 'criteria',
  condition: P`record.code != ''`,
  accessLevel: 'edit',
  sharedWith: { type: 'position', value: 'srm_procurement_director' },
});

export const SrmSharingRules = [KpiDirectorEdit];
