import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, Type } from "@google/genai";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();

// Shared Gemini api helper initialized on the server
// User-Agent must be set to 'aistudio-build' for telemetry tracking
const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  httpOptions: {
    headers: {
      "User-Agent": "aistudio-build"
    }
  }
});

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Use JSON parsing with size limits to accommodate image uploads (base64)
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));

  // API endpoint: health and configuration check
  app.get("/api/health", (req, res) => {
    res.json({
      status: "ok",
      timestamp: new Date().toISOString(),
      hasApiKey: !!process.env.GEMINI_API_KEY
    });
  });

  // Persistent server storage configuration
  const SAVED_WORKSPACE_PATH = path.join(process.cwd(), "src", "data", "saved_workspace.json");

  // API endpoint: Save active workspace datasets
  app.post("/api/save-workspace", (req, res) => {
    try {
      const { statementData, selectedModule, activeTab, editedProcessedRows } = req.body;
      const dataToSave = {
        statementData: statementData || null,
        selectedModule: selectedModule || "fin_extract",
        activeTab: activeTab || "ledger",
        editedProcessedRows: editedProcessedRows || {},
        savedAt: new Date().toISOString()
      };
      
      const dir = path.dirname(SAVED_WORKSPACE_PATH);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      fs.writeFileSync(SAVED_WORKSPACE_PATH, JSON.stringify(dataToSave, null, 2), "utf-8");
      res.json({ success: true, savedAt: dataToSave.savedAt });
    } catch (err: any) {
      console.error("Failed to write workspace backup:", err);
      res.status(500).json({ error: err.message || "Failed to persist workspace data" });
    }
  });

  // API endpoint: Load active workspace datasets
  app.get("/api/load-workspace", (req, res) => {
    try {
      if (fs.existsSync(SAVED_WORKSPACE_PATH)) {
        const fileContent = fs.readFileSync(SAVED_WORKSPACE_PATH, "utf-8");
        const data = JSON.parse(fileContent);
        res.json({ success: true, data });
      } else {
        res.json({ success: false, message: "No saved workspace backup found on server." });
      }
    } catch (err: any) {
      console.error("Failed to read workspace backup:", err);
      res.status(500).json({ error: err.message || "Failed to load workspace data" });
    }
  });

  // API endpoint: Process uploaded statement files (Image, PDF, or Text) via Gemini
  app.post("/api/process-ocr", async (req, res) => {
    try {
      const { fileData, fileType, textData } = req.body;
      if (!fileData && !textData) {
        res.status(400).json({ error: "Missing file data or text content data" });
        return;
      }

      if (!process.env.GEMINI_API_KEY) {
        res.status(500).json({ 
          error: "GEMINI_API_KEY is not configured in the host environment. Please add it to your secrets panel." 
        });
        return;
      }

      let contentsInput: any;

      if (textData) {
        const textPrompt = `You are an expert financial ledger extraction assistant.
Analyze this raw bank statement text content.
CRITICAL INSTRUCTIONS:
1. Ignore all general metadata at the top of the statement or page headers (such as bank name, branch address, statement date, account currency, customer ID, or summary blocks).
2. Locate the "Beginning Balance", "Opening Balance", "Balance Brought Forward", "B/F", or "Brought Forward" row if present in this segment.
3. Extract ONLY standard, active transaction rows that occur chronologically. Do NOT include any beginning balance row itself or meta lines.
4. Stop mapping once you reach summary totals or closing balance indicators.

For each valid transaction row, extract the following fields exactly:
1. postingDate -> Keep as raw text in standard DDMMMYY format (e.g. "03MAY26" or "10MAY26"). If only month/day are present, use that.
2. codeDescription (e.g. "WER 1300146139765C" or "OUTWARD EFT" or "TFR FITD60510H000002")
3. narrative1 (Primary details)
4. narrative2 (Supplementary line 2)
5. narrative3 (Supplementary line 3)
6. narrative4 (Supplementary line 4)
7. debitAmount (Debit/Dr amount if present, else empty "")
8. creditAmount (Credit/Cr amount if present, else empty "")

Apply extreme care with transaction tracking numbers embedded in descriptions or narratives (e.g., look for 14-character alphanumeric codes like 2113246144381B, or 16-character transfer codes).
Return the result strictly as a JSON array of objects fitting the schema configuration.

Here is the statement text segment:
${textData}`;

        contentsInput = {
          parts: [{ text: textPrompt }]
        };
      } else {
        // Convert standard browser MIME type to IANA standard or default
        const mimeType = fileType || "image/png";
        const base64Data = fileData.split(",")[1] || fileData;

        const filePart = {
          inlineData: {
            mimeType: mimeType,
            data: base64Data
          }
        };

        const imagePrompt = `You are an expert financial ledger extraction OCR assistant.
Analyze this raw bank statement document.
CRITICAL INSTRUCTIONS:
1. Ignore all general metadata at the top of the statement or page headers (such as bank name, branch address, statement date, account currency, customer ID, or summary blocks like total withdrawals/deposits).
2. Locate the "Beginning Balance", "Opening Balance", "Balance Brought Forward", "B/F", or "Brought Forward" row.
3. Extract ONLY standard, active transaction rows that occur chronologically AFTER that beginning/opening balance row. Do NOT include the beginning balance row itself or any meta lines above it.
4. Stop mapping once you reach summary totals or closing balance indicators.

For each valid transaction row, extract the following fields exactly:
1. postingDate (e.g. "03MAY26" or "10MAY26") -> Keep as raw text in standard DDMMMYY format.
2. codeDescription (e.g. "WER 1300146139765C" or "OUTWARD EFT" or "TFR FITD60510H000002")
3. narrative1 (Primary details)
4. narrative2 (Supplementary line 2)
5. narrative3 (Supplementary line 3)
6. narrative4 (Supplementary line 4)
7. debitAmount (Debit/Dr amount if present, else empty "")
8. creditAmount (Credit/Cr amount if present, else empty "")

Apply extreme care with transaction tracking numbers embedded in descriptions or narratives (e.g., look for 14-character alphanumeric codes like 2113246144381B, or 16-character transfer codes).
Return the result strictly as a JSON array of objects fitting the schema configuration.`;

        contentsInput = {
          parts: [filePart, { text: imagePrompt }]
        };
      }

      // Call Gemini 3.5 Flash for the OCR extraction task
      const response = await ai.models.generateContent({
        model: "gemini-3.5-flash",
        contents: contentsInput,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                postingDate: { type: Type.STRING, description: "The raw date value, e.g. '03MAY26'." },
                codeDescription: { type: Type.STRING, description: "Standard row code description." },
                narrative1: { type: Type.STRING },
                narrative2: { type: Type.STRING },
                narrative3: { type: Type.STRING },
                narrative4: { type: Type.STRING },
                debitAmount: { type: Type.STRING },
                creditAmount: { type: Type.STRING }
              },
              required: ["postingDate", "codeDescription"]
            }
          }
        }
      });

      const extractedText = response.text;
      if (!extractedText) {
        res.status(500).json({ error: "Gemini did not return any parseable content." });
        return;
      }

      const parsedJson = JSON.parse(extractedText.trim());
      res.json({ success: true, transactions: parsedJson });
    } catch (err: any) {
      console.error("Gemini OCR error:", err);
      res.status(500).json({ 
        error: err.message || "An error occurred while calling the Gemini API" 
      });
    }
  });

  // Integrate Vite for development, serve static client files in production
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa"
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Express server running on http://localhost:${PORT}`);
  });
}

startServer();
