require('dotenv').config();
const express = require('express');
const cors = require('cors');
const chatRouter = require('./routes/chat');

const app = express();
const PORT = process.env.PORT || 3000;

if (!process.env.GEMINI_API_KEY?.trim()) {
  console.warn('Warning: GEMINI_API_KEY is not set. Copy .env.example to .env and add your key. Chat will return 503 until then.');
}

app.use(cors({ origin: true }));
app.use(express.json());

app.use('/api/chat', chatRouter);

app.get('/health', (_, res) => res.json({ status: 'ok' }));

// Local development
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(`Sales Closer API running on http://localhost:${PORT}`);
  });
}

// Export for Vercel serverless
module.exports = app;
