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
  navClients: 'Clients',
  navSectionMain: 'Workspace',
  navSectionManage: 'Manage',
  navSectionAdmin: 'Admin',
  headingOverview: '',
  mIpsum: '',
  authGoogle: 'Continue with Google',
  authForgotPassword: 'Forgot password?',
  authCreateAccount: 'Create an account',
  authHaveAccount: 'Have an account? Sign in',
  registerTitle: 'Create your account',
  registerSubtitle: 'Invited merchants activate their account here.',
  registerSubmit: 'Create account',
  registerCheckEmail: 'Check your email for the confirmation link, then sign in.',
  forgotTitle: 'Reset your password',
  forgotSubtitle: 'If an account exists for that email, we will send a reset link.',
  forgotSubmit: 'Send reset link',
  forgotSent: 'If an account exists for that email, a reset link is on its way.',
  resetTitle: 'Choose a new password',
  resetSubtitle: 'Finish the reset from your email. Enter the token and your new password.',
  resetSubmit: 'Set new password',
  resetToken: 'Reset token',
  resetPasswordSet: 'Your password is set. Signing you in…',
  resetInvalidLink: 'This reset link is invalid or has expired. Request a new one.',
  authUnavailable: 'Sign-in is temporarily unavailable. Please try again shortly.',
  authGenericError: 'Something went wrong. Please try again.',
};

const ar: LocaleDict = {
  appName: 'وكيل التجارة الذكي',
  navOverview: 'نظرة عامة',
  navAnalytics: 'التحليلات',
  navStores: 'المتاجر',
  navAutomation: 'الأتمتة',
  navBilling: 'الفواتير',
  navSettings: 'الإعدادات',
  navClients: 'العملاء',
  navSectionMain: 'مساحة العمل',
  navSectionManage: 'الإدارة',
  navSectionAdmin: 'الإدارة العامة',
  authGoogle: 'المتابعة عبر Google',
  authForgotPassword: 'نسيت كلمة المرور؟',
  authCreateAccount: 'إنشاء حساب',
  authHaveAccount: 'لديك حساب؟ سجّل الدخول',
  registerTitle: 'إنشاء حسابك',
  registerSubtitle: 'يحتفّع التجار المدعوون بحساباتهم هنا.',
  registerSubmit: 'إنشاء الحساب',
  registerCheckEmail: 'تحقق من بريدك الإلكتروني لتفعيل الحساب ثم سجّل الدخول.',
  forgotTitle: 'إعادة تعيين كلمة المرور',
  forgotSubtitle: 'إذا كان الحساب موجوداً فسنرسل رابط إعادة التعيين.',
  forgotSubmit: 'إرسال رابط إعادة التعيين',
  forgotSent: 'إذا كان الحساب موجوداً فستصلك رسالة إعادة التعيين.',
  resetTitle: 'اختر كلمة مرور جديدة',
  resetSubtitle: 'أكمل إعادة التعيين من بريدك: أدخل الرمز وكلمة المرور الجديدة.',
  resetSubmit: 'تعيين كلمة المرور',
  resetToken: 'رمز إعادة التعيين',
  resetPasswordSet: 'تم تعيين كلمة المرور. جارٍ تسجيل الدخول…',
  resetInvalidLink: 'رابط إعادة التعيين غير صالح أو منتهي الصلاحية. اطلب رابطاً جديداً.',
  authUnavailable: 'تسجيل الدخول غير متاح مؤقتاً. حاول مرة أخرى لاحقاً.',
  authGenericError: 'حدث خطأ ما. حاول مرة أخرى.',
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