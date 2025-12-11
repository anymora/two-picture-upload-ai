// server.mjs

// ================== KONFIGURATION (OBEN) ==================

import dotenv from 'dotenv';
dotenv.config();

// ---- OpenAI / KI ----
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'DEIN_OPENAI_API_KEY_HIER';

// Referenzbild für die KI (z.B. Layout-Beispiel)
const REFERENCE_IMAGE_PATH = process.env.REFERENCE_IMAGE_PATH || './assets/reference.png';

// Prompt / Beschreibung für die KI
const BASE_PROMPT =
  process.env.BASE_PROMPT ||
  'Erstelle ein professionelles Fußballtrikot-Design mit dem Hundemotiv. ' +
    'Das Design soll druckfertig sein, ohne Hintergrund, nur das flache Trikot-Design.';

// ---- Mockup / Overlay ----
const MOCKUP_TEMPLATE_PATH =
  process.env.MOCKUP_TEMPLATE_PATH || './assets/mockup-template.png';

// Wenn true: als Basis fürs Mockup wird die MOCKUP_TEMPLATE_PATH-Datei verwendet.
// Wenn false: als Basis wird das hochgeladene Trikotbild des Kunden verwendet.
const USE_MOCKUP_TEMPLATE = process.env.USE_MOCKUP_TEMPLATE === 'false' ? false : true;

// Skalierung des Designs relativ zur Breite des Mockups (0.0 - 1.0)
const DESIGN_SCALE = parseFloat(process.env.DESIGN_SCALE || '0.6');

// Position des Designs relativ zur Bildmitte:
// X: -1 = ganz links, 0 = mittig, 1 = ganz rechts
// Y: -1 = ganz oben, 0 = mittig, 1 = ganz unten
const DESIGN_POSITION_X = parseFloat(process.env.DESIGN_POSITION_X || '0.0');
const DESIGN_POSITION_Y = parseFloat(process.env.DESIGN_POSITION_Y || '-0.1');

// ---- Shopify ----
const SHOPIFY_STORE_DOMAIN =
  process.env.SHOPIFY_STORE_DOMAIN || 'dein-shop.myshopify.com';

// Das ist dein Admin Access Token aus der Custom App
const SHOPIFY_ADMIN_ACCESS_TOKEN =
  process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || 'shpat_XXX';

// Ob das Mockup-Bild automatisch als Produktbild an Shopify gehängt werden soll
const ENABLE_SHOPIFY_PRODUCT_IMAGE_UPDATE =
  process.env.ENABLE_SHOPIFY_PRODUCT_IMAGE_UPDATE === 'true';

// ---- Generelles ----
const PORT = process.env.PORT || 3000;

// =========================================================

import express from 'express';
import multer from 'multer';
import sharp from 'sharp';
import fs from 'fs/promises';
import fetch from 'node-fetch';
import FormData from 'form-data';

// Multer: Dateien im RAM
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10 MB
});

// TODO: Hier musst du deinen Storage anbinden (S3, R2, eigenes CDN, …)
async function uploadBufferAndGetUrl(buffer, filename, mimeType = 'image/png') {
  // HIER DEINEN EIGENEN UPLOAD-CODE EINBAUEN!
  // z.B. AWS S3 putObject, Cloudflare R2 etc.
  // Am Ende MUSS eine öffentlich erreichbare HTTPS-URL zurückkommen.
  throw new Error('uploadBufferAndGetUrl ist noch nicht implementiert. Bitte an deinen Storage anbinden.');
}

