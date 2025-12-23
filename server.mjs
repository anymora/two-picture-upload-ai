// server.mjs

// ================== KONFIGURATION (OBEN) ==================

import dotenv from "dotenv";
dotenv.config();

// ---- OpenAI / KI ----
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "DEIN_OPENAI_API_KEY_HIER";

// Referenzbild & Mockup-Vorlage (LOKALE DATEIPFADE im Container)
const REFERENCE_IMAGE_PATH =
  process.env.REFERENCE_IMAGE_PATH || "./assets/reference.png";
const MOCKUP_TEMPLATE_PATH =
  process.env.MOCKUP_TEMPLATE_PATH || "./assets/mockup-template.png";

// Prompt / Beschreibung für die KI
const BASE_PROMPT =
  process.env.BASE_PROMPT ||
  "Nutze die BILDER WIE FOLGT: Bild 1 = Referenzbild des fertigen Trikot-Designs (Hund im Stadion, stehende ganze Figur). " +
    "Bild 2 = Foto des Hundes des Kunden (nur dieses Gesicht/Kopf verwenden). " +
    "Bild 3 = Foto des leeren Trikots des Kunden. Aufgabe: Erstelle ein neues, druckfertiges Fußballtrikot-Design im Stil von Bild 1. " +
    "Ersetze den Hund aus Bild 1 durch den Hund aus Bild 2, so dass der Hund vollständig von Kopf bis Pfoten im Bild zu sehen ist, " +
    "nicht abgeschnitten, mit ähnlicher Körperhaltung, Proportionen und Perspektive wie in Bild 1. Der Hund soll das Trikot aus Bild 3 tragen " +
    "(Farben, Streifen, Logos und Schnitt so genau wie möglich übernehmen). Der Bildausschnitt soll dem von Bild 1 sehr ähnlich sein: Hund zentral " +
    "im Vordergrund, Stadion mit Fans im Hintergrund. Schneide weder oben den Kopf noch unten die Pfoten ab. Kein Nahportrait, sondern die ganze Figur. " +
    "Der Hintergrund soll im Stil von Bild 1 sein (Fußballstadion mit Fans), aber ohne neue Motive, die vom Hund ablenken. " +
    "Liefere ein vollflächiges Trikot-Bild mit deckendem Hintergrund (kein Transparent), geeignet für Druck und Mockups.";

// ---- Mockup / Overlay ----
const USE_MOCKUP_TEMPLATE =
  process.env.USE_MOCKUP_TEMPLATE === "false" ? false : true;

const DESIGN_SCALE = parseFloat(process.env.DESIGN_SCALE || "0.6");
const DESIGN_POSITION_X = parseFloat(process.env.DESIGN_POSITION_X || "0.0");
const DESIGN_POSITION_Y = parseFloat(process.env.DESIGN_POSITION_Y || "-0.1");

// ---- Shopify ----
const SHOPIFY_STORE_DOMAIN =
  process.env.SHOPIFY_STORE_DOMAIN || "dein-shop.myshopify.com";
const SHOPIFY_ADMIN_ACCESS_TOKEN =
  process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || "shpat_XXX";
const ENABLE_SHOPIFY_PRODUCT_IMAGE_UPDATE =
  process.env.ENABLE_SHOPIFY_PRODUCT_IMAGE_UPDATE === "true";

// ---- Cloudflare R2 ----
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET_NAME =
  process.env.R2_BUCKET_NAME || "two-picture-upload-ai";
const R2_PUBLIC_BASE_URL = process.env.R2_PUBLIC_BASE_URL;

// ---- Generelles ----
const PORT = process.env.PORT || 3000;

// =========================================================

import express from "express";
import multer from "multer";
import sharp from "sharp";
import fs from "fs/promises";
import fetch from "node-fetch";
import FormData from "form-data";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

// Multer: Dateien im RAM
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10 MB
});

// ============== Cloudflare R2 Client ======================

if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
  console.warn(
    "[R2] Achtung: R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY nicht gesetzt. Uploads werden fehlschlagen."
  );
}

