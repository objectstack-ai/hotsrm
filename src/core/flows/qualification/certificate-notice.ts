import type * as Automation from '@objectstack/spec/automation';
import { byAnyFunction, loadRoster, loadVendor, notifySupplier, pathOf, vendorName } from '../portal/supplier-notice.js';

// 证书到期提醒和过期通知共用的节点（05 §5「证书即将到期 / 已过期」，03 §11）：内部发给该供应商各品类的 SQE（品类都没有
// SQE 时发质量经理，与 srm_certificate_change_check 同一取法），供应商侧发名册上的主账号与质量联系人。
const c = (source: string) => ({ dialect: 'cel' as const, source });
const SOURCE = 'srm_supplier_certificate';

export const certificateNoticeNodes = (opts: { template: string; title: string; message: string; severity: 'info' | 'warning' }): Automation.FlowNode[] => [
  {
    id: 'load_grants',
    type: 'get_record',
    label: '读取品类资格',
    config: { objectName: 'srm_supplier_category', filter: { supplier: c('record.supplier') }, fields: ['category'], limit: 500, outputVariable: 'grants' },
  },
  {
    id: 'load_categories',
    type: 'get_record',
    label: '读取品类的 SQE',
    config: { objectName: 'srm_category', filter: { id: { $in: c('grants.map(g, g.category)') } }, fields: ['sqe'], limit: 500, outputVariable: 'categories' },
  },
  {
    id: 'load_quality_managers',
    type: 'get_record',
    label: '读取质量经理',
    config: { objectName: 'sys_user_position', filter: { position: 'srm_quality_manager' }, limit: 50, outputVariable: 'qualityManagers' },
  },
  loadRoster('record.supplier'),
  loadVendor('record.supplier'),
  {
    id: 'notify_sqe_guard',
    type: 'try_catch',
    label: '通知 SQE',
    config: {
      try: {
        nodes: [
          {
            id: 'notify_sqe',
            type: 'notify',
            label: '通知 SQE（品类没有 SQE 时通知质量经理）',
            config: {
              recipients: c(
                `categories.exists(x, has(x.sqe) && x.sqe != null)`
                  + ` ? categories.filter(x, has(x.sqe) && x.sqe != null).map(x, x.sqe)`
                  + ` : qualityManagers.map(p, p.user_id)`,
              ),
              title: opts.title,
              message: opts.message,
              severity: opts.severity,
              sourceObject: SOURCE,
              sourceId: c('record.id'),
            },
          },
        ],
      },
      catch: { nodes: [{ id: 'notify_sqe_skip', type: 'assignment', label: '跳过通知' }] },
    },
  } as Automation.FlowNode,
  notifySupplier('notify_supplier', '通知供应商主账号与质量联系人', {
    recipients: byAnyFunction(['admin', 'quality']),
    template: opts.template,
    data: {
      supplier: vendorName,
      cert_no: `has(record.cert_no) && record.cert_no != null && record.cert_no != '' ? record.cert_no : '-'`,
      valid_to: `has(record.valid_to) && record.valid_to != null ? string(record.valid_to) : '-'`,
      path: pathOf(SOURCE, 'record.id'),
    },
    sourceObject: SOURCE,
    sourceId: 'record.id',
  }),
];

export const certificateNoticeEdges = (first: string): Automation.FlowEdge[] => {
  const chain = [first, 'load_grants', 'load_categories', 'load_quality_managers', 'load_roster', 'load_vendor', 'notify_sqe_guard', 'notify_supplier_guard', 'end'];
  return chain.slice(1).map((target, i) => ({ id: `e${i + 1}`, source: chain[i]!, target, type: 'default' as const }));
};
