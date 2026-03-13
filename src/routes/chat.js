const express = require('express');
const { handleChat } = require('../services/geminiChat');

const router = express.Router();

router.post('/', async (req, res) => {
  try {
    const { messages } = req.body;
    if (!Array.isArray(messages)) {
      return res.status(400).json({ error: 'messages array required' });
    }
    const result = await handleChat(messages);
    res.json(result);
  } catch (err) {
    console.error('Chat error:', err);
    const status = err.code === 'GEMINI_API_KEY_MISSING' ? 503 : 500;
    res.status(status).json({
      error: err.message || 'Chat failed',
      code: err.code,
    });
  }
});

module.exports = router;