const r2Client = new S3Client({
  region: "auto",
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID || "",
    secretAccessKey: R2_SECRET_ACCESS_KEY || ""
  }
});

async function uploadBufferAndGetUrl(buffer, filename, mimeType = "image/png") {
  if (!R2_BUCKET_NAME) {
    throw new Error("R2_BUCKET_NAME ist nicht gesetzt.");
  }
  if (!R2_PUBLIC_BASE_URL) {
    throw new Error(
      "R2_PUBLIC_BASE_URL ist nicht gesetzt. Bitte öffentliche Basis-URL deines Buckets angeben."
    );
  }

  const key = filename;

  const putCommand = new PutObjectCommand({
    Bucket: R2_BUCKET_NAME,
    Key: key,
    Body: buffer,
    ContentType: mimeType
  });

  await r2Client.send(putCommand);

  const base = R2_PUBLIC_BASE_URL.replace(/\/$/, "");
  const publicUrl = `${base}/${encodeURIComponent(key)}`;
  return publicUrl;
}

// =========================================================
// Helpers: Remote Image Download + normalize to PNG

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

async function downloadImageAsPngBuffer(url, label = "remoteImage") {
  if (!isNonEmptyString(url)) {
    throw new Error(`[${label}] URL ist leer.`);
  }

  const u = url.trim();

  // Basic sanity: must be http(s)
  if (!/^https?:\/\//i.test(u)) {
    throw new Error(`[${label}] URL muss mit http/https starten: ${u}`);
  }

  // Timeout
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);

  let resp;
  try {
    resp = await fetch(u, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        // Manche CDNs geben sonst WebP/AVIF; Sharp kann das, aber wir normalisieren eh auf PNG.
        "User-Agent": "tib-backend/1.0",
        "Accept": "image/*,*/*;q=0.8"
      }
    });
  } catch (e) {
    clearTimeout(timeout);
    throw new Error(`[${label}] Fetch fehlgeschlagen: ${e?.message || String(e)}`);
  } finally {
    clearTimeout(timeout);
  }

  if (!resp.ok) {
    throw new Error(`[${label}] URL nicht ladbar (${resp.status}).`);
  }

  // Hard size guard (15MB)
  const cl = resp.headers.get("content-length");
  if (cl && Number(cl) > 15 * 1024 * 1024) {
    throw new Error(`[${label}] Bild zu groß (>15MB).`);
  }

  const arr = await resp.arrayBuffer();
  const raw = Buffer.from(arr);

  // Normalisieren auf PNG (damit OpenAI + Sharp sauber sind)
  try {
    const png = await sharp(raw).png().toBuffer();
    return png;
  } catch (e) {
    throw new Error(`[${label}] Bild konnte nicht dekodiert/konvertiert werden: ${e?.message || String(e)}`);
  }
}

// =========================================================
// OpenAI: Referenz + Hund + Trikot → Design

