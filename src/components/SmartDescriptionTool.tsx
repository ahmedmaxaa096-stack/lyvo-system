import { useRef, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  FileSpreadsheet,
  Key,
  Loader2,
  Sparkles,
  Upload,
} from "lucide-react";
import ExcelJS from "exceljs";

type HeaderInfo = {
  rowNumber: number;
  columns: { index: number; label: string }[];
  nameColumn: number | null;
  englishDescriptionColumn: number;
  arabicDescriptionColumn: number;
};

const normalizeHeader = (value: string) =>
  value.trim().toLowerCase().replace(/[\s_-]+/g, "");

const getCellText = (value: ExcelJS.CellValue): string => {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if ("text" in value && typeof value.text === "string") return value.text;
  if ("richText" in value) return value.richText.map((part) => part.text).join("");
  if ("result" in value) return getCellText(value.result);
  return "";
};

const getHeaderInfo = (worksheet: ExcelJS.Worksheet): HeaderInfo | null => {
  for (let rowNumber = 1; rowNumber <= worksheet.rowCount; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    const columns: HeaderInfo["columns"] = [];
    row.eachCell({ includeEmpty: false }, (cell, columnNumber) => {
      const label = getCellText(cell.value).trim();
      if (label) columns.push({ index: columnNumber, label });
    });

    const findColumn = (aliases: string[]) =>
      columns.find((column) => aliases.includes(normalizeHeader(column.label)))?.index ?? null;
    const englishDescriptionColumn = findColumn(["descriptionen"]);
    const arabicDescriptionColumn = findColumn(["descriptionar"]);
    if (englishDescriptionColumn === null || arabicDescriptionColumn === null) continue;

    return {
      rowNumber,
      columns,
      nameColumn: findColumn([
        "productname",
        "name",
        "title",
        "producttitle",
        "itemname",
        "itemtitle",
        "product",
      ]),
      englishDescriptionColumn,
      arabicDescriptionColumn,
    };
  }
  return null;
};

const parseDescriptions = (content: string) => {
  const cleaned = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const result = JSON.parse(cleaned) as {
    description_en?: unknown;
    description_ar?: unknown;
  };
  if (
    typeof result.description_en !== "string" ||
    typeof result.description_ar !== "string" ||
    !result.description_en.trim() ||
    !result.description_ar.trim()
  ) {
    throw new Error("لم يُرجع OpenAI وصفًا عربيًا وإنجليزيًا صالحًا.");
  }
  return {
    description_en: result.description_en.trim(),
    description_ar: result.description_ar.trim(),
  };
};

