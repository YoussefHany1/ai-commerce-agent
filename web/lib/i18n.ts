export type Locale = 'en' | 'ar';

export interface LocaleDict {
  [key: string]: string;
}

const en: LocaleDict = {
  appName: 'AI Commerce Agent',
  navOverview: 'Overview',
  navAnalytics: 'Analytics',
  navStores: 'Stores',
  navAutomation: 'Automation',
  navBilling: 'Billing',
  navSettings: 'Settings',
  navSectionMain: 'Workspace',
  navSectionManage: 'Manage',
  headingOverview: '',
  mIpsum: '',
};

const ar: LocaleDict = {
  appName: 'وكيل التجارة الذكي',
  navOverview: 'نظرة عامة',
  navAnalytics: 'التحليلات',
  navStores: 'المتاجر',
  navAutomation: 'الأتمتة',
  navBilling: 'الفواتير',
  navSettings: 'الإعدادات',
  navSectionMain: 'مساحة العمل',
  navSectionManage: 'الإدارة',
};

const dict: Record<Locale, LocaleDict> = { en, ar };

export function makeTranslator(locale: Locale) {
  return (key: string, fallback?: string): string => {
    const value = dict[locale][key];
    if (value && value.trim() !== '') return value;
    return fallback ?? dict.en[key] ?? key;
  };
}

export type Translator = ReturnType<typeof makeTranslator>;