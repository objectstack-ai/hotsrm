import { definePicklist } from '@objectstack/spec/data';

// 注册地国家 / 地区，ISO 3166-1 两位代码小写（ADR-0007）。先放常见值，按需追加。
export const CountryPicklist = definePicklist({
  name: 'srm_country',
  label: '国家 / 地区',
  options: [
    { label: '中国', value: 'cn' },
    { label: '中国香港', value: 'hk' },
    { label: '中国澳门', value: 'mo' },
    { label: '中国台湾', value: 'tw' },
    { label: '日本', value: 'jp' },
    { label: '韩国', value: 'kr' },
    { label: '新加坡', value: 'sg' },
    { label: '美国', value: 'us' },
    { label: '德国', value: 'de' },
    { label: '英国', value: 'gb' },
    { label: '法国', value: 'fr' },
  ],
});
