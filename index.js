// ─────────────────────────────────────────────
//  RESTAURANT BRAIN — Main Server
//  AI-powered operations brain for restaurants
// ─────────────────────────────────────────────

require('dotenv').config();
const express    = require('express');
const Anthropic  = require('@anthropic-ai/sdk');
const multer     = require('multer');
const fs         = require('fs');
const path       = require('path');

const app    = express();
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const DATA_DIR    = '/data';
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const KB_FILE     = path.join(DATA_DIR, 'knowledge.json');
const LOG_FILE    = path.join(DATA_DIR, 'interactions.jsonl');

for (const dir of [DATA_DIR, UPLOADS_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOADS_DIR,
    filename: (req, file, cb) => {
      cb(null, `${Date.now()}-${file.originalname}`);
    }
  })
});

app.use(express.json());
app.use(express.static('public'));

// ── KNOWLEDGE BASE ────────────────────────────
// Stores all uploaded document text in memory
// In production this moves to a vector database
let knowledgeBase = [];

// Load any previously saved knowledge on startup
if (fs.existsSync(KB_FILE)) {
  try {
    knowledgeBase = JSON.parse(fs.readFileSync(KB_FILE, 'utf8'));
    console.log(`[Brain] Loaded ${knowledgeBase.length} documents from knowledge base`);
  } catch(e) {
    console.log('[Brain] Starting with empty knowledge base');
  }
}

function saveKnowledge() {
  fs.writeFileSync(KB_FILE, JSON.stringify(knowledgeBase, null, 2));
}

const EXTRACT_PROMPT =
  'Extract all text content from this file. Return only the extracted text, preserving structure and formatting where possible. Do not add commentary or markdown wrappers.';

const IMAGE_MEDIA_TYPES = {
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.webp': 'image/webp'
};

async function extractTextWithClaude(filePath, originalname) {
  const ext    = path.extname(originalname).toLowerCase();
  const buffer = fs.readFileSync(filePath);
  const base64 = buffer.toString('base64');

  let userContent;

  if (ext === '.pdf') {
    userContent = [
      {
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: base64 }
      },
      { type: 'text', text: EXTRACT_PROMPT }
    ];
  } else if (IMAGE_MEDIA_TYPES[ext]) {
    userContent = [
      {
        type: 'image',
        source: { type: 'base64', media_type: IMAGE_MEDIA_TYPES[ext], data: base64 }
      },
      { type: 'text', text: EXTRACT_PROMPT }
    ];
  } else if (['.txt', '.csv', '.md', '.json'].includes(ext)) {
    return buffer.toString('utf8').trim();
  } else if (ext === '.docx' || ext === '.doc') {
    const mammoth = require('mammoth');
    const result  = await mammoth.extractRawText({ path: filePath });
    return result.value.trim();
  } else {
    const asText = buffer.toString('utf8');
    if (asText && !/\ufffd/.test(asText)) {
      return asText.trim();
    }
    throw new Error(`Unsupported file type: ${ext || 'unknown'}`);
  }

  const message = await client.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: 8192,
    messages:   [{ role: 'user', content: userContent }]
  });

  return message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
    .trim();
}

// ── DOCUMENT UPLOAD ───────────────────────────
app.post('/api/upload', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.json({ success: false, error: 'No file uploaded' });
  }

  try {
    const text = await extractTextWithClaude(req.file.path, req.file.originalname);

    if (!text.trim()) {
      return res.json({ success: false, error: 'Could not extract text from file' });
    }

    // Add to knowledge base
    const doc = {
      id:       Date.now(),
      filename: req.file.originalname,
      text:     text.trim(),
      addedAt:  new Date().toISOString()
    };

    knowledgeBase.push(doc);
    saveKnowledge();

    console.log(`[Brain] Added document: ${req.file.originalname} (${text.length} chars)`);
    res.json({ success: true, filename: req.file.originalname, chars: text.length });

  } catch(err) {
    console.error('[Brain] Upload error:', err.message);
    res.json({ success: false, error: err.message });
  }
});