async function generateDesignWithOpenAI({
  dogBuffer,
  jerseyBuffer,
  promptOverride,
  referenceImageUrl
}) {
  if (!OPENAI_API_KEY || OPENAI_API_KEY === "DEIN_OPENAI_API_KEY_HIER") {
    throw new Error("OPENAI_API_KEY ist nicht gesetzt.");
  }

  let referenceBuffer;
  let referenceSource = "local";

  try {
    // Wenn URL gesetzt -> MUSS sie genommen werden, sonst hard fail (kein stiller Fallback!)
    if (isNonEmptyString(referenceImageUrl)) {
      referenceSource = "url";
      referenceBuffer = await downloadImageAsPngBuffer(referenceImageUrl, "referenceImageUrl");
    } else {
      referenceSource = "local";
      referenceBuffer = await fs.readFile(REFERENCE_IMAGE_PATH);
      // local auch auf PNG normalisieren (falls jemand JPG als reference.png reinlegt)
      referenceBuffer = await sharp(referenceBuffer).png().toBuffer();
    }
  } catch (err) {
    console.error("[REF] Fehler beim Laden Referenz:", err);
    // Wenn URL gesetzt war, wollen wir NICHT fallbacken -> klarer Fehler
    throw new Error(
      isNonEmptyString(referenceImageUrl)
        ? "Referenzbild-URL ist gesetzt, aber nicht nutzbar. Bitte URL prüfen."
        : "REFERENZBILD konnte nicht geladen werden. Pfad prüfen."
    );
  }

  const effectivePrompt =
    isNonEmptyString(promptOverride) ? promptOverride.trim() : BASE_PROMPT;

  console.log("[OpenAI] Reference source:", referenceSource, isNonEmptyString(referenceImageUrl) ? referenceImageUrl.trim() : "");

  const formData = new FormData();
  formData.append("model", "gpt-image-1");
  formData.append("prompt", effectivePrompt);

  // Reihenfolge wie im Prompt: 1 = Referenz, 2 = Hund, 3 = Trikot
  formData.append("image[]", referenceBuffer, {
    filename: "reference.png",
    contentType: "image/png"
  });

  // Hund/Trikot ebenfalls auf PNG normalisieren (stabiler)
  const dogPng = await sharp(dogBuffer).png().toBuffer();
  const jerseyPng = await sharp(jerseyBuffer).png().toBuffer();

  formData.append("image[]", dogPng, {
    filename: "dog.png",
    contentType: "image/png"
  });
  formData.append("image[]", jerseyPng, {
    filename: "jersey.png",
    contentType: "image/png"
  });

  formData.append("input_fidelity", "high");
  formData.append("quality", "high");
  formData.append("background", "opaque");
  formData.append("size", "1024x1536");
  formData.append("output_format", "png");
  formData.append("n", "1");

  const response = await fetch("https://api.openai.com/v1/images/edits", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: formData
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    console.error("OpenAI-Fehler:", response.status, text);
    throw new Error("OpenAI API Request fehlgeschlagen.");
  }

  const json = await response.json();
  const b64 = json?.data?.[0]?.b64_json;

  if (!b64) {
    console.error("OpenAI Antwort ohne b64_json:", JSON.stringify(json, null, 2));
    throw new Error("OpenAI hat kein Bild zurückgegeben.");
  }

  return Buffer.from(b64, "base64");
}

// =========================================================
// Mockup-Erstellung (LOKALE mockup-template.png oder Kunden-Trikot)

function resolveMockupTemplatePath(mockupType) {
  if (
    !mockupType ||
    String(mockupType).trim() === "" ||
    String(mockupType).toLowerCase() === "sweatshirt"
  ) {
    return MOCKUP_TEMPLATE_PATH;
  }

  let type = String(mockupType).toLowerCase().trim();
  if (type === "tasse") type = "mug";

  const base = MOCKUP_TEMPLATE_PATH;
  const match = base.match(/^(.*\/)?mockup-template\.png$/);
  if (match) {
    const prefix = match[1] || "";
    return `${prefix}mockup-template-${type}.png`;
  }

  return `./assets/mockup-template-${type}.png`;
}

