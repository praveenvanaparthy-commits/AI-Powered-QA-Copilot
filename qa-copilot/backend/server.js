const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Serve frontend static files (for production - serve both from one Render service)
const frontendPath = path.join(__dirname, '../frontend');
if (fs.existsSync(frontendPath)) {
  app.use(express.static(frontendPath));
}

// ─── File Upload (memory storage, no disk needed on free tier) ────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB max
  fileFilter: (req, file, cb) => {
    const allowed = ['.pdf', '.txt', '.md', '.json', '.docx', '.csv'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error('File type not supported. Use PDF, TXT, MD, JSON, CSV, DOCX'));
  }
});

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    message: 'QA Copilot API is running',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    apiKeyConfigured: !!process.env.ANTHROPIC_API_KEY
  });
});

// ─── Main Generate Endpoint ──────────────────────────────────────────────────
app.post('/api/generate', upload.array('files', 5), async (req, res) => {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return res.status(500).json({
        error: 'ANTHROPIC_API_KEY not configured on server. Add it in Render → Environment.'
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
        } else if (ext === '.pdf' || ext === '.docx') {
          // For PDF/DOCX on free tier: extract as base64 hint
          fileTexts.push(`[File: ${file.originalname} - ${(file.size/1024).toFixed(1)}KB uploaded, binary format]`);
        }
      }
    }

    const { text = '', options = [], framework = 'selenium', testFormat = 'Gherkin (BDD)' } = req.body;
    const parsedOptions = typeof options === 'string' ? JSON.parse(options) : options;

    const combined = [text, ...fileTexts].filter(Boolean).join('\n\n---\n\n');

    if (!combined.trim()) {
      return res.status(400).json({ error: 'No input provided. Upload a file or paste text.' });
    }

    const prompt = buildPrompt(combined, parsedOptions, framework, testFormat);

    // Call Anthropic API
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4000,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      const errData = await response.json();
      return res.status(response.status).json({
        error: errData.error?.message || 'Anthropic API error'
      });
    }

    const data = await response.json();
    const rawText = data.content.map(c => c.text || '').join('');

    // Parse JSON from response
    let cleaned = rawText.replace(/```json|```/g, '').trim();
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start > -1 && end > -1) cleaned = cleaned.substring(start, end + 1);

    const parsed = JSON.parse(cleaned);

    return res.json({
      success: true,
      data: parsed,
      meta: {
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

// ─── Export Endpoints ─────────────────────────────────────────────────────────

// Export as CSV
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

// Export as Markdown
app.post('/api/export/markdown', (req, res) => {
  try {
    const { testcases = [], edge = [] } = req.body;
    let md = '# QA Test Plan\n\nGenerated by QA Copilot\n\n---\n\n## Test Cases\n\n';
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

// Export Postman Collection
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

// ─── Catch-all → serve frontend index.html ────────────────────────────────────
app.get('*', (req, res) => {
  const indexPath = path.join(__dirname, '../frontend/index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.json({ message: 'QA Copilot API running. Frontend not found in /frontend folder.' });
  }
});

// ─── Prompt Builder ──────────────────────────────────────────────────────────
function buildPrompt(combined, options, framework, testFormat) {
  return `You are a senior QA engineer. Analyze the following requirements and generate comprehensive QA assets.

REQUIREMENTS:
${combined.substring(0, 6000)}

OPTIONS TO GENERATE: ${options.join(', ')}
TEST FRAMEWORK: ${framework}
TEST FORMAT: ${testFormat}

Return a JSON object ONLY (no markdown, no preamble, no backticks) with this exact structure:
{
  "testcases": [
    {
      "id": "TC001",
      "title": "Test case title",
      "module": "Module name",
      "priority": "High|Medium|Low",
      "type": "Functional|Regression|Smoke|E2E",
      "preconditions": "Prerequisites",
      "steps": ["Step 1", "Step 2", "Step 3"],
      "expected": "Expected result",
      "tags": ["tag1", "tag2"]
    }
  ],
  "testdata": [
    {
      "scenario": "Scenario name",
      "valid": [{"field": "value"}],
      "invalid": [{"field": "value", "reason": "why invalid"}],
      "boundary": [{"field": "value", "note": "boundary condition"}]
    }
  ],
  "edge": [
    {
      "category": "Boundary|Security|Performance|UX|Network|Data",
      "title": "Edge case title",
      "description": "What to test",
      "risk": "High|Medium|Low",
      "mitigation": "How to handle"
    }
  ],
  "api": [
    {
      "method": "GET|POST|PUT|DELETE|PATCH",
      "endpoint": "/api/endpoint",
      "description": "What this tests",
      "headers": {"Content-Type": "application/json"},
      "body": {},
      "assertions": ["Status 200", "Response has id field"]
    }
  ],
  "automation": "// Full ${framework} automation skeleton script with all test methods stubbed out and comments"
}

Generate 8-12 test cases, 3-4 test data scenarios, 6-8 edge cases, 4-6 API tests. Make them realistic and specific to the provided requirements.`;
}

// ─── Start Server ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ QA Copilot backend running on port ${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/api/health`);
  console.log(`   API Key configured: ${!!process.env.ANTHROPIC_API_KEY}`);
});
