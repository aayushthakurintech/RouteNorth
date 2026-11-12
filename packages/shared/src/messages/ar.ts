/**
 * Arabic (right-to-left). Covers sign-in, main navigation and the driver app so the right-to-left layout can be
 * used and checked. Drafted without a native reviewer. Missing keys fall back to English.
 */
export const ar: Record<string, string> = {
  appName: "RouteNorth",
  signIn: "تسجيل الدخول", signOut: "تسجيل الخروج", email: "البريد الإلكتروني", password: "كلمة المرور", language: "اللغة",
  driverToday: "مسار اليوم", noRouteToday: "لا يوجد مسار مخصص لك اليوم.",
  nextStop: "المحطة التالية", navigate: "التنقل", googleMaps: "خرائط جوجل", appleMaps: "خرائط أبل", waze: "ويز",
  imHere: "لقد وصلت", completeStop: "إتمام التسليم", cantDeliver: "تعذر التسليم", skipStop: "تخطي المحطة",
  takePhoto: "التقاط صورة", retakePhoto: "إعادة الالتقاط", signature: "التوقيع", clearSignature: "مسح التوقيع",
  receivedBy: "استلمها", notes: "ملاحظات", reason: "السبب", confirm: "تأكيد", closeSheet: "إغلاق",
  reason_nobody: "لا أحد في المنزل", reason_refused: "رفض الاستلام", reason_address: "عنوان خاطئ أو ناقص", reason_closed: "مغلق", reason_other: "أخرى",
  offline: "غير متصل", online: "متصل", pendingSync: "في انتظار المزامنة", syncNow: "زامن الآن",
  navLive: "الخريطة المباشرة", navRoutes: "المسارات", navReports: "التقارير", navSettings: "الإعدادات",
  loading: "جارٍ التحميل…", retry: "حاول مرة أخرى", save: "حفظ", cancel: "إلغاء",
  status_pending: "قيد الانتظار", status_arrived: "وصل", status_done: "تم", status_failed: "فشل", status_skipped: "تم التخطي",
};
