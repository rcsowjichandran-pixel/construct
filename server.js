const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');

const ROOT = __dirname;
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT) || 3000;
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
const MAX_BODY_BYTES = 200_000;
const MAX_HISTORY_MESSAGES = 20;
const MAX_TEXT_LENGTH = 8_000;
const LOCAL_PREVIEW_ORIGINS = new Set([
  'http://localhost:5500',
  'http://127.0.0.1:5500'
]);
const ALLOWED_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/services.html', ['services.html', 'text/html; charset=utf-8']],
  ['/contact.html', ['contact.html', 'text/html; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']]
]);

function sendJson(response, statusCode, data) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  response.end(JSON.stringify(data));
}

async function loadLocalApiKey() {
  if (process.env.GEMINI_API_KEY) return;

  let contents;
  try {
    contents = await fs.readFile(path.join(ROOT, '.env'), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }

  const match = /^\s*GEMINI_API_KEY\s*=\s*(.*?)\s*$/m.exec(contents);
  if (match) {
    process.env.GEMINI_API_KEY = match[1].replace(/^(["'])(.*)\1$/, '$2');
  }
}

async function readJson(request) {
  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error('Request body is too large.');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('Request body must be valid JSON.');
    error.statusCode = 400;
    throw error;
  }
}

function validateRequest(body) {
  if (!body || typeof body.prompt !== 'string' || !body.prompt.trim()) {
    return 'Enter a message before sending.';
  }
  if (body.prompt.length > MAX_TEXT_LENGTH) {
    return `Messages must be ${MAX_TEXT_LENGTH} characters or fewer.`;
  }

  const history = body.history ?? [];
  if (!Array.isArray(history) || history.length > MAX_HISTORY_MESSAGES) {
    return 'Chat history is invalid. Start a new conversation and try again.';
  }
  for (const message of history) {
    if (
      !message ||
      !['user', 'model'].includes(message.role) ||
      typeof message.text !== 'string' ||
      message.text.length > MAX_TEXT_LENGTH
    ) {
      return 'Chat history is invalid. Start a new conversation and try again.';
    }
  }
  return null;
}

async function generateResponse(body, apiKey) {
  const contents = (body.history ?? []).map((message) => ({
    role: message.role,
    parts: [{ text: message.text }]
  }));
  contents.push({ role: 'user', parts: [{ text: body.prompt.trim() }] });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  try {
    let response;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(MODEL)}:generateContent?key=${encodeURIComponent(apiKey)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents }),
          signal: controller.signal
        }
      );
      if (response.status !== 503 || attempt === 1) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    if (!response.ok) {
      if (response.status === 429) {
        return { statusCode: 503, error: 'The Gemini API quota is exhausted. Check the API key’s plan and billing, or wait for the quota to reset.' };
      }
      if (response.status === 503) {
        return { statusCode: 503, error: 'The AI service is temporarily busy. Please try again shortly.' };
      }
      if (response.status === 400 || response.status === 403 || response.status === 404) {
        return { statusCode: 502, error: 'The AI service rejected its server configuration. Check the API key and model settings.' };
      }
      return { statusCode: 502, error: 'The AI service is temporarily unavailable. Please try again later.' };
    }

    const result = await response.json();
    const text = result.candidates?.[0]?.content?.parts
      ?.map((part) => typeof part.text === 'string' ? part.text : '')
      .join('')
      .trim();

    if (!text) {
      return { statusCode: 502, error: 'The AI service returned an empty response. Please try again.' };
    }
    return { statusCode: 200, text };
  } catch (error) {
    if (error.name === 'AbortError') {
      return { statusCode: 504, error: 'The AI service took too long to respond. Please try again.' };
    }
    console.error('Gemini API request failed.');
    return { statusCode: 502, error: 'Unable to reach the AI service. Check the server connection and try again.' };
  } finally {
    clearTimeout(timeout);
  }
}

async function handleRequest(request, response) {
  const requestUrl = new URL(request.url, `http://${request.headers.host || 'localhost'}`);

  if (requestUrl.pathname === '/api/generate') {
    const origin = request.headers.origin;
    if (origin && !LOCAL_PREVIEW_ORIGINS.has(origin)) {
      return sendJson(response, 403, { error: 'This origin is not allowed to use the local chatbot API.' });
    }

    if (origin) {
      response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Vary', 'Origin');
    }

    if (request.method === 'OPTIONS') {
      response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      return response.writeHead(204).end();
    }

    if (request.method !== 'POST') {
      response.setHeader('Allow', 'POST');
      return sendJson(response, 405, { error: 'Use POST to send a chat message.' });
    }

    let body;
    try {
      body = await readJson(request);
    } catch (error) {
      return sendJson(response, error.statusCode || 400, { error: error.message });
    }

    const validationError = validateRequest(body);
    if (validationError) {
      return sendJson(response, 400, { error: validationError });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return sendJson(response, 503, {
        error: 'Chatbot is not configured. Set GEMINI_API_KEY on the server, then restart it.'
      });
    }

    const result = await generateResponse(body, apiKey);
    return sendJson(response, result.statusCode, result.statusCode === 200
      ? { text: result.text }
      : { error: result.error });
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.setHeader('Allow', 'GET, HEAD');
    return sendJson(response, 405, { error: 'Method not allowed.' });
  }

  const file = ALLOWED_FILES.get(requestUrl.pathname);
  if (!file) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return response.end('Not found.');
  }

  try {
    const contents = await fs.readFile(path.join(ROOT, file[0]));
    response.writeHead(200, {
      'Content-Type': file[1],
      'X-Content-Type-Options': 'nosniff'
    });
    response.end(request.method === 'HEAD' ? undefined : contents);
  } catch (error) {
    console.error(`Unable to serve ${file[0]}:`, error.message);
    response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Unable to load this page.');
  }
}

const server = http.createServer((request, response) => {
  handleRequest(request, response).catch((error) => {
    console.error('Request failed:', error.message);
    if (!response.headersSent) {
      sendJson(response, 500, { error: 'The server could not complete the request.' });
    } else {
      response.destroy();
    }
  });
});

loadLocalApiKey()
  .then(() => {
    server.listen(PORT, HOST, () => {
      console.log(`DreamBuild is available at http://${HOST}:${PORT}`);
      if (!process.env.GEMINI_API_KEY) {
        console.warn('GEMINI_API_KEY is not set; the chatbot will return a configuration error.');
      }
    });
  })
  .catch((error) => {
    console.error('Unable to load local API-key configuration:', error.message);
    process.exitCode = 1;
  });
