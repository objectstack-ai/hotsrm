import { definePicklist } from '@objectstack/spec/data';

// 资质类型：证书的 cert_type 与品类的 mandatory_cert_types 共用；扩展包按需追加（02 §1）。
export const CertTypePicklist = definePicklist({
  name: 'srm_cert_type',
  label: '资质类型',
  options: [
    { label: '营业执照', value: 'business_license' },
    { label: 'ISO 9001', value: 'iso9001' },
    { label: 'IATF 16949', value: 'iatf16949' },
    { label: 'ISO 14001', value: 'iso14001' },
    { label: 'ISO 45001', value: 'iso45001' },
    { label: '生产许可', value: 'production_license' },
    { label: '3C 认证', value: 'ccc' },
    { label: '其他', value: 'other' },
  ],
});