// ── ASK THE BRAIN ─────────────────────────────
app.post('/api/ask', async (req, res) => {
  const { question, role = 'crew', language = 'english' } = req.body;

  if (!question) {
    return res.json({ success: false, error: 'No question provided' });
  }

  try {
    // Build context from knowledge base
    const context = knowledgeBase.length > 0
      ? knowledgeBase.map(d => `=== ${d.filename} ===\n${d.text}`).join('\n\n')
      : 'No documents have been uploaded yet.';

    // Role-based system prompt
    const roleInstructions = {
      crew:             'You are helping a crew member (line cook, prep cook, dishwasher, or front of house staff). Answer practical, operational questions. Keep answers clear and simple.',
      manager:          'You are helping a manager. You can discuss refund decisions, staffing, and operational decisions.',
      catering_manager: 'You are helping a catering manager. You can discuss catering pricing, event prep, client communication, and logistics.',
      owner:            'You are helping the restaurant owner. You have full access to all information including financials, food costs, labor, and strategic decisions.'
    };

    const languageInstruction = language === 'spanish'
      ? 'Respond in Spanish.'
      : 'Respond in English.';

    const systemPrompt = `You are Restaurant Brain — the AI operations intelligence for this restaurant company. You know everything about how this business operates.

${roleInstructions[role] || roleInstructions.crew}

${languageInstruction}

IMPORTANT RULES:
- Only answer based on the restaurant's documents below. Do not make up policies or prices.
- If you don't know the answer from the documents, say so clearly and suggest who to ask.
- Be concise and practical. Staff are busy. Get to the point.
- For refund questions, always specify the exact steps for the platform (Toast, Grubhub, UberEats, DoorDash).
- For recipe/prep questions, be precise with quantities, temperatures, and timing.

RESTAURANT KNOWLEDGE BASE:
${context}`;

    const message = await client.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 1024,
      system:     systemPrompt,
      messages:   [{ role: 'user', content: question }]
    });

    const answer = message.content[0].text;

    // Log the interaction
    const log = {
      timestamp: new Date().toISOString(),
      role,
      language,
      question,
      answer,
      answered: !answer.includes("don't have") && !answer.includes("not in the documents")
    };

    // Append to log file
    fs.appendFileSync(LOG_FILE, JSON.stringify(log) + '\n');

    console.log(`[Brain] Q (${role}/${language}): ${question.slice(0, 60)}...`);

    res.json({ success: true, answer });

  } catch(err) {
    console.error('[Brain] Ask error:', err.message);
    res.json({ success: false, error: err.message });
  }
});

// ── KNOWLEDGE BASE STATUS ─────────────────────
app.get('/api/knowledge', (req, res) => {
  res.json({
    documentCount: knowledgeBase.length,
    documents: knowledgeBase.map(d => ({
      id:       d.id,
      filename: d.filename,
      chars:    d.text.length,
      addedAt:  d.addedAt
    }))
  });
});

// ── DELETE DOCUMENT ───────────────────────────
app.delete('/api/knowledge/:id', (req, res) => {
  const id = parseInt(req.params.id);
  knowledgeBase = knowledgeBase.filter(d => d.id !== id);
  saveKnowledge();
  res.json({ success: true });
});

// ── GAPS REPORT ───────────────────────────────
// Shows questions the Brain couldn't answer
app.get('/api/gaps', (req, res) => {
  if (!fs.existsSync(LOG_FILE)) return res.json({ gaps: [] });

  const lines = fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').filter(Boolean);
  const gaps  = lines
    .map(l => { try { return JSON.parse(l); } catch(e) { return null; } })
    .filter(l => l && !l.answered)
    .map(l => ({ timestamp: l.timestamp, role: l.role, question: l.question }));

  res.json({ gaps, total: gaps.length });
});

// ── START SERVER ──────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`
┌──────────────────────────────────────┐
│       RESTAURANT BRAIN               │
│  http://localhost:${PORT}               │
│  ${knowledgeBase.length} documents loaded          │
└──────────────────────────────────────┘
  `);
});
