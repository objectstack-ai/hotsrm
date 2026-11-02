import { P } from '@objectstack/spec';
import { defineAction } from '@objectstack/spec/ui';

// 整改单上的「确认索赔」（03 §8 第 6 步）：供应商在门户接受索赔或提出异议。谁能操作由 flow 自己检查（本公司门户用户）。
export const ClaimRespondAction = defineAction({
  name: 'srm_claim_respond',
  label: '确认索赔',
  objectName: 'srm_quality_issue',
  icon: 'receipt',
  type: 'flow',
  target: 'srm_claim_respond',
  locations: ['record_header'],
  visible: P`record.claim_status == 'proposed'`,
  refreshAfter: true,
});
