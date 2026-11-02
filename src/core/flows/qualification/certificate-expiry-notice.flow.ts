import type * as Automation from '@objectstack/spec/automation';
import { certificateNoticeEdges, certificateNoticeNodes } from './certificate-notice.js';

// P10 到期提醒（03 §11，FR-901）：未过期的证书在有效期至前 30 / 15 / 7 天各提醒一次，通知 SQE 与供应商联系人
// （v0.6 U6 起供应商侧经门户通知）。平台按天扫描、每张证书每个提醒日只发一次（time_relative 触发）。
// 状态由 srm_certificate_expire_sweep 对齐，这里只提醒。
export const CertificateExpiryNoticeFlow: Automation.Flow = {
  name: 'srm_certificate_expiry_notice',
  label: '证书到期提醒',
  type: 'schedule',
  status: 'active',
  runAs: 'system',

  nodes: [
    {
      id: 'start',
      type: 'start',
      label: '有效期至前 30 / 15 / 7 天',
      config: {
        timeRelative: {
          object: 'srm_supplier_certificate',
          dateField: 'valid_to',
          offsetDays: [30, 15, 7],
          filter: { status: { $in: ['valid', 'expiring'] } },
        },
      },
    },
    ...certificateNoticeNodes({
      template: 'srm_certificate_expiring',
      title: '{{ vendor.name }} 的资质证书将于 {{ record.valid_to }} 到期',
      message: '证书编号 {{ record.cert_no }}，有效期至 {{ record.valid_to }}。请督促供应商换证并在门户上传新证书，收到后核验。',
      severity: 'info',
    }),
    { id: 'end', type: 'end', label: '结束' },
  ],

  edges: certificateNoticeEdges('start'),
};