export default function SmartDescriptionTool() {
  const fileRef = useRef<HTMLInputElement>(null);
  const workbookRef = useRef<ExcelJS.Workbook | null>(null);
  const [sheetFileName, setSheetFileName] = useState("");
  const [worksheetNames, setWorksheetNames] = useState<string[]>([]);
  const [selectedWorksheet, setSelectedWorksheet] = useState("");
  const [headerInfo, setHeaderInfo] = useState<HeaderInfo | null>(null);
  const [nameColumn, setNameColumn] = useState<number | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState("");
  const [resultFile, setResultFile] = useState<Blob | null>(null);

  const effectiveNameColumn = nameColumn ?? headerInfo?.nameColumn ?? null;
  const nameColumnOptions = headerInfo ? [...headerInfo.columns] : [];
  if (headerInfo && !nameColumnOptions.some((column) => column.index === 3)) {
    nameColumnOptions.push({ index: 3, label: "اسم المنتج الإنجليزي (C)" });
  }
  if (headerInfo && !nameColumnOptions.some((column) => column.index === 4)) {
    nameColumnOptions.push({ index: 4, label: "اسم المنتج العربي (D)" });
  }

  const handleUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setBusy(true);
    setError(null);
    setSuccess("");
    setResultFile(null);
    try {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(await file.arrayBuffer());
      if (workbook.worksheets.length === 0) {
        throw new Error("ملف Excel لا يحتوي على أوراق عمل.");
      }

      workbookRef.current = workbook;
      const worksheets = workbook.worksheets.map((sheet) => ({
        sheet,
        header: getHeaderInfo(sheet),
      }));
      const detectedWorksheet = worksheets.find(({ header }) => header !== null) ?? {
        sheet: workbook.worksheets[0],
        header: null,
      };

      setWorksheetNames(workbook.worksheets.map((sheet) => sheet.name));
      setSelectedWorksheet(detectedWorksheet.sheet.name);
      setHeaderInfo(detectedWorksheet.header);
      setNameColumn(detectedWorksheet.header?.nameColumn ?? null);
      setSheetFileName(file.name);
    } catch (uploadError) {
      workbookRef.current = null;
      setWorksheetNames([]);
      setSelectedWorksheet("");
      setHeaderInfo(null);
      setNameColumn(null);
      setSheetFileName("");
      setError(`فشل قراءة الشيت: ${uploadError instanceof Error ? uploadError.message : String(uploadError)}`);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const handleWorksheetChange = (worksheetName: string) => {
    setSelectedWorksheet(worksheetName);
    const worksheet = workbookRef.current?.getWorksheet(worksheetName);
    const nextHeaderInfo = worksheet ? getHeaderInfo(worksheet) : null;
    setHeaderInfo(nextHeaderInfo);
    setNameColumn(nextHeaderInfo?.nameColumn ?? null);
    setError(null);
    setSuccess("");
    setResultFile(null);
  };

  const handleGenerate = async () => {
    const worksheet = workbookRef.current?.getWorksheet(selectedWorksheet);
    const currentHeaderInfo = worksheet ? getHeaderInfo(worksheet) : null;
    const productColumn = nameColumn ?? currentHeaderInfo?.nameColumn ?? null;

    if (!apiKey.trim()) {
      setError("أدخل مفتاح OpenAI API أولًا.");
      return;
    }
    if (!worksheet || !currentHeaderInfo) {
      setError("لم يتم العثور على العناوين description_en و description_ar في الشيت المحدد.");
      return;
    }
    if (productColumn === null) {
      setError("اختر عمود اسم المنتج.");
      return;
    }

    const products: { rowNumber: number; name: string }[] = [];
    for (
      let rowNumber = currentHeaderInfo.rowNumber + 1;
      rowNumber <= worksheet.rowCount;
      rowNumber += 1
    ) {
      const row = worksheet.getRow(rowNumber);
      const name = [productColumn, 3, 4]
        .filter((column, index, columns) => columns.indexOf(column) === index)
        .map((column) => getCellText(row.getCell(column).value).trim())
        .find(Boolean);
      if (name) products.push({ rowNumber, name });
    }
    if (products.length === 0) {
      setError("لم يتم العثور على أسماء منتجات أسفل صف العناوين.");
      return;
    }

    setBusy(true);
    setError(null);
    setSuccess("");
    setResultFile(null);
    setProgress({ current: 0, total: products.length });

    try {
      const generated: {
        rowNumber: number;
        description_en: string;
        description_ar: string;
      }[] = [];

      for (let index = 0; index < products.length; index += 1) {
        const product = products[index];
        setProgress({ current: index + 1, total: products.length });

        const response = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey.trim()}`,
          },
          body: JSON.stringify({
            model: "gpt-4o-mini",
            messages: [
              {
                role: "system",
                content:
                  "Write concise, useful product descriptions in English and Arabic. Use only facts supported by the product name; do not invent specifications, materials, compatibility, or features. Return only JSON with exactly description_en and description_ar, each one or two short sentences.",
              },
              { role: "user", content: `Product name: ${product.name}` },
            ],
            temperature: 0.4,
          }),
        });

        if (!response.ok) {
          throw new Error(`OpenAI (${response.status}) عند الصف ${product.rowNumber}: ${await response.text()}`);
        }

        const payload = (await response.json()) as {
          choices?: { message?: { content?: string | null } }[];
        };
        const content = payload.choices?.[0]?.message?.content;
        if (!content) throw new Error(`لم يُرجع OpenAI نتيجة للصف ${product.rowNumber}.`);
        generated.push({ rowNumber: product.rowNumber, ...parseDescriptions(content) });
      }

      for (const description of generated) {
        const row = worksheet.getRow(description.rowNumber);
        row.getCell(currentHeaderInfo.englishDescriptionColumn).value = description.description_en;
        row.getCell(currentHeaderInfo.arabicDescriptionColumn).value = description.description_ar;
      }

      const workbook = workbookRef.current;
      if (!workbook) throw new Error("ملف الشيت غير متاح، ارفعه مرة أخرى.");
      const output = await workbook.xlsx.writeBuffer();
      setResultFile(
        new Blob([output], {
          type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        }),
      );
      setSuccess(`تم إنشاء الوصف العربي والإنجليزي لـ ${generated.length} منتج.`);
    } catch (generationError) {
      setError(`فشل توليد الأوصاف: ${generationError instanceof Error ? generationError.message : String(generationError)}`);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  const downloadResult = () => {
    if (!resultFile) return;
    const url = URL.createObjectURL(resultFile);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = sheetFileName.toLowerCase().endsWith(".xlsx")
      ? sheetFileName.replace(/\.xlsx$/i, "-with-descriptions.xlsx")
      : "products-with-descriptions.xlsx";
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <section className="card-3d p-6 mb-6">
      <div className="flex items-center gap-2 mb-1">
        <div className="w-9 h-9 bg-gradient-to-br from-violet-500 to-indigo-600 rounded-xl flex items-center justify-center shadow-md shadow-indigo-500/30">
          <Sparkles className="w-5 h-5 text-white" />
        </div>
        <h2 className="text-lg font-bold text-slate-900">توليد أوصاف المنتجات بالذكاء الاصطناعي</h2>
      </div>
      <p className="text-sm text-slate-500 mb-5">
        ارفع ملف Excel، وسيتم تحديد عمودي description_en و description_ar تلقائيًا، ثم إنشاء وصفين مختصرين من اسم كل منتج مع الحفاظ على بقية الشيت.
      </p>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <div>
          <label className="flex items-center gap-2 text-sm font-semibold text-slate-700 mb-2">
            <Key className="w-4 h-4 text-amber-600" />
            مفتاح OpenAI API
          </label>
          <input
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder="sk-..."
            className="input-3d"
            dir="ltr"
            autoComplete="off"
          />
          <p className="text-xs text-slate-400 mt-1.5">يُستخدم المفتاح لإرسال الطلبات إلى OpenAI ولا يتم حفظه في الشيت.</p>
        </div>

        <div>
          <label className="flex items-center gap-2 text-sm font-semibold text-slate-700 mb-2">
            <FileSpreadsheet className="w-4 h-4 text-green-600" />
            ملف المنتجات (.xlsx)
          </label>
          <input ref={fileRef} type="file" accept=".xlsx" onChange={handleUpload} className="hidden" />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={busy}
            className="upload-zone-3d w-full min-h-24 flex items-center justify-center gap-3 px-4 text-slate-500 disabled:opacity-50"
          >
            {busy && !progress ? <Loader2 className="w-6 h-6 animate-spin" /> : <Upload className="w-6 h-6" />}
            <span className="text-sm font-medium">{sheetFileName || "اضغط لرفع ملف Excel"}</span>
          </button>
        </div>
      </div>

      {worksheetNames.length > 1 && (
        <div className="mt-4">
          <label className="block text-sm font-semibold text-slate-700 mb-2">ورقة العمل</label>
          <select
            value={selectedWorksheet}
            onChange={(event) => handleWorksheetChange(event.target.value)}
            className="input-3d"
            disabled={busy}
          >
            {worksheetNames.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </div>
      )}

      {sheetFileName && (
        <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
          {!headerInfo ? (
            <p className="text-sm text-red-600">لم يتم العثور على description_en و description_ar في صفوف العناوين.</p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
              <div className="rounded-lg bg-white p-3">
                <span className="text-slate-500">صف العناوين</span>
                <p className="font-semibold text-slate-800">{headerInfo.rowNumber}</p>
              </div>
              <div className="rounded-lg bg-white p-3">
                <span className="text-slate-500">الوصف الإنجليزي</span>
                <p className="font-semibold text-slate-800">عمود {headerInfo.englishDescriptionColumn}</p>
              </div>
              <div className="rounded-lg bg-white p-3">
                <span className="text-slate-500">الوصف العربي</span>
                <p className="font-semibold text-slate-800">عمود {headerInfo.arabicDescriptionColumn}</p>
              </div>
              <div className="sm:col-span-3">
                <label className="block text-sm font-semibold text-slate-700 mb-2">عمود اسم المنتج</label>
                <select
                  value={effectiveNameColumn ?? ""}
                  onChange={(event) => setNameColumn(event.target.value ? Number(event.target.value) : null)}
                  className="input-3d"
                  disabled={busy}
                >
                  <option value="">اختر العمود</option>
                  {nameColumnOptions.map((column) => (
                    <option key={column.index} value={column.index}>
                      {column.label} (عمود {column.index})
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}
        </div>
      )}

      {progress && (
        <div className="mt-4 rounded-xl border border-indigo-200 bg-indigo-50 p-4">
          <div className="mb-2 flex items-center justify-between text-sm text-indigo-800">
            <span className="flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" />جارٍ توليد الأوصاف...</span>
            <span>{progress.current} / {progress.total}</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-indigo-100">
            <div
              className="h-full rounded-full bg-indigo-600 transition-all"
              style={{ width: `${(progress.current / progress.total) * 100}%` }}
            />
          </div>
        </div>
      )}

      {error && (
        <div className="mt-4 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {success && (
        <div className="mt-4 flex items-center gap-2 rounded-xl border border-green-200 bg-green-50 p-3 text-sm text-green-700">
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          <span>{success}</span>
        </div>
      )}

      <div className="mt-5 flex flex-wrap gap-3">
        <button
          type="button"
          onClick={handleGenerate}
          disabled={busy || !sheetFileName || !headerInfo || effectiveNameColumn === null}
          className="btn-3d flex items-center justify-center gap-2 bg-gradient-to-r from-violet-600 to-indigo-600 px-5 py-3"
        >
          {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : <Sparkles className="h-5 w-5" />}
          إنشاء الأوصاف
        </button>
        {resultFile && (
          <button
            type="button"
            onClick={downloadResult}
            className="btn-3d flex items-center justify-center gap-2 bg-gradient-to-r from-emerald-600 to-green-600 px-5 py-3"
          >
            <FileSpreadsheet className="h-5 w-5" />
            تنزيل الشيت بعد التعديل
          </button>
        )}
      </div>
    </section>
  );
}
