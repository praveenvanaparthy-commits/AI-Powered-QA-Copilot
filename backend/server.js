const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

// ─── Gemini API Config ────────────────────────────────────────────────────────
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL   = 'gemini-pro-vision';   // try vision model for free-tier compatibility
const GEMINI_URL     = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Serve frontend static files (single Render service serves both)
const frontendPath = path.join(__dirname, '../frontend');
if (fs.existsSync(frontendPath)) {
  app.use(express.static(frontendPath));
}

// ─── File Upload (memory storage — no disk needed on free Render tier) ────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.pdf', '.txt', '.md', '.json', '.docx', '.csv'];
    const ext = path.extname(file.originalname).toLowerCase();
    allowed.includes(ext) ? cb(null, true) : cb(new Error('Unsupported file type'));
  }
});

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    message: 'QA Copilot API is running (Gemini Free Tier)',
    version: '2.0.0',
    model: GEMINI_MODEL,
    timestamp: new Date().toISOString(),
    apiKeyConfigured: !!GEMINI_API_KEY
  });
});

// ─── Main Generate Endpoint ──────────────────────────────────────────────────
app.post('/api/generate', upload.array('files', 5), async (req, res) => {
  try {
    if (!GEMINI_API_KEY) {
      return res.status(500).json({
        error: 'GEMINI_API_KEY not configured. Add it in Render → Environment Variables.'
      });
    }

    // Extract text from uploaded files
    const fileTexts = [];
    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        const ext = path.extname(file.originalname).toLowerCase();
        if (['.txt', '.md', '.json', '.csv'].includes(ext)) {
          const text = file.buffer.toString('utf-8').substring(0, 4000);
          fileTexts.push(`[File: ${file.originalname}]\n${text}`);
        } else {
          fileTexts.push(`[File: ${file.originalname} uploaded — ${(file.size / 1024).toFixed(1)}KB]`);
        }
      }
    }

    const {
      text = '',
      options = [],
      framework = 'selenium',
      testFormat = 'Gherkin (BDD)'
    } = req.body;

    const parsedOptions = typeof options === 'string' ? JSON.parse(options) : options;
    const combined = [text, ...fileTexts].filter(Boolean).join('\n\n---\n\n');

    if (!combined.trim()) {
      return res.status(400).json({ error: 'No input provided. Upload a file or paste text.' });
    }

    const prompt = buildPrompt(combined, parsedOptions, framework, testFormat);

    // ── Call Gemini API ──────────────────────────────────────────────────────
    const geminiResponse = await fetch(GEMINI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.4,
          maxOutputTokens: 8192,
          responseMimeType: 'application/json'   // forces Gemini to return pure JSON
        }
      })
    });

    if (!geminiResponse.ok) {
      const errData = await geminiResponse.json();
      const msg = errData?.error?.message || 'Gemini API error';
      return res.status(geminiResponse.status).json({ error: msg });
    }

    const geminiData = await geminiResponse.json();

    // Extract text from Gemini response
    const rawText = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    if (!rawText) {
      return res.status(500).json({ error: 'Empty response from Gemini. Try again.' });
    }

    // Parse JSON (clean markdown fences if present)
    let cleaned = rawText.replace(/```json|```/g, '').trim();
    const start = cleaned.indexOf('{');
    const end   = cleaned.lastIndexOf('}');
    if (start > -1 && end > -1) cleaned = cleaned.substring(start, end + 1);

    const parsed = JSON.parse(cleaned);

    return res.json({
      success: true,
      data: parsed,
      meta: {
        model: GEMINI_MODEL,
        inputLength: combined.length,
        framework,
        testFormat,
        filesProcessed: req.files?.length || 0,
        generatedAt: new Date().toISOString()
      }
    });

  } catch (err) {
    console.error('Generate error:', err.message);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

// ─── Export: CSV ─────────────────────────────────────────────────────────────
app.post('/api/export/csv', (req, res) => {
  try {
    const { testcases = [] } = req.body;
    const headers = ['ID', 'Title', 'Module', 'Priority', 'Type', 'Preconditions', 'Steps', 'Expected'];
    const rows = testcases.map(tc => [
      tc.id || '', tc.title || '', tc.module || '', tc.priority || '',
      tc.type || '', tc.preconditions || '',
      (tc.steps || []).join(' | '), tc.expected || ''
    ]);
    const csv = [headers, ...rows]
      .map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(','))
      .join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="test_cases.csv"');
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Export: Markdown ─────────────────────────────────────────────────────────
app.post('/api/export/markdown', (req, res) => {
  try {
    const { testcases = [], edge = [] } = req.body;
    let md = '# QA Test Plan\n\nGenerated by QA Copilot (Gemini)\n\n---\n\n## Test Cases\n\n';
    testcases.forEach(tc => {
      md += `### ${tc.id}: ${tc.title}\n- **Priority**: ${tc.priority}\n- **Type**: ${tc.type}\n- **Module**: ${tc.module}\n\n**Steps:**\n${(tc.steps || []).map((s, i) => `${i + 1}. ${s}`).join('\n')}\n\n**Expected:** ${tc.expected}\n\n---\n\n`;
    });
    md += '\n## Edge Cases\n\n';
    edge.forEach(e => {
      md += `### ${e.title} (${e.risk} Risk)\n**Category:** ${e.category}\n\n${e.description}\n\n**Mitigation:** ${e.mitigation || 'N/A'}\n\n`;
    });
    res.setHeader('Content-Type', 'text/markdown');
    res.setHeader('Content-Disposition', 'attachment; filename="test_plan.md"');
    res.send(md);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Export: Postman Collection ───────────────────────────────────────────────
app.post('/api/export/postman', (req, res) => {
  try {
    const { api = [] } = req.body;
    const collection = {
      info: {
        name: 'QA Copilot API Tests',
        schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'
      },
      item: api.map(endpoint => ({
        name: endpoint.description || endpoint.endpoint,
        request: {
          method: endpoint.method,
          header: [{ key: 'Content-Type', value: 'application/json', type: 'text' }],
          url: {
            raw: '{{base_url}}' + endpoint.endpoint,
            host: ['{{base_url}}'],
            path: (endpoint.endpoint || '').split('/').filter(Boolean)
          },
          body: endpoint.body && Object.keys(endpoint.body).length ? {
            mode: 'raw',
            raw: JSON.stringify(endpoint.body, null, 2),
            options: { raw: { language: 'json' } }
          } : undefined
        }
      }))
    };
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename="postman_collection.json"');
    res.json(collection);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Catch-all → serve frontend ───────────────────────────────────────────────
app.get('*', (req, res) => {
  const indexPath = path.join(__dirname, '../frontend/index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.json({ message: 'QA Copilot API running. Place index.html in /frontend folder.' });
  }
});

// ─── Prompt Builder ───────────────────────────────────────────────────────────
function buildPrompt(combined, options, framework, testFormat) {
  return `You are a senior QA engineer. Analyze the requirements below and generate comprehensive QA assets.

REQUIREMENTS:
${combined.substring(0, 6000)}

OPTIONS TO GENERATE: ${options.join(', ')}
TEST FRAMEWORK: ${framework}
TEST FORMAT: ${testFormat}

Return ONLY a valid JSON object with NO explanation, NO markdown, NO backticks. Use this exact structure:
{
  "testcases": [
    {
      "id": "TC001",
      "title": "Test case title",
      "module": "Module name",
      "priority": "High",
      "type": "Functional",
      "preconditions": "User is logged in",
      "steps": ["Step 1", "Step 2", "Step 3"],
      "expected": "Expected result",
      "tags": ["smoke", "login"]
    }
  ],
  "testdata": [
    {
      "scenario": "Scenario name",
      "valid": [{"field": "value"}],
      "invalid": [{"field": "value", "reason": "why invalid"}],
      "boundary": [{"field": "value", "note": "boundary note"}]
    }
  ],
  "edge": [
    {
      "category": "Security",
      "title": "Edge case title",
      "description": "What to test and how",
      "risk": "High",
      "mitigation": "How to handle this"
    }
  ],
  "api": [
    {
      "method": "POST",
      "endpoint": "/api/login",
      "description": "Test successful login",
      "headers": {"Content-Type": "application/json"},
      "body": {"username": "test@test.com", "password": "Test@123"},
      "assertions": ["Status 200", "Response contains token"]
    }
  ],
  "automation": "// ${framework} automation skeleton\n// Add your full script here with all test stubs"
}

Rules:
- Generate 8-12 testcases, 3-4 testdata, 6-8 edge cases, 4-6 api tests
- priority must be exactly: High, Medium, or Low
- risk must be exactly: High, Medium, or Low
- method must be: GET, POST, PUT, DELETE, or PATCH
- Make everything specific and realistic based on the actual requirements provided`;
}

// ─── Start ────────────────────────────────────────────────────────────────────
try {
  app.listen(PORT, () => {
    console.log(`\n✅  QA Copilot backend running → http://localhost:${PORT}`);
    console.log(`    Model  : ${GEMINI_MODEL} (Google Gemini Free Tier)`);
    console.log(`    Health : http://localhost:${PORT}/api/health`);
    console.log(`    API Key: ${GEMINI_API_KEY ? '✓ configured' : '✗ MISSING — set GEMINI_API_KEY in .env'}\n`);
  });
} catch (err) {
  console.error('❌ Failed to start server:', err);
  process.exit(1);
}