import type * as Automation from '@objectstack/spec/automation';
import { certificateNoticeEdges, certificateNoticeNodes } from './certificate-notice.js';

// 证书过期通知（05 §5「证书已过期」，03 §11）：srm_certificate_expire_sweep 把证书置为「已过期」时（或有人手工置为已过期），
// 通知 SQE 与供应商联系人。资质异常标志和风险事件由 srm_supplier_qualification_recalc 处理，这里只通知。
export const CertificateExpiredNoticeFlow: Automation.Flow = {
  name: 'srm_certificate_expired_notice',
  label: '证书过期通知',
  type: 'record_change',
  status: 'active',
  runAs: 'system',

  nodes: [
    {
      id: 'start',
      type: 'start',
      label: '证书变为已过期',
      config: {
        objectName: 'srm_supplier_certificate',
        triggerType: 'record-after-update',
        condition: { dialect: 'cel', source: `record.status == 'expired' && has(previous.status) && previous.status != 'expired'` },
      },
    },
    ...certificateNoticeNodes({
      template: 'srm_certificate_expired',
      title: '{{ vendor.name }} 的资质证书已过期',
      message: '证书编号 {{ record.cert_no }}，有效期至 {{ record.valid_to }}，已过期。必备资质过期时供应商标记资质异常；请督促供应商在门户上传新证书，收到后核验。',
      severity: 'warning',
    }),
    { id: 'end', type: 'end', label: '结束' },
  ],

  edges: certificateNoticeEdges('start'),
};
