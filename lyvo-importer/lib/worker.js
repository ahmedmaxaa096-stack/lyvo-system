/* ============================================================
 * مشغّل المعالجة: لكل صف في المشروع
 *   البحث → جلب التفاصيل → تنزيل الصور → حفظ التقدم فورًا
 * يدعم الإيقاف، ولا يعيد معالجة المكتمل، ويحفظ SKU ثابت
 * ============================================================ */

const { searchProduct, fetchProductDetails } = require("./searcher");
const { saveRowImages } = require("./images");
const { saveProject, addLog } = require("./state");
const { extractAttributes } = require("./normalize");

const CONCURRENCY = 3;

/** حالة المعالجة الحية (للقراءة من الواجهة بين الحين والآخر) */
const live = {
  active: false,
  cancelRequested: false,
  total: 0,
  done: 0,
  matched: 0,
  review: 0,
  notFound: 0,
  failed: 0,
  currentName: "",
  startedAt: null,
  finishedAt: null,
  lastError: null,
};

async function processOne(state, row, referer) {
  row.status = "processing";
  row.error = "";
  // 1) البحث
  const found = await searchProduct(state, row.original_name);
  row.candidates = found.candidates || [];
  row.lastSearchNote = found.note || "";
  live.currentName = row.original_name;

  let details = null;
  if (found.status === "matched" && found.best) {
    try {
      details = await fetchProductDetails(found.best.url);
      // تحقق إضافي: مطابقة الصفات بين الاسم الأصلي واسم الصفحة
      const aO = extractAttributes(row.original_name);
      const aF = extractAttributes(details.product_name);
      let attrConflict = false;
      for (const k of ["size", "color", "model", "pack"]) {
        if (aO[k].length && aF[k].length) {
          for (const a of aO[k]) if (!aF[k].includes(a)) attrConflict = true;
        }
      }
      if (attrConflict) {
        row.status = "review";
        row.match_detail = "تعارض في صفات (حجم/لون/موديل) بين الاسم الأصلي وصفحة المنتج";
      } else {
        applyDetails(row, details, found); // status = matched لاحقًا
      }
    } catch (e) {
      row.status = "fetch_failed";
      row.error = e.message;
      row.found_url = found.best.url;
    }
  } else {
    // يحتاج مراجعة أو غير موجود — نعرض الخيارات
    row.status = found.status;
    if (found.status === "review" && found.best) {
      row.found_url = found.best.url;
    }
    row.match_detail = found.note;
  }

  if (row.status === "fetch_failed") {
    row.match_detail = "تعذر الجلب — أضف الرابط يدويًا أو أعد المحاولة";
  }

  // 2) تنزيل الصورة إن كان لدينا تطابق كامل
  if (row.status === "matched" && row.image_url) {
    try {
      row.writeSku = state.writeSkuOnImage !== false; // نسخة مكتوب عليها SKU حسب الإعداد
      const originalSave = await saveRowImages(row, referer);
      row.image_filename = originalSave.image_filename;
      row.image_labeled_file = originalSave.image_labeled_file;
    } catch (e) {
      row.status = "fetch_failed";
      row.error = (row.error ? row.error + " | " : "") + "فشل تنزيل الصورة: " + e.message;
    }
  }

  row.reviewed = false;
  return row;
}

/** نسخ بيانات الصفحة إلى الصف */
function applyDetails(row, details, found) {
  row.product_name = details.product_name || row.original_name;
  row.price = details.price;
  row.currency = details.currency;
  row.description = details.description || "";
  row.image_url = details.image_url_high || details.image_url || "";
  row.product_url = details.product_url || (found.best && found.best.url) || "";
  row.status = "matched";
  row.match_score = found.best ? found.best.score : null;
  row.match_detail = found.note || `تطابق ${found.best ? Math.round(found.best.score * 100) : 0}%`;
}

/** بدء المعالجة الكاملة */
async function startProcessing(state) {
  return new Promise((resolve) => {
    live.active = true;
    live.cancelRequested = false;
    live.total = state.rows.length;
    live.done = 0;
    live.matched = 0;
    live.review = 0;
    live.notFound = 0;
    live.failed = 0;
    live.startedAt = new Date().toISOString();
    live.finishedAt = null;
    live.currentName = "";
    live.lastError = null;

    addLog(state, `بدء المعالجة: ${state.rows.length} منتج`, "info");

    const queue = state.rows
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => !(row.status === "matched" && row.image_filename));

    let next = 0;
    const origin = (() => { try { return new URL(state.siteUrl).origin; } catch { return ""; } })();

    async function worker() {
      while (!live.cancelRequested && next < queue.length) {
        const { row, index } = queue[next++];
        state.processing.index = index;
        row.phase = "processing";
        saveProject(state);
        try {
          await processOne(state, row, origin);
          if (row.status === "matched") live.matched++;
          else if (row.status === "review") live.review++;
          else if (row.status === "not_found") live.notFound++;
          else live.failed++;
          row.phase = "idle";
          addLog(state, `${row.original_name} → ${row.status}`, row.status === "matched" ? "info" : "warn");
        } catch (e) {
          row.phase = "idle";
          row.status = "fetch_failed";
          row.error = e.message;
          live.failed++;
          addLog(state, `${row.original_name} → خطأ: ${e.message}`, "error");
        }
        live.done = next;
        state.processing.index = next;
        saveProject(state);
      }
    }

    const workers = Array.from({ length: Math.min(CONCURRENCY, Math.max(1, queue.length)) }, worker);
    Promise.all(workers).then(() => {
      live.active = false;
      live.finishedAt = new Date().toISOString();
      state.processing.active = false;
      if (live.cancelRequested) addLog(state, "تم إيقاف المعالجة بناءً على طلبك", "warn");
      else addLog(state, "اكتملت المعالجة", "info");
      saveProject(state);
      resolve({ ...live });
    });
  });
}

function cancelProcessing() {
  live.cancelRequested = true;
}

function status() {
  return { ...live };
}

module.exports = { startProcessing, cancelProcessing, status, processOne, live };