async function createMockup({
  jerseyBuffer,
  designBuffer,
  mockupType,
  customMockupUrl,
  designScale,
  designPosX,
  designPosY
}) {
  let baseBuffer;
  let mockupSource = "jersey";

  // 1) Custom URL -> MUSS genommen werden (und bei Fehler: hard fail)
  if (isNonEmptyString(customMockupUrl)) {
    mockupSource = "customUrl";
    baseBuffer = await downloadImageAsPngBuffer(customMockupUrl, "customMockupUrl");
  }
  // 2) Template
  else if (USE_MOCKUP_TEMPLATE) {
    mockupSource = "template";
    const chosenTemplatePath = resolveMockupTemplatePath(mockupType);
    try {
      baseBuffer = await fs.readFile(chosenTemplatePath);
      baseBuffer = await sharp(baseBuffer).png().toBuffer();
    } catch (err) {
      console.error(
        "[Mockup] Template nicht ladbar (" + chosenTemplatePath + "), fallback auf Kunden-Trikot:",
        err
      );
      mockupSource = "jersey";
      baseBuffer = await sharp(jerseyBuffer).png().toBuffer();
    }
  }
  // 3) Jersey
  else {
    mockupSource = "jersey";
    baseBuffer = await sharp(jerseyBuffer).png().toBuffer();
  }

  console.log("[Mockup] Source:", mockupSource, "mockupType:", mockupType || "");

  const baseMeta = await sharp(baseBuffer).metadata();
  const baseWidth = baseMeta.width || 1024;
  const baseHeight = baseMeta.height || 1024;

  const effectiveScale = isNonEmptyString(String(designScale ?? ""))
    ? parseFloat(designScale)
    : DESIGN_SCALE;

  const effectivePosX = isNonEmptyString(String(designPosX ?? ""))
    ? parseFloat(designPosX)
    : DESIGN_POSITION_X;

  const effectivePosY = isNonEmptyString(String(designPosY ?? ""))
    ? parseFloat(designPosY)
    : DESIGN_POSITION_Y;

  const designWidth = Math.round(baseWidth * effectiveScale);

  const designResizedBuffer = await sharp(designBuffer)
    .resize({ width: designWidth })
    .png()
    .toBuffer();

  const designMeta = await sharp(designResizedBuffer).metadata();
  const designHeight = designMeta.height || Math.round(designWidth);

  const centerX = baseWidth / 2;
  const centerY = baseHeight / 2;

  const offsetX = effectivePosX * (baseWidth / 2);
  const offsetY = effectivePosY * (baseHeight / 2);

  const left = Math.round(centerX - designWidth / 2 + offsetX);
  const top = Math.round(centerY - designHeight / 2 + offsetY);

  const mockupBuffer = await sharp(baseBuffer)
    .composite([
      {
        input: designResizedBuffer,
        left,
        top,
        blend: "over"
      }
    ])
    .png()
    .toBuffer();

  return mockupBuffer;
}

// =========================================================
// Optional: Mockup als Produktbild in Shopify anfügen

async function attachMockupToShopifyProduct({ productId, mockupUrl }) {
  if (!ENABLE_SHOPIFY_PRODUCT_IMAGE_UPDATE) return;
  if (!SHOPIFY_ADMIN_ACCESS_TOKEN || !SHOPIFY_STORE_DOMAIN) {
    console.warn(
      "[Shopify] Admin-Access-Token oder Store Domain nicht gesetzt. Produktbild wird nicht aktualisiert."
    );
    return;
  }
  if (!productId || !mockupUrl) {
    console.warn("[Shopify] Kein productId oder mockupUrl übergeben.");
    return;
  }

  const endpoint = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/2025-04/graphql.json`;

  const mutation = `
    mutation productCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
      productCreateMedia(productId: $productId, media: $media) {
        media {
          ... on MediaImage {
            id
            image {
              url
            }
          }
        }
        mediaUserErrors {
          field
          message
        }
      }
    }
  `;

  const productGid = `gid://shopify/Product/${productId}`;

  const body = JSON.stringify({
    query: mutation,
    variables: {
      productId: productGid,
      media: [
        {
          originalSource: mockupUrl,
          mediaContentType: "IMAGE",
          alt: "AI-generiertes Mockup"
        }
      ]
    }
  });

  const resp = await fetch(endpoint, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": SHOPIFY_ADMIN_ACCESS_TOKEN,
      "Content-Type": "application/json"
    },
    body
  });

  const json = await resp.json();
  if (json.errors) {
    console.error("[Shopify] GraphQL errors:", JSON.stringify(json.errors, null, 2));
  }
  const mediaErrors = json.data?.productCreateMedia?.mediaUserErrors || [];
  if (mediaErrors.length > 0) {
    console.error("[Shopify] mediaUserErrors:", JSON.stringify(mediaErrors, null, 2));
  }
}

// =========================================================
// Express App + CORS

const app = express();

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }
  next();
});