// OpenAI: aus Hund + Trikot + Referenz-Bild ein Design erzeugen
async function generateDesignWithOpenAI({ dogBuffer, jerseyBuffer }) {
  if (!OPENAI_API_KEY || OPENAI_API_KEY === 'DEIN_OPENAI_API_KEY_HIER') {
    throw new Error('OPENAI_API_KEY ist nicht gesetzt.');
  }

  const referenceBuffer = await fs.readFile(REFERENCE_IMAGE_PATH).catch((err) => {
    console.error('Fehler beim Laden des Referenzbilds:', err);
    throw new Error('REFERENZBILD konnte nicht geladen werden. Pfad prüfen.');
  });

  const formData = new FormData();
  formData.append('model', 'gpt-image-1');
  formData.append('prompt', BASE_PROMPT);

  // Mehrere input images: Hund, Trikot, Referenz
  formData.append('image[]', dogBuffer, {
    filename: 'dog.png',
    contentType: 'image/png'
  });
  formData.append('image[]', jerseyBuffer, {
    filename: 'jersey.png',
    contentType: 'image/png'
  });
  formData.append('image[]', referenceBuffer, {
    filename: 'reference.png',
    contentType: 'image/png'
  });

  formData.append('size', '1024x1024');
  formData.append('output_format', 'png');
  formData.append('n', '1');

  const response = await fetch('https://api.openai.com/v1/images/edits', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`
    },
    body: formData
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    console.error('OpenAI-Fehler:', response.status, text);
    throw new Error('OpenAI API Request fehlgeschlagen.');
  }

  const json = await response.json();

  const b64 = json?.data?.[0]?.b64_json;
  if (!b64) {
    console.error('OpenAI Antwort ohne b64_json:', JSON.stringify(json, null, 2));
    throw new Error('OpenAI hat kein Bild zurückgegeben.');
  }

  const designBuffer = Buffer.from(b64, 'base64');
  return designBuffer;
}

// Mockup-Erstellung mit konfigurierbarer Skalierung und Position
async function createMockup({ jerseyBuffer, designBuffer }) {
  // Basis-Bild (entweder Mockup-Vorlage oder Kunden-Trikot)
  let baseBuffer;

  if (USE_MOCKUP_TEMPLATE) {
    baseBuffer = await fs.readFile(MOCKUP_TEMPLATE_PATH).catch((err) => {
      console.error('Fehler beim Laden der Mockup-Vorlage, fallback auf Kunden-Trikot:', err);
      return jerseyBuffer;
    });
  } else {
    baseBuffer = jerseyBuffer;
  }

  const baseMeta = await sharp(baseBuffer).metadata();
  const baseWidth = baseMeta.width || 1024;
  const baseHeight = baseMeta.height || 1024;

  const designWidth = Math.round(baseWidth * DESIGN_SCALE);

  const designResizedBuffer = await sharp(designBuffer)
    .resize({ width: designWidth })
    .png()
    .toBuffer();

  const designMeta = await sharp(designResizedBuffer).metadata();
  const designHeight = designMeta.height || Math.round(designWidth);

  const centerX = baseWidth / 2;
  const centerY = baseHeight / 2;

  const offsetX = DESIGN_POSITION_X * (baseWidth / 2);
  const offsetY = DESIGN_POSITION_Y * (baseHeight / 2);

  const left = Math.round(centerX - designWidth / 2 + offsetX);
  const top = Math.round(centerY - designHeight / 2 + offsetY);

  const mockupBuffer = await sharp(baseBuffer)
    .composite([
      {
        input: designResizedBuffer,
        left,
        top,
        blend: 'over'
      }
    ])
    .png()
    .toBuffer();

  return mockupBuffer;
}

// Optional: Mockup als Produktbild in Shopify anfügen
async function attachMockupToShopifyProduct({ productId, mockupUrl }) {
  if (!ENABLE_SHOPIFY_PRODUCT_IMAGE_UPDATE) return;
  if (!SHOPIFY_ADMIN_ACCESS_TOKEN || !SHOPIFY_STORE_DOMAIN) {
    console.warn(
      '[Shopify] Admin-Access-Token oder Store Domain nicht gesetzt. Produktbild wird nicht aktualisiert.'
    );
    return;
  }
  if (!productId || !mockupUrl) {
    console.warn('[Shopify] Kein productId oder mockupUrl übergeben.');
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
          mediaContentType: 'IMAGE',
          alt: 'AI-generiertes Mockup'
        }
      ]
    }
  });

  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'X-Shopify-Access-Token': SHOPIFY_ADMIN_ACCESS_TOKEN,
      'Content-Type': 'application/json'
    },
    body
  });

  const json = await resp.json();
  if (json.errors) {
    console.error('[Shopify] GraphQL errors:', JSON.stringify(json.errors, null, 2));
  }
  const mediaErrors = json.data?.productCreateMedia?.mediaUserErrors || [];
  if (mediaErrors.length > 0) {
    console.error('[Shopify] mediaUserErrors:', JSON.stringify(mediaErrors, null, 2));
  }
}

// Express App
const app = express();

// Healthcheck
app.get('/health', (req, res) => {
  res.json({ ok: true });
});

/**
 * Route: POST /api/tib/generate-simple
 * Multipart-Formdata:
 * - dogImage
 * - jerseyImage
 * - productId (optional, numerische ID von Shopify)
 * - variantId (optional, falls du sie später brauchst)
 */
app.post(
  '/api/tib/generate-simple',
  upload.fields([
    { name: 'dogImage', maxCount: 1 },
    { name: 'jerseyImage', maxCount: 1 }
  ]),
  async (req, res) => {
    try {
      const dogFile = req.files?.dogImage?.[0];
      const jerseyFile = req.files?.jerseyImage?.[0];
      const productId = req.body.productId;
      const variantId = req.body.variantId;

      if (!dogFile || !jerseyFile) {
        return res.status(400).json({
          error: 'dogImage und jerseyImage sind Pflicht.'
        });
      }

      // 1) Design erzeugen
      const designBuffer = await generateDesignWithOpenAI({
        dogBuffer: dogFile.buffer,
        jerseyBuffer: jerseyFile.buffer
      });

      // 2) Mockup erzeugen
      const mockupBuffer = await createMockup({
        jerseyBuffer: jerseyFile.buffer,
        designBuffer
      });

      // 3) Beides hochladen (DEINE Implementierung in uploadBufferAndGetUrl)
      const timestamp = Date.now();
      const designFilename = `design-${productId || 'no-product'}-${timestamp}.png`;
      const mockupFilename = `mockup-${productId || 'no-product'}-${timestamp}.png`;

      const designUrl = await uploadBufferAndGetUrl(designBuffer, designFilename, 'image/png');
      const mockupUrl = await uploadBufferAndGetUrl(mockupBuffer, mockupFilename, 'image/png');

      // 4) Optional: Mockup als Produktbild in Shopify anfügen
      try {
        await attachMockupToShopifyProduct({ productId, mockupUrl });
      } catch (shopifyErr) {
        console.error('Fehler bei attachMockupToShopifyProduct:', shopifyErr);
      }

      // 5) Antwort ans Frontend (für Line Item Properties)
      res.json({
        designUrl,
        mockupUrl,
        productId,
        variantId
      });
    } catch (err) {
      console.error('Fehler in /api/tib/generate-simple:', err);
      res.status(500).json({
        error: 'Interner Fehler beim Generieren.',
        details: process.env.NODE_ENV === 'development' ? String(err) : undefined
      });
    }
  }
);

app.listen(PORT, () => {
  console.log(`TIB Simple Design Backend läuft auf Port ${PORT}`);
});
