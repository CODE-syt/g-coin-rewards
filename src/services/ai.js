'use strict';

// Thin provider adapters over fetch. API keys live in environment variables and are only ever
// attached server-side; request bodies are never logged.
const { config } = require('../config');

class AiUnavailableError extends Error {}

async function postJson(url, headers, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), config.chatbot.timeoutMs);
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: ctrl.signal });
    if (!res.ok) throw new AiUnavailableError(`AI provider responded with HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    if (err instanceof AiUnavailableError) throw err;
    throw new AiUnavailableError(err.name === 'AbortError' ? 'AI provider timed out' : 'AI provider unreachable');
  } finally {
    clearTimeout(timer);
  }
}

const adapters = {
  async anthropic({ system, messages }) {
    const base = config.chatbot.baseUrl || 'https://api.anthropic.com';
    const data = await postJson(`${base}/v1/messages`, { 'x-api-key': config.chatbot.apiKey, 'anthropic-version': '2023-06-01' }, {
      model: config.chatbot.model,
      max_tokens: 600,
      temperature: 0.2,
      system,
      messages,
    });
    return (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  },

  // Works for OpenAI and any OpenAI-compatible endpoint (set AI_BASE_URL), e.g. OpenRouter, Groq, Ollama.
  async openai({ system, messages }) {
    const base = config.chatbot.baseUrl || 'https://api.openai.com/v1';
    const data = await postJson(`${base}/chat/completions`, { authorization: `Bearer ${config.chatbot.apiKey}` }, {
      model: config.chatbot.model,
      max_tokens: 600,
      temperature: 0.2,
      messages: [{ role: 'system', content: system }, ...messages],
    });
    return data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : '';
  },

  async gemini({ system, messages }) {
    const base = config.chatbot.baseUrl || 'https://generativelanguage.googleapis.com/v1beta';
    const data = await postJson(`${base}/models/${encodeURIComponent(config.chatbot.model)}:generateContent`, { 'x-goog-api-key': config.chatbot.apiKey }, {
      systemInstruction: { parts: [{ text: system }] },
      contents: messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
      generationConfig: { maxOutputTokens: 600, temperature: 0.2 },
    });
    const parts = data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
    return (parts || []).map((p) => p.text || '').join('\n');
  },
};

const isConfigured = () => Boolean(config.chatbot.apiKey);

async function generate(args) {
  if (!isConfigured()) throw new AiUnavailableError('AI provider is not configured');
  const text = await adapters[config.chatbot.provider](args);
  if (!text || !text.trim()) throw new AiUnavailableError('Empty AI response');
  return text;
}

module.exports = { generate, isConfigured, AiUnavailableError };
