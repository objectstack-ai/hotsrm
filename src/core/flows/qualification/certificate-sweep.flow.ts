import { cel } from '@objectstack/spec';
import type * as Automation from '@objectstack/spec/automation';

// 每条证书一次更新，失败只跳过该条，不中断整次扫描
const eachCertificate = (key: string, collection: ReturnType<typeof cel>, status: string): Automation.FlowNode => ({
  id: `each_${key}`,
  type: 'loop',
  label: `逐条置为 ${status}`,
  config: {
    collection,
    iteratorVariable: 'cert',
    body: {
      nodes: [
        {
          id: `guard_${key}`,
          type: 'try_catch',
          label: '单条证书',
          config: {
            try: {
              nodes: [
                {
                  id: `set_${key}`,
                  type: 'update_record',
                  label: `置为 ${status}`,
                  config: { objectName: 'srm_supplier_certificate', filter: { id: cel`cert.id` }, fields: { status } },
                },
              ],
            },
            catch: { nodes: [{ id: `skip_${key}`, type: 'assignment', label: '跳过该条' }] },
          },
        },
      ],
    },
  },
});

// P10 到期生效与到期提醒（03 §11）：每日追赶式扫描，按有效期把证书状态对齐到
// 已过期 / 即将到期（30 天内）/ 有效。只处理状态与日期不符的证书，重复运行不重复处理（03 §2.3 R2）；
// 有效期被延长的证书也在这里恢复为有效。供应商的资质异常标志由 srm_supplier_qualification_recalc 维护。
export const CertificateSweepFlow: Automation.Flow = {
  name: 'srm_certificate_expire_sweep',
  label: '证书到期扫描',
  type: 'schedule',
  status: 'active',
  runAs: 'system',

  nodes: [
    { id: 'start', type: 'start', label: '每日 01:00', config: { schedule: '0 1 * * *' } },
    {
      id: 'find_expired',
      type: 'get_record',
      label: '已过期但未标记',
      config: {
        objectName: 'srm_supplier_certificate',
        filter: { status: { $ne: 'expired' }, valid_to: { $lt: cel`isoDate(today())` } },
        limit: 500,
        outputVariable: 'expiredList',
      },
    },
    eachCertificate('expired', cel`expiredList`, 'expired'),
    {
      id: 'find_expiring',
      type: 'get_record',
      label: '30 天内到期但未标记',
      config: {
        objectName: 'srm_supplier_certificate',
        filter: {
          status: { $ne: 'expiring' },
          valid_to: { $gte: cel`isoDate(today())`, $lte: cel`isoDate(addDays(today(), 30))` },
        },
        limit: 500,
        outputVariable: 'expiringList',
      },
    },
    eachCertificate('expiring', cel`expiringList`, 'expiring'),
    {
      id: 'find_renewed',
      type: 'get_record',
      label: '有效期已延长',
      config: {
        objectName: 'srm_supplier_certificate',
        filter: { status: { $ne: 'valid' }, valid_to: { $gt: cel`isoDate(addDays(today(), 30))` } },
        limit: 500,
        outputVariable: 'renewedList',
      },
    },
    eachCertificate('renewed', cel`renewedList`, 'valid'),
    { id: 'end', type: 'end', label: '结束' },
  ],

  edges: [
    { id: 'e1', source: 'start', target: 'find_expired', type: 'default' },
    { id: 'e2', source: 'find_expired', target: 'each_expired', type: 'default' },
    { id: 'e3', source: 'each_expired', target: 'find_expiring', type: 'default' },
    { id: 'e4', source: 'find_expiring', target: 'each_expiring', type: 'default' },
    { id: 'e5', source: 'each_expiring', target: 'find_renewed', type: 'default' },
    { id: 'e6', source: 'find_renewed', target: 'each_renewed', type: 'default' },
    { id: 'e7', source: 'each_renewed', target: 'end', type: 'default' },
  ],
};
