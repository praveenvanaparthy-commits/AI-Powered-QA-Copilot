# QA Copilot — AI-Powered QA Assistant

## Project Structure
```
qa-copilot/
├── backend/          ← Node.js + Express (deployed to Render)
│   ├── server.js
│   ├── package.json
│   └── .env.example
├── frontend/         ← Static HTML (served by backend)
│   └── index.html
├── render.yaml       ← Render.com deploy config
└── README.md
```

## Local Development

### 1. Clone your repo
```bash
git clone https://github.com/praveenvanaparthy-commits/AI-Powered-QA-Copilot
cd AI-Powered-QA-Copilot
```

### 2. Setup backend
```bash
cd backend
npm install
cp .env.example .env
# Edit .env and add your ANTHROPIC_API_KEY
```

### 3. Run locally
```bash
node server.js
# Open http://localhost:3001 in browser
```

## Deploy to Render (Free)

1. Push this code to GitHub
2. Go to https://render.com → New → Web Service
3. Connect your GitHub repo: `AI-Powered-QA-Copilot`
4. Settings:
   - **Root Directory**: `backend`
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
5. Add Environment Variable:
   - Key: `ANTHROPIC_API_KEY`
   - Value: `sk-ant-api03-your-key-here`
6. Click **Deploy** — you'll get a URL like `https://qa-copilot.onrender.com`

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/health` | Health check |
| POST | `/api/generate` | Generate QA assets (multipart/form-data) |
| POST | `/api/export/csv` | Export test cases as CSV |
| POST | `/api/export/markdown` | Export as Markdown |
| POST | `/api/export/postman` | Export Postman collection |

## Notes
- The frontend (`index.html`) is served automatically by the backend
- API key is stored only on the server — never exposed to frontend
- Free Render tier may sleep after 15min inactivity (first request takes ~30s to wake)
