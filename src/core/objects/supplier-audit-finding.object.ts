import { P } from '@objectstack/spec';
import { ObjectSchema, Field } from '@objectstack/spec/data';

// 审核问题项（02 §4.2，WI-01 6.5、6.6.3、6.7）：审核员在审核记录下逐条登记不符合项、观察项和否决项。
// 严重不符合项、否决项的条数汇总到审核记录，用来校验结论（WI-01 6.6.1）。不符合项经审核记录上的
// 「转整改单」（srm_audit_finding_to_scar）生成整改单并回填 quality_issue，转出后不再修改。
const converted = P`has(record.quality_issue) && record.quality_issue != null && !isBlank(record.quality_issue)`;

export const SupplierAuditFinding = ObjectSchema.create({
  name: 'srm_supplier_audit_finding',
  label: '审核问题项',
  pluralLabel: '审核问题项',
  icon: 'list-checks',
  sharingModel: 'controlled_by_parent',
  nameField: 'title',

  fields: {
    audit: Field.masterDetail('srm_supplier_audit', {
      label: '供应商审核',
      required: true,
      deleteBehavior: 'cascade',
      relatedListColumns: ['title', 'severity', 'veto', 'description', 'requirement', 'quality_issue'],
    }),
    title: Field.text({ label: '问题项', required: true, maxLength: 200, readonlyWhen: converted }),
    description: Field.textarea({ label: '事实描述', maxLength: 2000, readonlyWhen: converted }),
    severity: Field.select({
      label: '严重度',
      required: true,
      defaultValue: 'general',
      readonlyWhen: converted,
      options: [
        { label: '严重不符合', value: 'serious' },
        { label: '一般不符合', value: 'general' },
        { label: '观察项', value: 'observation' },
      ],
    }),
    // 否决项（WI-01 6.6.3）：审核结论只能是「不通过」
    veto: Field.boolean({ label: '否决项', defaultValue: false, readonlyWhen: converted }),
    requirement: Field.textarea({ label: '整改要求', maxLength: 2000, readonlyWhen: converted }),
    quality_issue: Field.lookup('srm_quality_issue', { label: '整改单', readonly: true }),
  },
});