// Healthcheck
app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// Haupt-Route
app.post(
  "/api/tib/generate-simple",
  upload.fields([
    { name: "dogImage", maxCount: 1 },
    { name: "jerseyImage", maxCount: 1 }
  ]),
  async (req, res) => {
    console.log("Request auf /api/tib/generate-simple erhalten");
    try {
      const dogFile = req.files?.dogImage?.[0];
      const jerseyFile = req.files?.jerseyImage?.[0];
      const productId = req.body.productId;
      const variantId = req.body.variantId;

      const mockupType = req.body.mockupType;
      const prompt = req.body.prompt;

      // Frontend Overrides
      const referenceImageUrl = req.body.referenceImageUrl;
      const customMockupUrl = req.body.customMockupUrl;
      const designScale = req.body.designScale;
      const designPosX = req.body.designPosX;
      const designPosY = req.body.designPosY;

      // Debug: zeigt dir in Railway Logs sofort ob es ankommt
      console.log("[REQ] mockupType:", mockupType);
      console.log("[REQ] has referenceImageUrl:", isNonEmptyString(referenceImageUrl), referenceImageUrl ? String(referenceImageUrl).slice(0, 120) : "");
      console.log("[REQ] has customMockupUrl:", isNonEmptyString(customMockupUrl), customMockupUrl ? String(customMockupUrl).slice(0, 120) : "");
      console.log("[REQ] placement:", { designScale, designPosX, designPosY });

      if (!dogFile || !jerseyFile) {
        return res.status(400).json({
          error: "dogImage und jerseyImage sind Pflicht."
        });
      }

      // 1) KI-Design erzeugen
      const designBuffer = await generateDesignWithOpenAI({
        dogBuffer: dogFile.buffer,
        jerseyBuffer: jerseyFile.buffer,
        promptOverride: prompt,
        referenceImageUrl
      });

      // 2) Mockup erzeugen (customUrl > template > jersey)
      const mockupBuffer = await createMockup({
        jerseyBuffer: jerseyFile.buffer,
        designBuffer,
        mockupType,
        customMockupUrl,
        designScale,
        designPosX,
        designPosY
      });

      // Geschenk-Mockup (Tasse)
      const giftMockupBuffer = await createMockup({
        jerseyBuffer: jerseyFile.buffer,
        designBuffer,
        mockupType: "tasse",
        customMockupUrl: "", // bewusst kein Override fürs Geschenk
        designScale,
        designPosX,
        designPosY
      });

      // 3) Upload zu R2
      const timestamp = Date.now();
      const designFilename = `design-${productId || "no-product"}-${timestamp}.png`;
      const mockupFilename = `mockup-${productId || "no-product"}-${timestamp}.png`;
      const giftMockupFilename = `gift-mockup-${productId || "no-product"}-${timestamp}.png`;

      const designUrl = await uploadBufferAndGetUrl(designBuffer, designFilename, "image/png");
      const mockupUrl = await uploadBufferAndGetUrl(mockupBuffer, mockupFilename, "image/png");
      const giftMockupUrl = await uploadBufferAndGetUrl(giftMockupBuffer, giftMockupFilename, "image/png");

      console.log("Erfolgreich generiert:", {
        designUrl,
        mockupUrl,
        giftMockupUrl,
        mockupType,
        referenceImageUrl: !!referenceImageUrl,
        customMockupUrl: !!customMockupUrl
      });

      res.json({
        designUrl,
        mockupUrl,
        giftMockupUrl,
        productId,
        variantId
      });
    } catch (err) {
      console.error("Fehler in /api/tib/generate-simple:", err);

      // Wenn URL gesetzt war und Download/Decode scheitert -> lieber 400 statt “interner Fehler”
      const msg = String(err?.message || err);
      const isClientInputIssue =
        msg.includes("Referenzbild-URL") ||
        msg.includes("[referenceImageUrl]") ||
        msg.includes("[customMockupUrl]") ||
        msg.includes("URL nicht ladbar") ||
        msg.includes("nicht dekodiert");

      res.status(isClientInputIssue ? 400 : 500).json({
        error: isClientInputIssue ? "Ungültige Bild-URL / Bildformat." : "Interner Fehler beim Generieren.",
        details: process.env.NODE_ENV === "development" ? msg : undefined
      });
    }
  }
);

app.listen(PORT, () => {
  console.log(`TIB Simple Design Backend läuft auf Port ${PORT}`);
});
